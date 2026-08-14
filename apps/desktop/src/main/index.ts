import { app, BrowserWindow, shell, utilityProcess } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { log } from '@contrail/engine';
import { bootstrap, type Bootstrap } from './bootstrap.js';
import { registerHandlers } from './ipc/registry.js';
import { makeHandlers } from './ipc/handlers.js';

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
const agentSpikeArg = process.argv.find((a) => a.startsWith('--agent-spike='));
const AGENT_SPIKE = agentSpikeArg ? agentSpikeArg.slice('--agent-spike='.length) : null;

function smokeWrite(payload: unknown): void {
  const text = JSON.stringify(payload, null, 2) + '\n';
  if (SMOKE_OUT) fs.writeFileSync(SMOKE_OUT, text);
  else process.stdout.write(text);
}

if (SMOKE || AGENT_SPIKE) {
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
if (!SMOKE && !app.requestSingleInstanceLock()) {
  app.quit();
}

let boot: Bootstrap | null = null;
let mainWindow: BrowserWindow | null = null;

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
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(path.join(import.meta.dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  if (AGENT_SPIKE) {
    // Risk-#1 spike: run the Agent SDK spike script inside a utilityProcess —
    // the exact process topology real sessions will use (main → utilityProcess
    // → claude.exe subprocess) — and mirror its output to the smoke-out file.
    // Watchdogged: on timeout we dump whatever partial output exists instead
    // of hanging the caller.
    const child = utilityProcess.fork(AGENT_SPIKE, [], { stdio: 'pipe' });
    let out = '';
    let spawned = false;
    let finished = false;
    const finish = (payload: Record<string, unknown>, code: number): void => {
      if (finished) return; // watchdog-kill also fires 'exit' — first verdict wins
      finished = true;
      smokeWrite({ child_spawned: spawned, child_output: out, ...payload });
      app.exit(code);
    };
    const watchdog = setTimeout(() => {
      finish({ ok: false, error: 'watchdog: utilityProcess spike exceeded 240s' }, 1);
      child.kill();
    }, 240_000);
    child.on('spawn', () => {
      spawned = true;
    });
    child.stdout?.on('data', (d) => (out += String(d)));
    child.stderr?.on('data', (d) => (out += String(d)));
    child.on('exit', (code) => {
      clearTimeout(watchdog);
      finish({ utility_process_exit_code: code }, code === 0 ? 0 : 1);
    });
    return;
  }

  try {
    boot = bootstrap(app.getVersion());
  } catch (err) {
    log('error', 'bootstrap failed', { err: String(err) });
    if (SMOKE) {
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

  registerHandlers(boot.deps, makeHandlers(boot.health));
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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
