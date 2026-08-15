import { app, BrowserWindow, Notification, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { log } from '@contrail/engine';
import type { ChatEvent, PushChannel, PushEvents } from '@contrail/shared';
import { bootstrap, type Bootstrap } from './bootstrap.js';
import { registerHandlers } from './ipc/registry.js';
import { makeHandlers, type MainServices } from './ipc/handlers.js';
import { ConnectionService } from './services/connections.js';
import { ProjectService } from './services/projects.js';
import { AgentSessionManager, type SessionAlert } from './services/agentRuntime.js';
import { SnapshotService, SnapshotWorkerBridge } from './services/snapshots.js';
import { DiffService, MetadataService } from './services/metadata.js';
import { SummaryService } from './services/summaries.js';

/** The snapshot CPU worker bundle (built as a second main entry). */
function snapshotWorkerPath(): string {
  return path.join(import.meta.dirname, 'snapshotWorker.js');
}

// Windows toasts need an AppUserModelID; unpackaged dev builds borrow the
// executable's so notifications display instead of silently dropping.
app.setAppUserModelId(app.isPackaged ? 'com.lanefour.contrail' : process.execPath);

/**
 * Completion alerts, Claude-Desktop style: only when the user is NOT looking
 * at the app (unfocused/minimized), flash the taskbar and raise an OS
 * notification whose click brings Contrail forward. A focused window means
 * the user is watching the reply stream — no alert.
 */
function alertUser(info: SessionAlert): void {
  const win = mainWindow;
  if (!win || win.isDestroyed() || win.isFocused()) return;
  win.flashFrame(true);
  if (!Notification.isSupported()) return;
  const title =
    info.kind === 'done'
      ? `${info.projectName} — reply ready`
      : info.kind === 'error'
        ? `${info.projectName} — session error`
        : `${info.projectName} — session ended`;
  const notification = new Notification({ title, body: info.text, silent: false });
  notification.on('click', () => {
    const w = mainWindow;
    if (!w || w.isDestroyed()) return;
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
    w.flashFrame(false);
  });
  notification.show();
}

/**
 * Contrail desktop — main process. Hardening posture (spec §8), set before
 * anything else and never relaxed:
 *   - context isolation + sandbox on, node integration off
 *   - deny-all navigation and window.open
 *   - single instance
 *   - typed, zod-validated IPC only (see ipc/registry.ts)
 * Salesforce tokens live in main-process memory + OS keychain only; nothing
 * token-bearing crosses IPC.
 */

const SMOKE = process.argv.includes('--smoke');
const smokeOutArg = process.argv.find((a) => a.startsWith('--smoke-out='));
const SMOKE_OUT = smokeOutArg ? smokeOutArg.slice('--smoke-out='.length) : null;
const agentDemoArg = process.argv.find((a) => a.startsWith('--agent-demo='));
const AGENT_DEMO = agentDemoArg ? agentDemoArg.slice('--agent-demo='.length) : null;
const snapshotDemoArg = process.argv.find((a) => a.startsWith('--snapshot-demo='));
const SNAPSHOT_DEMO = snapshotDemoArg ? snapshotDemoArg.slice('--snapshot-demo='.length) : null;
const diffDemoArg = process.argv.find((a) => a.startsWith('--diff-demo='));
const DIFF_DEMO = diffDemoArg ? diffDemoArg.slice('--diff-demo='.length) : null;
const summarizeDemoArg = process.argv.find((a) => a.startsWith('--summarize-demo='));
const SUMMARIZE_DEMO = summarizeDemoArg
  ? summarizeDemoArg.slice('--summarize-demo='.length)
  : null;
const narrateDemoArg = process.argv.find((a) => a.startsWith('--narrate-demo='));
const NARRATE_DEMO = narrateDemoArg ? narrateDemoArg.slice('--narrate-demo='.length) : null;

const HEADLESS =
  SMOKE ||
  AGENT_DEMO !== null ||
  SNAPSHOT_DEMO !== null ||
  DIFF_DEMO !== null ||
  SUMMARIZE_DEMO !== null ||
  NARRATE_DEMO !== null;

function smokeWrite(payload: unknown): void {
  const text = JSON.stringify(payload, null, 2) + '\n';
  if (SMOKE_OUT) fs.writeFileSync(SMOKE_OUT, text);
  else process.stdout.write(text);
}

if (HEADLESS) {
  // Headless modes must never block on a native error dialog (Windows Electron
  // detaches from the console, so a dialog is a silent hang for the caller).
  process.on('uncaughtException', (err) => {
    smokeWrite({ ok: false, error: `uncaught: ${String(err)}` });
    app.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    smokeWrite({ ok: false, error: `unhandled rejection: ${String(reason)}` });
    app.exit(1);
  });
}

// Single instance — a second launch focuses the first window instead.
if (!HEADLESS && !app.requestSingleInstanceLock()) {
  app.quit();
}

let boot: Bootstrap | null = null;
let mainWindow: BrowserWindow | null = null;
let sessionManager: AgentSessionManager | null = null;
let workerBridge: SnapshotWorkerBridge | null = null;

/** Where the runtime child bundle lives (dev layout; packaging revisits this). */
function runtimeChildPath(): string {
  return path.join(
    app.getAppPath(),
    '..',
    '..',
    'packages',
    'agent-runtime',
    'dist',
    'child.js',
  );
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#101418',
    webPreferences: {
      preload: path.join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  });

  // Deny-all navigation: the renderer is our app, full stop. External links
  // (e.g. a Salesforce record URL) open in the system browser.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('http://localhost') && !url.startsWith('file://')) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  // Coming back to the app clears any completion flash.
  mainWindow.on('focus', () => mainWindow?.flashFrame(false));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(path.join(import.meta.dirname, '../renderer/index.html'));
  }
}

