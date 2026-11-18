import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ContrailDb } from '../core/db.js';
import { MemoryTokenStore } from '../core/keychain.js';
import { DEFAULT_CONFIG, type ContrailConfig } from '../core/config.js';
import { SnapshotStore } from '../snapshot/store.js';
import { createEngineDeps, type EngineDeps } from '../core/deps.js';
import { emptyGrantSet } from '../core/grants.js';
import { stagingDir } from '../core/paths.js';
import { revertDirFor, writeRevertPreImages, type PreImage } from '../deploy/preimage.js';
import type { ApprovalNotifier, NotifyOutcome } from '../core/notify.js';

/**
 * Desktop-only (the plugin has no startup reconcile, and keeps an
 * 'executing' row's revert dir until it finishes): a deploy that a quit or
 * crash stranded at 'executing' is S45's outcome-unknown case — it MAY have
 * committed. The app's reconcileStrandedExecutions calls
 * DeployEngine.finalizeStrandedRevert BEFORE it flips the row to
 * execution_failed, so the validate-time pre-images get an
 * outcome:'unknown' revert-plan.json and the next validate's revert sweep
 * keeps them like an executed package — instead of removing a plan-less
 * execution_failed dir.
 */

class SilentNotifier implements ApprovalNotifier {
  async notify(): Promise<NotifyOutcome> {
    return { status: 'sent' };
  }
  async sendTest() {
    return { ok: true, message: 'ok' };
  }
  status() {
    return { method: 'pushover' as const, when: 'always' as const, configured: true };
  }
  resetCircuit() {}
}

const FOO_LIVE = 'public class Foo {\n    public static Integer one() { return 0; }\n}\n';
const STARTED_AT = '2026-11-14T15:00:00.000Z';
const RETRIEVED_AT = '2026-11-14T15:00:05.000Z';
const ERR = 'Contrail closed while this deploy was executing; its outcome was not recorded';
const DAY_MS = 24 * 60 * 60 * 1000;

let tmp: string;
let db: ContrailDb;
let config: ContrailConfig;
let deps: EngineDeps;
let connId: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-stranded-'));
  // stagingDir() — and so every sweep — stays under the temp dir.
  process.env.CONTRAIL_DATA_DIR = tmp;
  db = new ContrailDb(path.join(tmp, 'test.db'));
  const grants = emptyGrantSet();
  grants.metadata_read = true;
  grants.metadata_write = true;
  connId = db.insertConnection({
    alias: 'strand-org',
    instanceUrl: 'https://strand.stub.salesforce.com',
    loginUrl: 'https://login.salesforce.com',
    orgId: '00DS',
    orgName: 'strand-org',
    orgType: 'developer',
    isSandbox: false,
    username: null,
    userId: null,
    grants,
  }).id;
  config = { ...DEFAULT_CONFIG, deploy: { ...DEFAULT_CONFIG.deploy } };
  deps = createEngineDeps({
    db,
    tokens: new MemoryTokenStore(),
    config,
    store: new SnapshotStore(path.join(tmp, 'snapshots')),
    notifier: new SilentNotifier(),
  });
});

