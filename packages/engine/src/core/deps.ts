import { ContrailDb } from './db.js';
import { KeychainTokenStore, type TokenStore } from './keychain.js';
import { AuditLog } from './audit.js';
import { loadConfig, type ContrailConfig } from './config.js';
import { deploysDir } from './paths.js';
import { ConnectFlowManager, type FlowOps } from '../connect/flow.js';
import { AccessTokenManager } from '../salesforce/tokens.js';
import { SnapshotStore } from '../snapshot/store.js';
import { SnapshotEngine } from '../snapshot/engine.js';
import type { SnapshotWorkUnits } from '../snapshot/work.js';
import { DeployEngine } from '../deploy/engine.js';
import type { ApprovalPresenter } from '../deploy/approval.js';
import { createLocalDiagRunner } from '../localdiag/runner.js';
import type { LocalDiagRunner } from '../localdiag/types.js';
import { dataDir } from './paths.js';
import path from 'node:path';

/**
 * The engine's dependency container. Every surface that drives the engine —
 * the desktop app's IPC services, the agent capability executor, tests —
 * receives one of these. (Formerly `ToolDeps` in the Phase 0 MCP server;
 * renamed and moved here so the engine package carries its own DI root.)
 */
export interface EngineDeps {
  db: ContrailDb;
  tokens: TokenStore;
  audit: AuditLog;
  config: ContrailConfig;
  flows: ConnectFlowManager;
  tokenMgr: AccessTokenManager;
  store: SnapshotStore;
  engine: SnapshotEngine;
  deploys: DeployEngine;
  /**
   * check_apex / check_soql. On EngineDeps proper (unlike snapshotWork) so
   * capability handlers can reach it. The ENGINE default has no vendored
   * bundles (vendorDir null → honest "not_installed") — the host injects a
   * real runner: the desktop app wires @contrail/apex-ls's path plus an
   * ELECTRON_RUN_AS_NODE spawn; the plugin repo's twin wires its own
   * vendorDir() (plain node).
   */
  localDiag: LocalDiagRunner;
}

/** Injection seams. Every field optional; defaults reproduce production wiring. */
export interface EngineOverrides {
  db?: ContrailDb;
  tokens?: TokenStore;
  config?: ContrailConfig;
  flowOps?: Partial<FlowOps>;
  store?: SnapshotStore;
  approvals?: ApprovalPresenter;
  deploysDir?: string;
  /** CPU-work seam for the snapshot pipeline (desktop: worker process). */
  snapshotWork?: SnapshotWorkUnits;
  localDiag?: LocalDiagRunner;
}

export function createEngineDeps(overrides?: EngineOverrides): EngineDeps {
  const db = overrides?.db ?? new ContrailDb();
  const tokens = overrides?.tokens ?? new KeychainTokenStore();
  const config = overrides?.config ?? loadConfig();
  const audit = new AuditLog(db);
  const flows = new ConnectFlowManager(db, tokens, audit, config, overrides?.flowOps);
  const tokenMgr = new AccessTokenManager(db, tokens, config);
  const store = overrides?.store ?? new SnapshotStore();
  const engine = new SnapshotEngine(db, store, tokenMgr, config, audit, overrides?.snapshotWork);
  const deploys = new DeployEngine(db, store, tokenMgr, config, audit, overrides?.approvals, {
    deploysDir: overrides?.deploysDir ?? deploysDir(),
  });
  const localDiag =
    overrides?.localDiag ??
    createLocalDiagRunner({
      vendorDir: null, // the host injects the real runner — see EngineDeps.localDiag
      enabled: config.localDiagnostics.enabled,
      timeoutMs: config.localDiagnostics.timeoutMs,
      workspaceRoot: path.join(dataDir(), 'localdiag-workspace'),
    });
  return { db, tokens, audit, config, flows, tokenMgr, store, engine, deploys, localDiag };
}