// ── the Session 4 live demo (headless spec demo, budget-capped) ──────────

/**
 * Proves the whole Session 4 stack without a window: a REAL multi-turn chat
 * session on the Dev Sandbox project that (1) reads a seeded project doc via
 * read_project_doc and (2) answers a SOQL question against dev-org — the two
 * halves of the spec demo the Chat UI will drive.
 */
async function runAgentDemo(b: Bootstrap, question: string): Promise<void> {
  const projects = new ProjectService(b.deps);
  const devOrg = b.deps.db.resolveConnection('dev-org');
  if (!devOrg) throw new Error('dev-org connection not found in shared DB');

  const project =
    b.deps.db.findProjectByName('Dev Sandbox') ??
    b.deps.db.createProject({
      name: 'Dev Sandbox',
      description: 'Default development project (auto-created by the agent demo).',
    });
  b.deps.db.removeProjectBinding(project.id, devOrg.id);
  b.deps.db.addProjectBinding(project.id, devOrg.id, 'dev');

  // Seed a doc the agent has to actually read to answer turn 1.
  const scratchDoc = path.join(app.getPath('temp'), 'contrail-demo-conventions.md');
  fs.writeFileSync(
    scratchDoc,
    [
      '# Dev Sandbox conventions',
      '',
      '- Naming: all custom fields use the `LF4_` prefix.',
      '- The integration user for this project is `integration@lanefour.dev`.',
      '- Deploy window: weekdays after 4pm Eastern only.',
      '',
    ].join('\n'),
  );
  projects.addDocFromPath(project.id, scratchDoc);

  // Capture pushes instead of a renderer; resolve turn boundaries on 'done'.
  const events: Array<{ sessionId: string; event: ChatEvent }> = [];
  let turnResolve: (() => void) | null = null;
  const push = <C extends PushChannel>(channel: C, payload: PushEvents[C]): void => {
    if (channel === 'session:event') {
      const p = payload as PushEvents['session:event'];
      events.push(p);
      if (p.event.type === 'done' && turnResolve) {
        const r = turnResolve;
        turnResolve = null;
        r();
      }
    }
  };

  const manager = new AgentSessionManager(b.deps, projects, runtimeChildPath(), push);
  sessionManager = manager;

  const view = manager.start(project.id);
  const waitTurn = (timeoutMs: number): Promise<void> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('turn timed out')), timeoutMs);
      turnResolve = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  const turn1 = waitTurn(120_000);
  manager.send(
    view.id,
    'Check the project docs for our naming convention for custom fields and answer with just the prefix.',
  );
  await turn1;

  const turn2 = waitTurn(120_000);
  manager.send(view.id, question);
  await turn2;

  const inspection = manager.inspect(view.id);
  await manager.end(view.id);
  const turnTexts = events
    .filter((e) => e.event.type === 'text')
    .map((e) => (e.event as { text: string }).text);
  events.length = 0;

  // The resume leg: the runtime process is DEAD — bring the session back and
  // ask about something only the earlier conversation contains.
  const resumedView = manager.resume(view.id);
  const turn3 = waitTurn(120_000);
  manager.send(
    resumedView.id,
    'Earlier in this conversation I asked two questions. Answer again, with just the number, ' +
      'the count you found for the second one.',
  );
  await turn3;
  const resumedTexts = events
    .filter((e) => e.event.type === 'text')
    .map((e) => (e.event as { text: string }).text);
  await manager.end(view.id);

  const row = b.deps.db.getAgentSession(view.id);
  smokeWrite({
    ok: true,
    session_id: view.id,
    turn_texts: turnTexts,
    resumed_texts: resumedTexts,
    resume_recalled_answer: resumedTexts.some((t) => t.includes('13')),
    capability_calls: inspection?.capabilityCalls ?? [],
    usage: row
      ? {
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          cacheReadTokens: row.cacheReadTokens,
          costUsd: row.costUsd,
        }
      : null,
    row_status: row?.status,
    sdk_session_captured: row?.sdkSessionId != null,
    transcript_path: row?.transcriptPath,
  });
}