afterEach(() => {
  db.close();
  delete process.env.CONTRAIL_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const audits = (type: string) => db.queryAuditEvents({}).filter((e) => e.eventType === type);
const planFileOf = (id: string) => path.join(revertDirFor(stagingDir(), id), 'revert-plan.json');

/** The revert sweep a real validate runs before it issues a new code (private). */
function sweep(): void {
  (deps.deploys as unknown as { sweepRevertDirs(): void }).sweepRevertDirs();
}

/**
 * A deploy as validate leaves it when the live check succeeded: pre-images
 * frozen under staging/_reverts/<id> (Foo modified, NewCls added) and
 * live_check + revert_preimages in summaryJson.
 */
function seedValidatedDeploy(
  code: string,
  opts: { liveCheck?: boolean; executeTargetCheck?: Record<string, unknown> } = {},
): string {
  const id = db.insertDeployRequest({
    connectionId: connId,
    kind: 'deploy',
    confirmationCode: code,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    summaryJson: '{}',
  }).id;
  const changes = [
    { type: 'ApexClass', api_name: 'Foo', change: 'modify', warnings: [] },
    { type: 'ApexClass', api_name: 'NewCls', change: 'add', warnings: [] },
  ];
  if (opts.liveCheck === false) {
    db.setDeployRequestSummaryJson(id, JSON.stringify({ changes, destructive: [], blast: [] }));
    return id;
  }
  const dir = revertDirFor(stagingDir(), id);
  const foo: PreImage = {
    present: true,
    source: 'retrieve',
    stamp_source: 'listMetadata',
    content: FOO_LIVE,
    last_modified_date: '2026-11-10T09:30:00.000Z',
    last_modified_by: 'Bob',
    comparable: true,
    restorable: true,
  };
  const newCls: PreImage = {
    present: false,
    source: 'retrieve',
    stamp_source: 'listMetadata',
    last_modified_date: null,
    last_modified_by: null,
    comparable: true,
    restorable: false,
  };
  const written = writeRevertPreImages(dir, [
    { type: 'ApexClass', api_name: 'Foo', image: foo },
    { type: 'ApexClass', api_name: 'NewCls', image: newCls },
  ]);
  db.setDeployRequestSummaryJson(
    id,
    JSON.stringify({
      changes,
      destructive: [],
      blast: [],
      live_check: {
        status: 'ok',
        started_at: STARTED_AT,
        at: RETRIEVED_AT,
        dates_unavailable_types: [],
        members: 2,
      },
      revert_preimages: { dir, ...written },
      // What executeDeploy persists in the claim's synchronous span.
      ...(opts.executeTargetCheck ? { execute_target_check: opts.executeTargetCheck } : {}),
    }),
  );
  return id;
}

describe('finalizeStrandedRevert (desktop startup reconcile)', () => {
  it('finalizes a stranded deploy with outcome:"unknown", and the next sweep keeps it after the flip', () => {
    const id = seedValidatedDeploy('STRA-ND23');
    const dir = revertDirFor(stagingDir(), id);
    expect(db.claimRequestForExecution(id)).toBe(true);

    const fields = deps.deploys.finalizeStrandedRevert(id, ERR);
    expect(fields).toMatchObject({
      revert_package: {
        dir,
        outcome: 'unknown',
        restores: [
          {
            type: 'ApexClass',
            api_name: 'Foo',
            content_file: path.join(dir, 'classes', 'Foo.cls'),
          },
        ],
        deletes: [{ type: 'ApexClass', api_name: 'NewCls' }],
        not_restorable: [],
        plan: path.join(dir, 'revert-plan.json'),
      },
    });
    expect(fields).not.toHaveProperty('revert_note');

    const plan = JSON.parse(fs.readFileSync(path.join(dir, 'revert-plan.json'), 'utf8'));
    expect(plan).toMatchObject({
      request_id: id,
      connection: 'strand-org',
      executed_at: null,
      retrieved_at: RETRIEVED_AT,
      retrieve_started_at: STARTED_AT,
      // No verdict was stored on the row (claimed before the seam) — never invented.
      target_check: null,
      outcome: 'unknown',
    });
    expect(fields).not.toHaveProperty('target_check');
    expect(plan).not.toHaveProperty('deploy_id');
    expect(plan.note).toBe(
      `Contrail lost track of this deploy (${ERR}); check Setup → Deployment Status. If it ` +
        'committed, these files are what the org held when this package was validated.',
    );
    const readme = fs.readFileSync(path.join(dir, 'README.txt'), 'utf8');
    expect(readme).toContain('Before submitting this deploy (whose outcome Contrail lost track of');
    expect(readme).toContain("Contrail did not re-check the org's last-modified stamps");
    expect(readme.trimEnd().endsWith(plan.note)).toBe(true);
    expect((fields!.revert_package as { note: string }).note).toBe(readme.trimEnd());
    expect(audits('deploy.revert_written').map((e) => e.detail)).toEqual([
      expect.objectContaining({ requestId: id, outcome: 'unknown' }),
    ]);
    // No execute_deploy call is running during the startup reconcile.
    expect(audits('deploy.revert_written').map((e) => e.tool)).toEqual(['startup_reconcile']);
    // The code never rides the result fields or the package files.
    expect(JSON.stringify(fields)).not.toContain('STRA-ND23');
    expect(JSON.stringify(plan)).not.toContain('STRA-ND23');
    expect(readme).not.toContain('STRA-ND23');

    // The reconcile's flip, then the sweep a later validate runs: an
    // execution_failed row WITH a plan is kept like an executed one.
    db.finishDeployRequest(id, 'execution_failed', JSON.stringify({ stranded: true, ...fields }));
    sweep();
    expect(fs.existsSync(path.join(dir, 'revert-plan.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'classes', 'Foo.cls'))).toBe(true);
    expect(audits('deploy.revert_swept')).toHaveLength(0);
  });

  it("the guard's verdict persisted at the claim reaches the plan, the README and the result", () => {
    const check = {
      status: 'ok',
      checked_at: '2026-11-14T15:20:00.000Z',
      checked: [{ type: 'ApexClass', api_name: 'Foo' }],
      unchecked: [],
    };
    const id = seedValidatedDeploy('STRA-ND12', { executeTargetCheck: check });
    const dir = revertDirFor(stagingDir(), id);
    db.claimRequestForExecution(id);

    const fields = deps.deploys.finalizeStrandedRevert(id, ERR);
    // Returned so the stranded result_json carries it (the Deploys panel's
    // NOT-re-checked notice reads target_check from there).
    expect(fields?.target_check).toEqual(check);
    const plan = JSON.parse(fs.readFileSync(path.join(dir, 'revert-plan.json'), 'utf8'));
    expect(plan.target_check).toEqual(check);
    expect(plan.outcome).toBe('unknown');
    const readme = fs.readFileSync(path.join(dir, 'README.txt'), 'utf8');
    expect(readme).toContain(
      "Contrail compared the org's last-modified stamps against that retrieve for 1 of 1 " +
        'members and found them unchanged',
    );
    expect(readme).not.toContain('did not re-check');
    expect(readme).not.toContain('target check');
    expect(audits('deploy.revert_written').map((e) => e.tool)).toEqual(['startup_reconcile']);
    for (const text of [JSON.stringify(fields), JSON.stringify(plan), readme]) {
      expect(text).not.toContain('STRA-ND12');
    }
  });

  it("a stored 'unavailable' verdict says the org could not be re-read — never a comparison", () => {
    const check = { status: 'unavailable', reason: 'listMetadata failed: HTTP 500' };
    const id = seedValidatedDeploy('STRA-ND13', { executeTargetCheck: check });
    db.claimRequestForExecution(id);
    const fields = deps.deploys.finalizeStrandedRevert(id, ERR);
    expect(fields?.target_check).toEqual(check);
    const readme = fs.readFileSync(
      path.join(revertDirFor(stagingDir(), id), 'README.txt'),
      'utf8',
    );
    expect(readme).toContain(
      'Contrail could not re-read the org to compare last-modified stamps (listMetadata ' +
        'failed: HTTP 500)',
    );
    expect(readme).not.toContain('found them unchanged');
  });

  it('without it, the same flip loses the pre-images to the sweep (why the reconcile calls it first)', () => {
    const id = seedValidatedDeploy('STRA-ND34');
    const dir = revertDirFor(stagingDir(), id);
    db.claimRequestForExecution(id);
    db.finishDeployRequest(id, 'execution_failed', JSON.stringify({ stranded: true }));
    sweep();
    expect(fs.existsSync(dir)).toBe(false);
    expect(audits('deploy.revert_swept').map((e) => e.detail)).toEqual([
      { requestId: id, reason: 'execution_failed' },
    ]);
  });

  it('a stranded outcome-unknown package still ages out under deploy.revertRetentionDays', () => {
    config.deploy.revertRetentionDays = 1;
    const id = seedValidatedDeploy('STRA-ND45');
    const dir = revertDirFor(stagingDir(), id);
    db.claimRequestForExecution(id);
    deps.deploys.finalizeStrandedRevert(id, ERR);
    db.finishDeployRequest(id, 'execution_failed', JSON.stringify({ stranded: true }));
    const old = new Date(Date.now() - 2 * DAY_MS);
    fs.utimesSync(path.join(dir, 'revert-plan.json'), old, old);
    sweep();
    expect(fs.existsSync(dir)).toBe(false);
    expect(audits('deploy.revert_swept').map((e) => e.detail)).toEqual([
      { requestId: id, reason: 'retention' },
    ]);
  });

  it('a stranded deploy validated without a live check gets a revert_note, never a package', () => {
    const id = seedValidatedDeploy('STRA-ND56', { liveCheck: false });
    db.claimRequestForExecution(id);
    const fields = deps.deploys.finalizeStrandedRevert(id, ERR);
    expect(fields?.revert_package).toBeNull();
    expect(fields?.revert_note).toContain('validated without a live pre-image retrieve');
    expect(fs.existsSync(revertDirFor(stagingDir(), id))).toBe(false);
    expect(audits('deploy.revert_written')).toHaveLength(0);
  });

  it('returns null and writes nothing for anything but a deploy still at executing', () => {
    // A deploy that was never claimed (still validated).
    const validated = seedValidatedDeploy('STRA-ND67');
    expect(deps.deploys.finalizeStrandedRevert(validated, ERR)).toBeNull();
    expect(fs.existsSync(planFileOf(validated))).toBe(false);
    // A deploy that already finished.
    const finished = seedValidatedDeploy('STRA-ND78');
    db.claimRequestForExecution(finished);
    db.finishDeployRequest(finished, 'executed', JSON.stringify({ deployed: true }));
    expect(deps.deploys.finalizeStrandedRevert(finished, ERR)).toBeNull();
    expect(fs.existsSync(planFileOf(finished))).toBe(false);
    // Another kind stranded at executing.
    const dml = db.insertDeployRequest({
      connectionId: connId,
      kind: 'dml',
      confirmationCode: 'STRA-ND89',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      summaryJson: JSON.stringify({ operation: 'update', object: 'Account', row_count: 2 }),
    }).id;
    db.claimRequestForExecution(dml);
    expect(deps.deploys.finalizeStrandedRevert(dml, ERR)).toBeNull();
    // No such request; a malformed id never throws.
    expect(
      deps.deploys.finalizeStrandedRevert('00000000-0000-4000-8000-000000000000', ERR),
    ).toBeNull();
    expect(deps.deploys.finalizeStrandedRevert('../escape', ERR)).toBeNull();
    expect(audits('deploy.revert_written')).toHaveLength(0);
  });
});
