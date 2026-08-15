import {
  createEngineDeps,
  dataDir,
  probeBetterSqlite3,
  probeKeyring,
  type EngineDeps,
} from '@contrail/engine';
import type { HealthView } from '@contrail/shared';
import { openBrowserViaShell } from './services/connections.js';

/**
 * Main-process bootstrap: verify the two native modules load under Electron's
 * ABI (both are N-API, so this should always pass — but the check is a hard
 * gate, not an assumption), open the shared Contrail database, and wire the
 * engine's dependency container.
 *
 * The data dir is the SAME one the Contrail plugin uses (%LOCALAPPDATA%\
 * Contrail on Windows) — connections, snapshots, and audit history carry
 * over, and the frozen v5 plugin keeps working beside us (schema changes are
 * additive-only; see the freeze contract in @contrail/engine core/db.ts).
 */

export interface Bootstrap {
  deps: EngineDeps;
  health: HealthView;
}

export function bootstrap(
  appVersion: string,
  overrides?: { snapshotWork?: import('@contrail/engine').SnapshotWorkUnits },
): Bootstrap {
  const sqlite = probeBetterSqlite3();
  const keyring = probeKeyring();
  if (!sqlite.ok || !keyring.ok) {
    // Hard fail with a diagnosable message — risk register item #2.
    throw new Error(
      `Native module verification failed under Electron ` +
        `(better-sqlite3: ${sqlite.detail}; keyring: ${keyring.detail}). ` +
        `This build cannot run — report this with the exact Electron version.`,
    );
  }

  // Electron owns the browser opener; everything else is production wiring.
  const deps = createEngineDeps({
    flowOps: { openBrowser: openBrowserViaShell },
    snapshotWork: overrides?.snapshotWork,
  });
  const schemaVersion = deps.db.schemaVersion();
  const connectionCount = deps.db.listConnections().length;

  const health: HealthView = {
    ok: true,
    appVersion,
    dataDir: dataDir(),
    schemaVersion,
    nativeModules: { betterSqlite3: sqlite, keyring },
    connectionCount,
  };
  return { deps, health };
}