/**
 * Session 5 demo: a REAL snapshot sync of dev-org through the worker seam
 * (live Salesforce retrieve), then a chat session answering a dependency
 * question FROM THE LOCAL GRAPH (get_dependencies — no further org reads
 * required for the answer's structure).
 */
async function runSnapshotDemo(b: Bootstrap, question: string): Promise<void> {
  const devOrg = b.deps.db.resolveConnection('dev-org');
  if (!devOrg) throw new Error('dev-org connection not found in shared DB');

  const progressLines: string[] = [];
  const events: Array<{ sessionId: string; event: ChatEvent }> = [];
  let syncResolve: ((error: string | null) => void) | null = null;
  let turnResolve: (() => void) | null = null;
  const push = <C extends PushChannel>(channel: C, payload: PushEvents[C]): void => {
    if (channel === 'metadata:progress') {
      const p = payload as PushEvents['metadata:progress'];
      progressLines.push(p.progress);
      if (p.done && syncResolve) {
        const r = syncResolve;
        syncResolve = null;
        r(p.error);
      }
    } else if (channel === 'session:event') {
      const p = payload as PushEvents['session:event'];
      events.push(p);
      if (p.event.type === 'done' && turnResolve) {
        const r = turnResolve;
        turnResolve = null;
        r();
      }
    }
  };

  const snapshots = new SnapshotService(b.deps, push);
  const syncDone = new Promise<string | null>((resolve, reject) => {
    syncResolve = resolve;
    setTimeout(() => reject(new Error('sync timed out after 10 minutes')), 10 * 60 * 1000);
  });
  const started = snapshots.sync(devOrg.id, 'refresh');
  if (started.status !== 'started') throw new Error(`sync did not start: ${started.status}`);
  const syncError = await syncDone;
  if (syncError) throw new Error(`sync failed: ${syncError}`);
  const status = snapshots.status(devOrg.id);

  // Now the agent leg: dependency question from the local graph.
  const projects = new ProjectService(b.deps);
  const project =
    b.deps.db.findProjectByName('Dev Sandbox') ??
    b.deps.db.createProject({ name: 'Dev Sandbox' });
  b.deps.db.removeProjectBinding(project.id, devOrg.id);
  b.deps.db.addProjectBinding(project.id, devOrg.id, 'dev');

  const manager = new AgentSessionManager(b.deps, projects, runtimeChildPath(), push);
  sessionManager = manager;
  const view = manager.start(project.id);
  const turn = new Promise<void>((resolve, reject) => {
    turnResolve = resolve;
    setTimeout(() => reject(new Error('agent turn timed out')), 120_000);
  });
  manager.send(view.id, question);
  await turn;
  const inspection = manager.inspect(view.id);
  await manager.end(view.id);

  smokeWrite({
    ok: true,
    sync: {
      progress_lines: progressLines,
      artifact_count: status.artifactCount,
      edge_count: status.edgeCount,
      last_indexed_at: status.lastIndexedAt,
    },
    agent: {
      final_texts: events
        .filter((e) => e.event.type === 'text')
        .map((e) => (e.event as { text: string }).text),
      capability_calls: inspection?.capabilityCalls ?? [],
      usage: inspection?.usage ?? null,
    },
  });
}

