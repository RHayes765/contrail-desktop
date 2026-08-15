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

const HEADLESS = SMOKE || AGENT_DEMO !== null;

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

app.whenReady().then(async () => {
  try {
    boot = bootstrap(app.getVersion());
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

  // ── windowed app ───────────────────────────────────────────────────────

  const push = <C extends PushChannel>(channel: C, payload: PushEvents[C]): void => {
    const contents = mainWindow?.webContents;
    if (contents && !contents.isDestroyed()) contents.send(channel, payload);
  };

  const projects = new ProjectService(boot.deps);
  const connections = new ConnectionService(boot.deps, (reason) =>
    push('connections:changed', { reason }),
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
