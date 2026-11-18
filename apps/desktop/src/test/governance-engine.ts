import path from 'node:path';
import {
  AccessTokenManager,
  AuditLog,
  DEFAULT_CONFIG,
  DeployEngine,
  MemoryTokenStore,
  SnapshotStore,
  type ApprovalPresenter,
  type ApprovalPresentation,
  type ContrailConfig,
  type ContrailDb,
  type PolicyConfig,
} from '@contrail/engine';

/**
 * S46 (B): a REAL DeployEngine over a test database, for the app suites whose
 * org-facing engine calls are stubs. Deploy Review's change record and the
 * freeze break-glass run through the engine's own governanceState and
 * reviewGovernance — the policy gates are the code under test, never a
 * fake — while each suite still replaces executeDeploy & co. on the returned
 * instance with its faithful stubs (Object.assign).
 *
 * The policies come from the config handed in (the engine's default policy
 * source), so a test changes them by mutating `config.policies`, or swaps
 * the source outright with engine.setPolicySource.
 */

/** A presenter that never presents — these suites never mint through the engine. */
class NoPresenter implements ApprovalPresenter {
  readonly mode = 'native' as const;
  present(): Promise<ApprovalPresentation> {
    return Promise.resolve({ url: null, opened: false, mode: 'native' });
  }
  close(): void {}
}

export function governanceEngine(
  db: ContrailDb,
  dir: string,
  policies?: PolicyConfig,
): { engine: DeployEngine; audit: AuditLog; config: ContrailConfig } {
  const config: ContrailConfig = structuredClone({
    ...DEFAULT_CONFIG,
    policies: policies ?? DEFAULT_CONFIG.policies,
  });
  const audit = new AuditLog(db);
  const engine = new DeployEngine(
    db,
    new SnapshotStore(path.join(dir, 'snapshots')),
    new AccessTokenManager(db, new MemoryTokenStore(), config),
    config,
    audit,
    new NoPresenter(),
    { deploysDir: path.join(dir, 'deploys') },
  );
  return { engine, audit, config };
}

/** The window every freeze case uses: in effect at any instant a test can run. */
export const ALWAYS_WINDOW = {
  name: 'always',
  range: { from: '2000-01-01T00:00', to: '2999-01-01T00:00' },
  timeZone: 'UTC',
};

/** A freeze on every connection whose label matches `pattern` (e.g. 'acme-*'). */
export function freezeOn(pattern: string, rule = 'acme freeze'): PolicyConfig {
  return { rules: [{ name: rule, match: { connections: [pattern] }, freezeWindows: [ALWAYS_WINDOW] }] };
}