app.whenReady().then(async () => {
  try {
    // The CPU seam is worker-backed in every mode — the demo exercises the
    // same process topology the windowed app uses.
    workerBridge = new SnapshotWorkerBridge(snapshotWorkerPath());
    boot = bootstrap(app.getVersion(), { snapshotWork: workerBridge });
  } catch (err) {
    log('error', 'bootstrap failed', { err: String(err) });
    if (HEADLESS) {
      smokeWrite({ ok: false, error: String(err) });
      app.exit(1);
      return;
    }
    throw err;
  }

  if (SMOKE) {
    // Headless verification: report health + connections and exit.
    const connections = boot.deps.db.listConnections().map((c) => ({
      alias: c.alias,
      org_type: c.orgType,
      org_name: c.orgName,
    }));
    smokeWrite({ health: boot.health, connections });
    app.exit(0);
    return;
  }

  if (AGENT_DEMO) {
    try {
      await runAgentDemo(boot, AGENT_DEMO);
      app.exit(0);
    } catch (err) {
      smokeWrite({ ok: false, error: String(err) });
      app.exit(1);
    }
    return;
  }

  if (NARRATE_DEMO !== null) {
    // The M3 verify: an agent narrating diff_orgs across BOTH bound orgs.
    // The conquest binding is DEMO-ONLY state in the shared Dev Sandbox
    // project — it must be removed afterwards, or every future session's
    // silo silently widens to include a client org.
    let conquestId: string | null = null;
    let projectId: string | null = null;
    const cleanupBinding = (): void => {
      if (projectId && conquestId) {
        try {
          boot?.deps.db.removeProjectBinding(projectId, conquestId);
        } catch {
          /* best effort */
        }
      }
    };
    try {
      if (!NARRATE_DEMO.trim()) throw new Error('--narrate-demo requires a question');
      const projects = new ProjectService(boot.deps);
      const devOrg = boot.deps.db.resolveConnection('dev-org');
      const conquest = boot.deps.db.resolveConnection('conquest-full');
      if (!devOrg || !conquest) throw new Error('need dev-org and conquest-full connections');
      const project =
        boot.deps.db.findProjectByName('Dev Sandbox') ??
        boot.deps.db.createProject({ name: 'Dev Sandbox' });
      projectId = project.id;
      conquestId = conquest.id;
      boot.deps.db.removeProjectBinding(project.id, devOrg.id);
      boot.deps.db.addProjectBinding(project.id, devOrg.id, 'dev');
      boot.deps.db.removeProjectBinding(project.id, conquest.id);
      boot.deps.db.addProjectBinding(project.id, conquest.id, 'other');

      const events: Array<{ sessionId: string; event: ChatEvent }> = [];
      const errors: string[] = [];
      let turnResolve: (() => void) | null = null;
      const push = <C extends PushChannel>(channel: C, payload: PushEvents[C]): void => {
        if (channel === 'session:event') {
          const p = payload as PushEvents['session:event'];
          events.push(p);
          if (p.event.type === 'error') errors.push(p.event.message);
          if (p.event.type === 'session_ended') errors.push(`session ended: ${p.event.reason}`);
          if ((p.event.type === 'done' || p.event.type === 'session_ended') && turnResolve) {
            const r = turnResolve;
            turnResolve = null;
            r();
          }
        }
      };
      const manager = new AgentSessionManager(boot.deps, projects, runtimeChildPath(), push);
      sessionManager = manager;
      const view = manager.start(project.id);
      const turn = new Promise<void>((resolve, reject) => {
        turnResolve = resolve;
        setTimeout(() => reject(new Error('narration turn timed out')), 180_000);
      });
      manager.send(view.id, NARRATE_DEMO);
      await turn;
      const inspection = manager.inspect(view.id);
      await manager.end(view.id);
      cleanupBinding();
      const narration = events
        .filter((e) => e.event.type === 'text')
        .map((e) => (e.event as { text: string }).text)
        .join('\n');
      const ok = errors.length === 0 && narration.length > 0;
      smokeWrite({
        ok,
        narration,
        errors,
        capability_calls: inspection?.capabilityCalls ?? [],
        usage: inspection?.usage ?? null,
      });
      app.exit(ok ? 0 : 1);
    } catch (err) {
      cleanupBinding();
      smokeWrite({ ok: false, error: String(err) });
      if (sessionManager) await sessionManager.endAll().catch(() => undefined);
      app.exit(1);
    }
    return;
  }

  if (SUMMARIZE_DEMO !== null) {
    // Arg: "alias:Type:ApiName" — one direct Haiku call on local content.
    try {
      const [ref, type, apiName] = SUMMARIZE_DEMO.split(':');
      if (!ref || !type || !apiName) throw new Error('--summarize-demo expects "alias:Type:ApiName"');
      const conn = boot.deps.db.resolveConnection(ref);
      if (!conn) throw new Error(`connection "${ref}" not found`);
      const metadata = new MetadataService(boot.deps);
      const summaries = new SummaryService(boot.deps, metadata);
      const started = Date.now();
      const first = await summaries.summarize(
        conn.id,
        type as 'ApexClass' | 'ApexTrigger' | 'Flow' | 'ValidationRule',
        apiName,
      );
      const second = await summaries.summarize(
        conn.id,
        type as 'ApexClass' | 'ApexTrigger' | 'Flow' | 'ValidationRule',
        apiName,
      );
      smokeWrite({
        ok: true,
        summary: first.summary,
        duration_ms: Date.now() - started,
        second_call_cached: second.cached,
      });
      app.exit(0);
    } catch (err) {
      smokeWrite({ ok: false, error: String(err) });
      app.exit(1);
    }
    return;
  }

  if (DIFF_DEMO !== null) {
    // Cross-org scope diff over LOCAL snapshots — zero Salesforce calls.
    // Arg: "aliasA,aliasB[,Type:ApiName]" (optional explicit drill target).
    try {
      const [refA, refB, target] = DIFF_DEMO.split(',').map((s) => s.trim());
      if (!refA || !refB) throw new Error('--diff-demo expects "aliasA,aliasB[,Type:ApiName]"');
      const connA = boot.deps.db.resolveConnection(refA);
      const connB = boot.deps.db.resolveConnection(refB);
      if (!connA || !connB) throw new Error('both aliases must resolve to connections');
      const diff = new DiffService(
        boot.deps,
        new SnapshotWorkerBridge(snapshotWorkerPath()),
        new MetadataService(boot.deps),
      );
      const started = Date.now();
      const scope = await diff.diffScope(connA.id, connB.id);
      const again = await diff.diffScope(connA.id, connB.id); // cache check
      // Drill-in leg: explicit target when given, else first changed entry.
      let drillType: string | null = null;
      let drillName: string | null = null;
      if (target) {
        const idx = target.indexOf(':');
        drillType = target.slice(0, idx);
        drillName = target.slice(idx + 1);
      } else {
        const firstChanged = scope.entries.find((e) => e.status === 'changed');
        if (firstChanged) {
          drillType = firstChanged.type;
          drillName = firstChanged.apiName;
        }
      }
      const drill =
        drillType && drillName
          ? diff.diffArtifact(connA.id, connB.id, drillType, drillName)
          : null;
      // Diff-aware summary leg for summarizable targets (live Haiku call).
      let diffSummary: string | null = null;
      if (
        drill &&
        ['ApexClass', 'ApexTrigger', 'Flow', 'ValidationRule'].includes(drill.type)
      ) {
        const summaries = new SummaryService(boot.deps, new MetadataService(boot.deps), diff);
        diffSummary = (
          await summaries.summarizeDiff(
            connA.id,
            connB.id,
            drill.type as 'ApexClass' | 'ApexTrigger' | 'Flow' | 'ValidationRule',
            drill.apiName,
          )
        ).summary;
      }
      smokeWrite({
        ok: true,
        aliases: [scope.aliasA, scope.aliasB],
        totals: scope.totals,
        uncovered_types: scope.uncoveredTypes,
        entry_count: scope.entries.length,
        truncated: scope.truncated,
        sample_changed: scope.entries.filter((e) => e.status === 'changed').slice(0, 5),
        duration_ms: Date.now() - started,
        second_call_cached: again.cached,
        drill: drill
          ? {
              artifact: `${drill.type}:${drill.apiName}`,
              format: drill.format,
              change_count: drill.changes?.length ?? drill.hunks?.length ?? 0,
              sample_changes: (drill.changes ?? []).slice(0, 4),
              flow_nodes:
                drill.flowGraphA && drill.flowGraphB
                  ? {
                      a: drill.flowGraphA.nodes.length,
                      b: drill.flowGraphB.nodes.length,
                      changed: drill.flowNodeChanges?.changed.length ?? 0,
                      added_in_b: drill.flowNodeChanges?.addedInB ?? [],
                      removed_in_b: drill.flowNodeChanges?.removedInB ?? [],
                    }
                  : null,
            }
          : null,
        diff_summary: diffSummary,
      });
      app.exit(0);
    } catch (err) {
      smokeWrite({ ok: false, error: String(err) });
      app.exit(1);
    }
    return;
  }

  if (SNAPSHOT_DEMO !== null) {
    try {
      if (!SNAPSHOT_DEMO.trim()) throw new Error('--snapshot-demo requires a question');
      await runSnapshotDemo(boot, SNAPSHOT_DEMO);
      app.exit(0);
    } catch (err) {
      smokeWrite({ ok: false, error: String(err) });
      // A live session may still hold a CLI subprocess — never orphan it.
      if (sessionManager) await sessionManager.endAll().catch(() => undefined);
      app.exit(1);
    }
    return;
  }

  // ── windowed app ───────────────────────────────────────────────────────

  const push = <C extends PushChannel>(channel: C, payload: PushEvents[C]): void => {
    const contents = mainWindow?.webContents;
    if (contents && !contents.isDestroyed()) contents.send(channel, payload);
  };

  const projects = new ProjectService(boot.deps);
  const snapshots = new SnapshotService(boot.deps, push);
  const metadata = new MetadataService(boot.deps);
  // Diffs get their OWN worker process: the sync pipeline's lane stays free,
  // and a diff timeout can never kill an in-flight snapshot stage.
  const diff = new DiffService(boot.deps, new SnapshotWorkerBridge(snapshotWorkerPath()), metadata);
  const connections = new ConnectionService(
    boot.deps,
    (reason) => push('connections:changed', { reason }),
    // Fresh connects baseline themselves; re-auths skip (artifacts exist).
    (connectionId) => snapshots.maybeAutoBaseline(connectionId),
  );
  sessionManager = new AgentSessionManager(
    boot.deps,
    projects,
    runtimeChildPath(),
    push,
    alertUser,
  );

  const services: MainServices = {
    connections,
    projects,
    sessions: sessionManager,
    snapshots,
    metadata,
    diff,
    summaries: new SummaryService(boot.deps, metadata, diff),
    getWindow: () => mainWindow,
  };

  registerHandlers(boot.deps, makeHandlers(boot.health, services));
  createWindow();

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Close live sessions gracefully on quit — an abrupt exit would orphan the
// SDK's CLI subprocesses (utilityProcess kill does not reap grandchildren).
let quitting = false;
app.on('before-quit', (event) => {
  if (quitting || !sessionManager) return;
  event.preventDefault();
  quitting = true;
  void sessionManager.endAll().finally(() => app.quit());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
