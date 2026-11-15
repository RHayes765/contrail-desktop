import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ContrailDb,
  ContrailError,
  hhmm,
  type ApprovalRequestView,
  type EngineDeps,
} from '@contrail/engine';
import type { ChatEvent, DeployChangeView } from '@contrail/shared';
import {
  DeployService,
  NativeApprovalPresenter,
  targetMovedRefusal,
} from '../main/services/deploys.js';
import {
  TARGET_MOVED_LEAD,
  localStamp,
  revertDeleteLabel,
  stateLabel,
  structuredRow,
  targetCheckHeadline,
} from '../renderer/src/lib/deployReview.js';

/**
 * Native approval invariants (spec §M5, base set — the full adversarial
 * suite is Session 10):
 *   1. The confirmation code NEVER reaches the renderer: not in the review
 *      model, not in any view, not in push payloads.
 *   2. Approve is the ONLY execute path, and it feeds the engine the code
 *      from the DB row — renderer input cannot substitute one.
 *   3. Reject kills the pending code for good.
 *   4. Production approval requires a comment.
 *   5. An agent's held write resolves with the human's decision.
 */

let tmp: string;
let db: ContrailDb;
let pushes: Array<{ channel: string; payload: unknown }>;
let executed: Array<{ connId: string; code: string }>;
let strandedFinalized: Array<{ requestId: string; error: string; statusAtCall: string | null }>;
let deps: EngineDeps;
let service: DeployService;

function seedConnection(orgType: string, alias: string): string {
  const grants = {
    metadata_read: true,
    metadata_write: true,
    diagnostics_read: false,
    data_read: false,
    data_write: false,
  };
  return db.insertConnection({
    alias,
    instanceUrl: `https://${alias}.stub.salesforce.com`,
    loginUrl: 'https://login.salesforce.com',
    orgId: `00D-${alias}`,
    orgName: alias,
    orgType,
    isSandbox: orgType !== 'production',
    username: null,
    userId: null,
    grants,
  }).id;
}

function seedRequest(connId: string, code = 'ABCD-EFGH'): string {
  return db.insertDeployRequest({
    connectionId: connId,
    kind: 'deploy',
    confirmationCode: code,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    summaryJson: JSON.stringify({
      changes: [{ type: 'ApexClass', api_name: 'Foo', change: 'modify', warnings: [] }],
      destructive: [],
      blast: ['ApexClass:Foo ← used by Flow:Bar'],
    }),
  }).id;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-approve-'));
  db = new ContrailDb(path.join(tmp, 'test.db'));
  pushes = [];
  executed = [];
  strandedFinalized = [];
  const audit = { record: () => undefined };
  /**
   * A FAITHFUL engine stub: it claims the row and writes the terminal
   * result exactly as DeployEngine does (validated → executing → executed),
   * with the engine's real payload keys. An unfaithful stub is how the
   * `success`-key bug slipped past the first suite.
   */
  const finish = (code: string, payload: Record<string, unknown>) => {
    const row = db.listDeployRequests({ limit: 200 }).find((r) => r.confirmationCode === code);
    if (row) {
      db.claimRequestForExecution(row.id);
      db.finishDeployRequest(
        row.id,
        payload.deployed === false || payload.executed === false ? 'execution_failed' : 'executed',
        JSON.stringify(payload),
      );
    }
  };
  const deploysEngine = {
    executeDeploy: async (conn: { id: string }, code: string) => {
      executed.push({ connId: conn.id, code });
      const result = { deployed: true, id: 'deploy-1' };
      finish(code, result);
      return { status: 'complete', result };
    },
    executeDml: async (conn: { id: string }, code: string) => {
      executed.push({ connId: conn.id, code });
      const result = { executed: true };
      finish(code, result);
      return result;
    },
    // Faithful to DeployEngine.finalizeStrandedRevert's contract: null for
    // anything but a deploy still at 'executing'; otherwise the payload
    // fields of an outcome-unknown revert package.
    finalizeStrandedRevert: (requestId: string, error: string) => {
      const row = db.getDeployRequest(requestId);
      strandedFinalized.push({ requestId, error, statusAtCall: row?.status ?? null });
      if (!row || row.kind !== 'deploy' || row.status !== 'executing') return null;
      return {
        revert_package: {
          dir: path.join(tmp, 'staging', '_reverts', requestId),
          outcome: 'unknown',
          restores: [],
          deletes: [],
          not_restorable: [],
        },
      };
    },
  };
  deps = { db, audit, deploys: deploysEngine } as unknown as EngineDeps;
  service = new DeployService(deps, (channel, payload) => {
    pushes.push({ channel, payload });
  });
});

afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the code never reaches the renderer (invariant 1)', () => {
  it('review_json, views, and pushes are code-free after presentation', () => {
    const connId = seedConnection('developer', 'dev-org');
    const requestId = seedRequest(connId, 'QQQQ-WWWW');
    const presenter = new NativeApprovalPresenter();
    presenter.attach(service);
    service.expectPresentation('session-1', connId);
    void presenter.present({
      requestId,
      kind: 'deploy',
      code: 'QQQQ-WWWW',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      org: { alias: 'dev-org', orgName: 'Dev', orgType: 'developer', instanceUrl: 'https://x' },
      changes: [{ label: 'MODIFY ApexClass:Foo', warnings: [] }],
      destructive: [],
      results: [{ label: 'Tests', value: '3 run, 0 failures' }],
      blast: [],
    });

    const rec = db.getDeployRequest(requestId);
    expect(rec?.desktopState).toBe('awaiting_approval');
    expect(rec?.origin).toBe('desktop');
    expect(rec?.sessionId).toBe('session-1');
    expect(rec?.reviewJson).toBeTruthy();
    expect(rec?.reviewJson).not.toContain('QQQQ-WWWW');
    const view = service.get(requestId);
    expect(JSON.stringify(view)).not.toContain('QQQQ-WWWW');
    expect(JSON.stringify(pushes)).not.toContain('QQQQ-WWWW');
  });
});

describe('approve is the only execute path (invariant 2)', () => {
  it('feeds the engine the code from the ROW, waits for terminal, records the decision', async () => {
    const connId = seedConnection('developer', 'dev-org');
    const requestId = seedRequest(connId, 'ROWC-ODES');
    const view = await service.approve(requestId, 'ship it');
    expect(executed).toEqual([{ connId, code: 'ROWC-ODES' }]);
    expect(view.desktopState).toBe('approved');
    expect(view.approvedComment).toBe('ship it');
  });

  it('refuses non-validated and expired requests', async () => {
    const connId = seedConnection('developer', 'dev-org');
    const requestId = seedRequest(connId);
    db.updateDeployRequestStatus(requestId, 'expired');
    await expect(service.approve(requestId)).rejects.toThrow(/expired/);
    expect(executed).toEqual([]);
  });
});

describe('production requires a comment (invariant 4)', () => {
  it('rejects an empty comment for production and never executes', async () => {
    const connId = seedConnection('production', 'client-prod');
    const requestId = seedRequest(connId);
    await expect(service.approve(requestId, '   ')).rejects.toThrow(/comment/);
    expect(executed).toEqual([]);
    // With a comment it goes through.
    const view = await service.approve(requestId, 'change window approved by client');
    expect(view.desktopState).toBe('approved');
    expect(executed).toHaveLength(1);
  });
});

describe('reject kills the code (invariant 3)', () => {
  it('flips the row terminal so the claim machinery refuses it forever', async () => {
    const connId = seedConnection('developer', 'dev-org');
    const requestId = seedRequest(connId);
    const view = await service.reject(requestId, 'wrong org');
    expect(view.desktopState).toBe('rejected');
    expect(view.status).toBe('superseded');
    expect(executed).toEqual([]);
    await expect(service.approve(requestId)).rejects.toThrow(/superseded/);
  });
});

describe('held agent writes resolve with the human decision (invariant 5)', () => {
  it('approve resolves the held call with the execution outcome', async () => {
    const connId = seedConnection('developer', 'dev-org');
    const requestId = seedRequest(connId);
    const held = service.interceptAgentExecute('session-1', 'deploy', connId);
    expect(held).not.toBeNull();
    await service.approve(requestId, 'go');
    const result = await held!;
    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain('"approved": true');
  });

  it('reject resolves the held call with a structured refusal', async () => {
    const connId = seedConnection('developer', 'dev-org');
    seedRequest(connId);
    const held = service.interceptAgentExecute('session-1', 'deploy', connId);
    const rejected = await Promise.all([
      held,
      service.reject(db.listDeployRequests({ connectionId: connId })[0].id, 'no'),
    ]).then(([r]) => r);
    expect(rejected!.isError).toBe(true);
    expect(rejected!.content[0].text).toContain('REJECTED');
  });

  it('nothing pending → null (the engine speaks for itself)', () => {
    const connId = seedConnection('developer', 'dev-org');
    expect(service.interceptAgentExecute('session-1', 'deploy', connId)).toBeNull();
  });

  it('an EMPTY-STRING code counts as codeless — the hold still engages', async () => {
    // Live-demo regression: Haiku passed confirmation_code: "" and the
    // executor's typeof check let it fall through to an engine refusal.
    const { AgentSessionRun } = await import('../main/services/agentRuntime.js');
    const connId = seedConnection('developer', 'dev-org');
    const requestId = seedRequest(connId);
    const world = {
      resolveConnection: (ref: string) => db.resolveConnection(ref),
      listProjectBindings: () => [{ connectionId: connId, envRole: 'dev' }],
      getProject: (id: string) => ({ id, name: 'P', description: null, instructions: null }),
      getServerToggles: () => [],
    };
    const run = new AgentSessionRun(
      { db: world } as never,
      {
        project: { id: 'p1', name: 'P', description: null, instructions: null },
        bindings: [],
        model: 'claude-haiku-4-5',
        maxTurns: 10,
        maxBudgetUsd: 0.5,
      },
      'session-1',
      {} as never,
      () => service,
    );
    const heldPromise = run.executeCapability('execute_deploy', {
      connection: connId,
      confirmation_code: '',
    });
    // Resolve it so the test doesn't hang on the 5-minute hold.
    await service.approve(requestId, 'ok');
    const result = await heldPromise;
    expect(result.content[0].text).toContain('"approved": true');
  });
});

// ── review-driven regressions (S9.1) ─────────────────────────────────────

describe('execution outcome honesty (review finding: `success` key never exists)', () => {
  it('a deploy that ran and FAILED resolves the held call as a failure', async () => {
    const connId = seedConnection('developer', 'dev-org');
    const requestId = seedRequest(connId);
    (deps.deploys as unknown as { executeDeploy: unknown }).executeDeploy = async () => {
      // Real shape for a failed deploy: deployed:false, not success:false.
      const result = { deployed: false, component_errors: [{ problem: 'bad Apex' }] };
      db.claimRequestForExecution(requestId);
      db.finishDeployRequest(requestId, 'execution_failed', JSON.stringify(result));
      return { status: 'complete', result };
    };
    const held = service.interceptAgentExecute('session-1', 'deploy', connId);
    await service.approve(requestId, 'go');
    const result = await held!;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('execution failed');
  });
});

describe('held calls are never orphaned (review finding: registry hijack)', () => {
  it('a retry from the same session settles the older call instead of wedging it', async () => {
    const connId = seedConnection('developer', 'dev-org');
    const requestId = seedRequest(connId);
    const first = service.interceptAgentExecute('session-1', 'deploy', connId);
    const second = service.interceptAgentExecute('session-1', 'deploy', connId);
    const firstResult = await first!; // settles immediately, without a decision
    expect(firstResult.content[0].text).toContain('superseded_by_retry');
    await service.approve(requestId, 'go');
    expect((await second!).content[0].text).toContain('"approved": true');
  });

  it('a second SESSION does not steal the first session\'s hold', async () => {
    const connId = seedConnection('developer', 'dev-org');
    const requestId = seedRequest(connId);
    const a = service.interceptAgentExecute('session-A', 'deploy', connId);
    const b = service.interceptAgentExecute('session-B', 'deploy', connId);
    await service.approve(requestId, 'go');
    // BOTH settle with the outcome; neither hangs forever.
    expect((await a!).content[0].text).toContain('"approved": true');
    expect((await b!).content[0].text).toContain('"approved": true');
  });

  it('session teardown settles any hold it owned', async () => {
    const connId = seedConnection('developer', 'dev-org');
    seedRequest(connId);
    const held = service.interceptAgentExecute('session-1', 'deploy', connId);
    service.releaseHeldForSession('session-1');
    expect((await held!).content[0].text).toContain('session ended');
  });
});

describe('decided-before-execute replay (review finding: approval loop)', () => {
  it('replays the terminal outcome instead of sending the agent back to re-validate', async () => {
    const connId = seedConnection('developer', 'dev-org');
    const requestId = seedRequest(connId);
    db.setDeployRequestDesktopFields(requestId, { sessionId: 'session-1', origin: 'desktop' });
    await service.approve(requestId, 'approved before the agent called execute');
    // The agent's codeless execute arrives LATE — it must see the result.
    const late = service.interceptAgentExecute('session-1', 'deploy', connId);
    expect(late).not.toBeNull();
    const result = await late!;
    expect(result.content[0].text).toContain('"approved": true');
  });

  it('replays a rejection with the reason', async () => {
    const connId = seedConnection('developer', 'dev-org');
    const requestId = seedRequest(connId);
    db.setDeployRequestDesktopFields(requestId, { sessionId: 'session-1', origin: 'desktop' });
    await service.reject(requestId, 'wrong org');
    const late = await service.interceptAgentExecute('session-1', 'deploy', connId)!;
    expect(late.isError).toBe(true);
    expect(late.content[0].text).toContain('wrong org');
  });
});

describe('grants stay law on the approval path (review finding: gate bypass)', () => {
  it('revoking metadata_write blocks approval even for a pending request', async () => {
    const connId = seedConnection('developer', 'dev-org');
    const requestId = seedRequest(connId);
    const conn = db.resolveConnection(connId)!;
    db.updateGrants(connId, { ...conn.grants, metadata_write: false });
    await expect(service.approve(requestId, 'go')).rejects.toThrow(/metadata_write/);
    expect(executed).toEqual([]);
  });
});

describe('stranded executions are reconciled (review finding: eternal Executing)', () => {
  it('sweeps rows stuck executing from a previous run', () => {
    const connId = seedConnection('developer', 'dev-org');
    const requestId = seedRequest(connId);
    db.claimRequestForExecution(requestId);
    expect(db.getDeployRequest(requestId)?.status).toBe('executing');
    expect(service.reconcileStrandedExecutions(-1)).toBe(1); // negative age = sweep all
    const rec = db.getDeployRequest(requestId);
    expect(rec?.status).toBe('execution_failed');
    expect(rec?.resultJson).toContain('Deployment Status');
  });

  it('a stranded deploy finalizes its revert package (outcome unknown) BEFORE the flip, and the result names it', () => {
    const connId = seedConnection('developer', 'dev-org');
    const requestId = seedRequest(connId, 'STRA-NDED');
    db.claimRequestForExecution(requestId);
    expect(service.reconcileStrandedExecutions(-1)).toBe(1);
    // Called while the row was still 'executing' — after the flip the
    // engine's sweep would already treat a plan-less dir as removable.
    expect(strandedFinalized).toEqual([
      { requestId, error: expect.stringContaining('Contrail closed'), statusAtCall: 'executing' },
    ]);
    const result = JSON.parse(db.getDeployRequest(requestId)!.resultJson!);
    const dir = path.join(tmp, 'staging', '_reverts', requestId);
    expect(result).toMatchObject({
      stranded: true,
      revert_package: { dir, outcome: 'unknown' },
    });
    expect(result.note).toContain('Deployment Status');
    expect(result.note).toContain(`kept under ${dir} (revert-plan.json, outcome "unknown")`);
    expect(JSON.stringify(result)).not.toContain('STRA-NDED');
  });

  it("a stranded deploy's stored target check rides its result, so the panel still discloses it", () => {
    const connId = seedConnection('developer', 'dev-org');
    const requestId = seedRequest(connId, 'STRA-CHEK');
    db.claimRequestForExecution(requestId);
    const check = { status: 'unavailable', reason: 'listMetadata failed: HTTP 500' };
    // Faithful to finalizeStrandedRevert: the verdict executeDeploy persisted
    // at the claim comes back as target_check beside the package fields.
    (deps.deploys as unknown as { finalizeStrandedRevert: unknown }).finalizeStrandedRevert = (
      id: string,
      error: string,
    ) => {
      strandedFinalized.push({ requestId: id, error, statusAtCall: 'executing' });
      return { revert_package: null, revert_note: 'No revert package.', target_check: check };
    };
    expect(service.reconcileStrandedExecutions(-1)).toBe(1);
    expect(strandedFinalized[0]!.error).toBe(
      'Contrail closed while this deploy was executing; its outcome was not recorded',
    );
    const result = JSON.parse(db.getDeployRequest(requestId)!.resultJson!);
    expect(result.target_check).toEqual(check);
    expect(service.get(requestId).notices).toEqual([
      'Execution failed — the target was NOT re-checked before running (listMetadata failed: HTTP 500)',
    ]);
    expect(db.getDeployRequest(requestId)!.resultJson).not.toContain('STRA-CHEK');
  });

  it('a stranded non-deploy row is flipped without touching revert packages', () => {
    const connId = seedConnection('developer', 'dev-org');
    const id = db.insertDeployRequest({
      connectionId: connId,
      kind: 'dml',
      confirmationCode: 'DMLX-STRD',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      summaryJson: JSON.stringify({ operation: 'update', object: 'Account', row_count: 2 }),
    }).id;
    db.claimRequestForExecution(id);
    expect(service.reconcileStrandedExecutions(-1)).toBe(1);
    expect(strandedFinalized).toEqual([]);
    const result = JSON.parse(db.getDeployRequest(id)!.resultJson!);
    expect(result.stranded).toBe(true);
    expect(result).not.toHaveProperty('revert_package');
    expect(result.note).not.toContain('kept under');
  });
});

describe('DML and plugin-era rows render honestly (review finding: blank approvable review)', () => {
  it('a DML preview summary yields describable rows', () => {
    const connId = seedConnection('developer', 'dev-org');
    const id = db.insertDeployRequest({
      connectionId: connId,
      kind: 'dml',
      confirmationCode: 'AAAA-BBBB',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      summaryJson: JSON.stringify({ operation: 'delete', object: 'Account', row_count: 12 }),
    }).id;
    const view = service.get(id);
    expect(view.destructiveRows[0].label).toContain('DELETE 12 row(s) on Account');
  });

  it('a plugin-era row (no review_json) surfaces its raw summary rather than nothing', () => {
    const connId = seedConnection('developer', 'dev-org');
    const id = seedRequest(connId);
    const view = service.get(id);
    // seedRequest writes a structured summary; changes parse, so it is describable.
    expect(view.changes.length + view.changeRows.length).toBeGreaterThan(0);
  });
});

// ── S45: the approval page is the whole truth (native review) ────────────

describe('S45: the native review carries the page (diffs, automation, live check)', () => {
  /** An engine ApprovalRowDiff, as the presenter receives it (snake_case). */
  const ROW_DIFF = {
    format: 'text' as const,
    identical: false,
    baseline_label: 'diff vs live org (retrieved 15:02)',
    summary: 'diff vs live org (retrieved 15:02) · +1 / −1 lines',
    text_hunks: [
      {
        a_line: 3,
        b_line: 3,
        removed: ['// <script>alert(1)</script>'],
        added: ['return 2;'],
      },
    ],
    counts: { lines_added: 1, lines_removed: 1 },
    truncated: false,
  };

  /** What a request validated outside the app (an S45 page existed) says. */
  const OUTSIDE_DEPLOY_NOTICE =
    'Validated outside the app — its per-row diffs were shown on its own approval page and ' +
    'are not stored here; warnings that mention "the diff below" refer to that page. ' +
    'Re-validate here to see them.';

  /** A full ObjectAutomation-shaped section: the review keeps only its lines. */
  const AUTOMATION = {
    object: 'Account',
    snapshot_at: '2026-11-14T09:30:00.000Z',
    source_dates: { flows: null, triggers: null },
    flows: [{ name: 'Account_After_Save' }],
    scheduled_flows: [],
    event_flows: [],
    triggers: [],
    validation_rules: [],
    processes: [],
    inactive_flow_count: 0,
    flow_files_read: 1,
    flow_files_total: 1,
    unread_sources: [],
    summary_lines: [
      'Flow Account_After_Save — Active · record-triggered, after save, on create or update',
    ],
    notes: ['a note'],
    not_covered: ['Workflow rules and email alerts (Workflow is not snapshotted)'],
  };

  function present(
    connId: string,
    requestId: string,
    code: string,
    extra: Partial<ApprovalRequestView> = {},
  ): void {
    const presenter = new NativeApprovalPresenter();
    presenter.attach(service);
    service.expectPresentation('session-1', connId);
    void presenter.present({
      requestId,
      kind: 'deploy',
      code,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      org: { alias: 'dev-org', orgName: 'Dev', orgType: 'developer', instanceUrl: 'https://x' },
      changes: [
        {
          label: 'MODIFY ApexClass:Foo',
          warnings: [
            'CHANGED IN TARGET SINCE YOUR SNAPSHOT — the diff below is against the LIVE version',
          ],
          detail: 'last modified in the org by Other User at 2026-11-15T10:00:00.000Z',
          diff: ROW_DIFF,
        },
      ],
      destructive: [],
      results: [{ label: 'Tests', value: '3 run, 0 failures' }],
      blast: [],
      ...extra,
    });
  }

  it('review_json carries the diff rows and the automation lines — and never the code', () => {
    const connId = seedConnection('developer', 'dev-org');
    const requestId = seedRequest(connId, 'DIFF-CODE');
    present(connId, requestId, 'DIFF-CODE', {
      automation: [AUTOMATION] as unknown as ApprovalRequestView['automation'],
    });
    const rec = db.getDeployRequest(requestId)!;
    const review = JSON.parse(rec.reviewJson!);
    expect(review.changeRows[0].diff).toEqual(ROW_DIFF);
    // Only the card's lines are stored, copied by name.
    expect(review.automation).toEqual([
      {
        object: 'Account',
        snapshot_at: AUTOMATION.snapshot_at,
        summary_lines: AUTOMATION.summary_lines,
        notes: AUTOMATION.notes,
        not_covered: AUTOMATION.not_covered,
      },
    ]);
    expect(review.automationNotCovered).toEqual([]);
    expect(rec.reviewJson).not.toContain('DIFF-CODE');

    const view = service.get(requestId);
    const diff = view.changeRows[0].diff!;
    expect(diff.baselineLabel).toBe('diff vs live org (retrieved 15:02)');
    expect(diff.summary).toBe(ROW_DIFF.summary);
    expect(diff.format).toBe('text');
    // Raw org text: the screen renders it as text, so it is never escaped here.
    expect(diff.hunks?.[0].removed).toEqual(['// <script>alert(1)</script>']);
    expect(diff.counts).toMatchObject({ linesAdded: 1, linesRemoved: 1 });
    expect(view.changeRows[0].detail).toContain('Other User');
    expect(view.automation).toEqual(review.automation);
    expect(JSON.stringify(view)).not.toContain('DIFF-CODE');
    expect(JSON.stringify(pushes)).not.toContain('DIFF-CODE');
  });

  it('an Apex page naming no object keeps its not-covered lines (D6)', () => {
    const connId = seedConnection('developer', 'dev-org');
    const requestId = seedRequest(connId, 'APEX-NOOB');
    present(connId, requestId, 'APEX-NOOB', {
      kind: 'apex',
      changes: [{ label: 'Execute anonymous Apex (1 line, 20 chars)', warnings: [] }],
      automation: [],
      automationNotCovered: ['Workflow rules and email alerts (Workflow is not snapshotted)'],
    });
    const view = service.get(requestId);
    expect(view.automation).toEqual([]);
    expect(view.automationNotCovered).toEqual([
      'Workflow rules and email alerts (Workflow is not snapshotted)',
    ]);
    expect(db.getDeployRequest(requestId)!.reviewJson).not.toContain('APEX-NOOB');
  });

  it('list() rows carry no diff; get(id) does', () => {
    const connId = seedConnection('developer', 'dev-org');
    const requestId = seedRequest(connId, 'LIST-DIFF');
    present(connId, requestId, 'LIST-DIFF');
    const listed = service.list().find((v) => v.id === requestId)!;
    expect(listed.changeRows).toHaveLength(1);
    expect(listed.changeRows[0].label).toBe('MODIFY ApexClass:Foo');
    expect(listed.changeRows[0].warnings[0]).toContain('CHANGED IN TARGET');
    expect('diff' in listed.changeRows[0]).toBe(false);
    expect(JSON.stringify(service.list())).not.toContain('alert(1)');
    expect(JSON.stringify(service.list())).not.toContain('retrieved 15:02');
    const full = service.get(requestId);
    expect(full.changeRows[0].diff?.hunks?.[0].added).toEqual(['return 2;']);
  });

  it('view() exposes liveCheck and each member pre-image from the stored summary', () => {
    const connId = seedConnection('developer', 'dev-org');
    const id = db.insertDeployRequest({
      connectionId: connId,
      kind: 'deploy',
      confirmationCode: 'LIVE-CHEK',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      summaryJson: JSON.stringify({
        changes: [
          {
            type: 'ApexClass',
            api_name: 'Foo',
            change: 'modify',
            warnings: [],
            pre_image: {
              present: true,
              source: 'retrieve',
              sha256: 'ab'.repeat(32),
              last_modified_date: '2026-11-15T10:00:00.000Z',
              last_modified_by: 'Other User',
              comparable: true,
              restorable: true,
            },
          },
        ],
        destructive: [],
        live_check: {
          status: 'ok',
          started_at: '2026-11-15T10:01:00.000Z',
          at: '2026-11-15T10:02:00.000Z',
          org_clock: { created_date: '2026-11-15T10:01:01.000Z' },
          dates_unavailable_types: ['BotVersion'],
          members: 1,
        },
      }),
    }).id;
    const view = service.get(id);
    expect(view.liveCheck).toEqual({
      status: 'ok',
      reason: null,
      startedAt: '2026-11-15T10:01:00.000Z',
      at: '2026-11-15T10:02:00.000Z',
      orgClock: { createdDate: '2026-11-15T10:01:01.000Z', completedDate: null },
      datesUnavailableTypes: ['BotVersion'],
      datesUnavailable: null,
      members: 1,
    });
    expect(view.changes[0].preImage).toMatchObject({
      present: true,
      source: 'retrieve',
      lastModifiedBy: 'Other User',
      lastModifiedDate: '2026-11-15T10:00:00.000Z',
      comparable: true,
      restorable: true,
    });
    // A plugin-era row (no review_json) rebuilds from these components — no
    // raw-summary row may displace them.
    expect(view.changeRows).toEqual([]);
    expect(view.targetMoved).toBeNull();
    expect(view.targetCheck).toBeNull();
    // Its own page showed per-row diffs and the dates-unavailable line, and
    // stored neither: the review says the diffs are elsewhere and repeats
    // the engine's dates line verbatim.
    expect(view.notices).toEqual([
      OUTSIDE_DEPLOY_NOTICE,
      `Live diff is against the org (retrieved ${hhmm('2026-11-15T10:02:00.000Z')}); ` +
        'last-modified stamps were unavailable for BotVersion (listMetadata reported ' +
        'INVALID_TYPE), so CHANGED-IN-TARGET detection for those members relies on content ' +
        'only and the execute-time check will report them as unchecked.',
    ]);
    // The rebuilt row (renderer-free) names the live copy's editor and time.
    const rebuilt = structuredRow(view.changes[0], 'MODIFY  ApexClass:Foo');
    expect(rebuilt.detail).toBe(
      `live copy last modified by Other User at ${localStamp('2026-11-15T10:00:00.000Z')}`,
    );
    expect(rebuilt.warnings).toEqual([]);
    expect(JSON.stringify(view)).not.toContain('LIVE-CHEK');
  });

  it('a listing that threw names every member type; rebuilt rows say absent, or an unknown editor', () => {
    const connId = seedConnection('developer', 'dev-org');
    const id = db.insertDeployRequest({
      connectionId: connId,
      kind: 'deploy',
      confirmationCode: 'LIST-THRW',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      summaryJson: JSON.stringify({
        changes: [
          { type: 'ApexClass', api_name: 'Foo', change: 'modify', warnings: [] },
          { type: 'CustomField', api_name: 'Account.Tier__c', change: 'add', warnings: [] },
        ],
        destructive: [],
        live_check: {
          status: 'ok',
          started_at: '2026-11-15T10:01:00.000Z',
          at: '2026-11-15T10:02:00.000Z',
          dates_unavailable_types: [],
          dates_unavailable: 'listMetadata failed: HTTP 500',
          members: 2,
        },
      }),
    }).id;
    expect(service.get(id).notices).toEqual([
      OUTSIDE_DEPLOY_NOTICE,
      `Live diff is against the org (retrieved ${hhmm('2026-11-15T10:02:00.000Z')}); ` +
        'last-modified stamps were unavailable for ApexClass, CustomField (listMetadata ' +
        'failed: HTTP 500), so CHANGED-IN-TARGET detection for those members relies on ' +
        'content only and the execute-time check will report them as unchecked.',
    ]);
    expect(JSON.stringify(service.get(id))).not.toContain('LIST-THRW');
  });

  it('a rebuilt row joins provenance with the live who/when, absent, or nothing (renderer-free)', () => {
    const base: DeployChangeView = {
      type: 'ApexClass',
      apiName: 'Foo',
      change: 'modify',
      warnings: ['w'],
      sourcePath: '/work/Foo.cls',
      sourceSha256: 'cd'.repeat(32),
    };
    const image = (over: Partial<NonNullable<DeployChangeView['preImage']>>) => ({
      present: true,
      source: 'retrieve' as const,
      lastModifiedDate: '2026-11-15T09:00:00.000Z',
      lastModifiedBy: null,
      comparable: true,
      restorable: true,
      ...over,
    });
    const from = `from /work/Foo.cls  ·  sha256 ${'cd'.repeat(8)}…`;
    expect(
      structuredRow(
        { ...base, preImage: image({ present: false, lastModifiedDate: null }) },
        'ADD  ApexClass:Foo',
      ).detail,
    ).toBe(`${from}  ·  not in the org at validate`);
    expect(structuredRow({ ...base, preImage: image({}) }, 'x').detail).toBe(
      `${from}  ·  live copy last modified by an unknown user at ` +
        localStamp('2026-11-15T09:00:00.000Z'),
    );
    // No stamp → no who/when clause; no file and no pre-image → no detail.
    expect(
      structuredRow(
        { ...base, preImage: image({ lastModifiedDate: null, lastModifiedBy: 'Someone' }) },
        'x',
      ).detail,
    ).toBe(from);
    expect(structuredRow({ ...base, sourcePath: undefined }, 'x')).toEqual({
      label: 'x',
      warnings: ['w'],
    });
  });

  it('xml, bundle and budget-omitted row diffs map through to get(id) — and never to list()', () => {
    const connId = seedConnection('developer', 'dev-org');
    const requestId = seedRequest(connId, 'XMLB-UNDL');
    const XML_DIFF = {
      format: 'xml' as const,
      identical: false,
      baseline_label: 'diff vs live org (retrieved 15:02)',
      summary: 'diff vs live org (retrieved 15:02) · 4 changes',
      xml_changes: [
        { kind: 'scalar', path: 'CustomField.length', a: '80', b: '120' },
        { kind: 'added', path: 'CustomField.valueSet.value', key: 'Gold' },
        { kind: 'removed', path: 'CustomField.valueSet.value', key: 'Tin' },
        { kind: 'unkeyed', path: 'CustomField.inlineHelpText', note: '2 unkeyed elements differ' },
      ],
      counts: { changes: 4 },
      truncated: false,
    };
    const BUNDLE_DIFF = {
      format: 'bundle' as const,
      identical: false,
      baseline_label: 'diff vs live org (retrieved 15:02)',
      summary: 'diff vs live org (retrieved 15:02) · 2 files changed (x.js, x.html)',
      text_hunks: [
        { file: 'lwc/x/x.js', a_line: 1, b_line: 1, removed: ['return 1;'], added: ['return 2;'] },
        {
          file: 'lwc/x/x.html',
          a_line: 4,
          b_line: 4,
          removed: [],
          added: ['<p>hi</p>'],
          added_truncated: true,
        },
      ],
      counts: {
        files_changed: ['x.js', 'x.html'],
        files_added: ['x.css'],
        files_removed: ['old.css'],
      },
      truncated: false,
    };
    const OMITTED_DIFF = {
      format: 'text' as const,
      identical: false,
      baseline_label: 'diff vs live org (retrieved 15:02)',
      summary: 'diff vs live org (retrieved 15:02) · +40 / −12 lines',
      counts: { lines_added: 40, lines_removed: 12 },
      truncated: true,
      note:
        'diff body omitted — this page’s 150 KB diff budget was spent on the rows above; the ' +
        'summary line still counts this row',
    };
    present(connId, requestId, 'XMLB-UNDL', {
      changes: [
        { label: 'MODIFY CustomField:Account.Tier__c', warnings: [], diff: XML_DIFF },
        { label: 'MODIFY LightningComponentBundle:x', warnings: [], diff: BUNDLE_DIFF },
        { label: 'MODIFY ApexClass:Big', warnings: [], diff: OMITTED_DIFF },
      ],
    });
    const view = service.get(requestId);
    const [xml, bundle, omitted] = view.changeRows.map((r) => r.diff!);

    expect(xml.format).toBe('xml');
    expect(xml.baselineLabel).toBe('diff vs live org (retrieved 15:02)');
    expect(xml.changes).toEqual([
      { kind: 'scalar', path: 'CustomField.length', a: '80', b: '120' },
      { kind: 'added', path: 'CustomField.valueSet.value', key: 'Gold' },
      { kind: 'removed', path: 'CustomField.valueSet.value', key: 'Tin' },
      { kind: 'unkeyed', path: 'CustomField.inlineHelpText', note: '2 unkeyed elements differ' },
    ]);
    expect(xml.hunks).toBeNull();
    expect(xml.counts?.changes).toBe(4);

    expect(bundle.format).toBe('bundle');
    expect(bundle.changes).toBeNull();
    expect(bundle.hunks?.map((h) => h.file)).toEqual(['lwc/x/x.js', 'lwc/x/x.html']);
    expect(bundle.hunks?.[1]).toEqual({
      file: 'lwc/x/x.html',
      a_line: 4,
      b_line: 4,
      removed: [],
      added: ['<p>hi</p>'],
      added_truncated: true,
    });
    expect(bundle.counts?.filesChanged).toEqual(['x.js', 'x.html']);
    expect(bundle.counts?.filesAdded).toEqual(['x.css']);
    expect(bundle.counts?.filesRemoved).toEqual(['old.css']);

    expect(omitted.format).toBe('text');
    expect(omitted.hunks).toBeNull();
    expect(omitted.changes).toBeNull();
    expect(omitted.truncated).toBe(true);
    expect(omitted.note).toBe(OMITTED_DIFF.note);
    expect(omitted.counts?.linesAdded).toBe(40);
    expect(omitted.counts?.linesRemoved).toBe(12);

    const listed = service.list().find((v) => v.id === requestId)!;
    expect(listed.changeRows).toHaveLength(3);
    for (const row of listed.changeRows) expect('diff' in row).toBe(false);
    for (const v of [view, listed]) expect(JSON.stringify(v)).not.toContain('XMLB-UNDL');
  });

  it('an unavailable live check becomes a notice unless the page banner already says so', () => {
    const connId = seedConnection('developer', 'dev-org');
    const summary = JSON.stringify({
      changes: [{ type: 'ApexClass', api_name: 'Foo', change: 'modify', warnings: [] }],
      destructive: [],
      live_check: {
        status: 'unavailable',
        reason: 'timeout',
        started_at: '2026-11-15T10:01:00.000Z',
        at: '2026-11-15T10:03:00.000Z',
        dates_unavailable_types: [],
        members: 1,
      },
    });
    const plain = db.insertDeployRequest({
      connectionId: connId,
      kind: 'deploy',
      confirmationCode: 'NOLV-ONE1',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      summaryJson: summary,
    }).id;
    const view = service.get(plain);
    expect(view.liveCheck?.status).toBe('unavailable');
    expect(view.notices).toEqual([
      'Live comparison unavailable at validate (timeout) — the org was not re-read; ' +
        'classifications and diffs came from the local snapshot only.',
      // No review_json: validated outside the app, whose page showed the diffs.
      OUTSIDE_DEPLOY_NOTICE,
    ]);

    const bannered = db.insertDeployRequest({
      connectionId: connId,
      kind: 'deploy',
      confirmationCode: 'NOLV-TWO2',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      summaryJson: summary,
    }).id;
    present(connId, bannered, 'NOLV-TWO2', {
      warnings: ['LIVE COMPARISON UNAVAILABLE (timeout) — compared against your snapshot'],
    });
    expect(service.get(bannered).notices).toEqual([]);
  });

  it('view() exposes the revert package, including outcome unknown, and the no-package note', () => {
    const connId = seedConnection('developer', 'dev-org');
    const executedId = seedRequest(connId, 'REVT-EXEC');
    db.claimRequestForExecution(executedId);
    db.finishDeployRequest(
      executedId,
      'executed',
      JSON.stringify({
        deployed: true,
        target_check: {
          status: 'ok',
          checked_at: '2026-11-15T10:05:00.000Z',
          checked: [{ type: 'ApexClass', api_name: 'Foo' }],
          unchecked: [],
        },
        revert_package: {
          dir: '/data/staging/_reverts/x',
          restores: [
            {
              type: 'ApexClass',
              api_name: 'Foo',
              content_file: '/data/staging/_reverts/x/classes/Foo.cls',
            },
          ],
          deletes: [{ type: 'ApexClass', api_name: 'NewOne' }],
          not_restorable: [{ type: 'Profile', api_name: 'Admin', reason: 'not comparable' }],
          plan: '/data/staging/_reverts/x/revert-plan.json',
          note: 'A revert re-deploys what Contrail retrieved',
        },
      }),
    );
    const executedView = service.get(executedId);
    expect(executedView.revertPackage).toEqual({
      dir: '/data/staging/_reverts/x',
      outcome: 'executed',
      restores: [
        {
          type: 'ApexClass',
          apiName: 'Foo',
          contentFile: '/data/staging/_reverts/x/classes/Foo.cls',
        },
      ],
      deletes: [{ type: 'ApexClass', apiName: 'NewOne' }],
      notRestorable: [{ type: 'Profile', apiName: 'Admin', reason: 'not comparable' }],
      plan: '/data/staging/_reverts/x/revert-plan.json',
      note: 'A revert re-deploys what Contrail retrieved',
    });
    expect(executedView.targetCheck).toMatchObject({
      status: 'ok',
      checked: [{ label: 'ApexClass Foo', state: null, detail: null }],
      unchecked: [],
    });
    // A passed check raises no notice.
    expect(executedView.notices).toEqual([]);

    const unknownId = seedRequest(connId, 'REVT-UNKN');
    db.claimRequestForExecution(unknownId);
    db.finishDeployRequest(
      unknownId,
      'execution_failed',
      JSON.stringify({
        deployed: false,
        error_message: 'deploy_timeout',
        revert_package: {
          dir: '/data/staging/_reverts/y',
          outcome: 'unknown',
          restores: [],
          deletes: [],
          not_restorable: [],
        },
      }),
    );
    expect(service.get(unknownId).revertPackage).toMatchObject({
      dir: '/data/staging/_reverts/y',
      outcome: 'unknown',
    });

    const noneId = seedRequest(connId, 'REVT-NONE');
    db.claimRequestForExecution(noneId);
    db.finishDeployRequest(
      noneId,
      'executed',
      JSON.stringify({
        deployed: true,
        revert_package: null,
        revert_note: 'No revert package: the live pre-image retrieve was unavailable',
      }),
    );
    const noneView = service.get(noneId);
    expect(noneView.revertPackage).toBeNull();
    expect(noneView.revertNote).toContain('No revert package');
  });
});

describe('S45: a target-moved request never reads as executed', () => {
  const REFUSAL =
    'TARGET MOVED — not executed, and this code is now void. listMetadata (10:05) reports ' +
    'members changed in "dev-org" since this package was validated: ApexClass Foo — last ' +
    'modified by Other User at 2026-11-15T10:04:00.000Z (the approval was based on the version ' +
    'last modified at 2026-11-15T09:00:00.000Z). Re-run validate_deploy to see the current ' +
    'state and get a fresh code.';

  /**
   * Faithful to the engine's guard: the request is voided with the moved
   * result as its result_json (atomically, only while 'validated'), and the
   * SAME object is the call's terminal result.
   */
  function movedDeploy(): void {
    (deps.deploys as unknown as { executeDeploy: unknown }).executeDeploy = async (
      conn: { id: string },
      code: string,
    ) => {
      executed.push({ connId: conn.id, code });
      const row = db.listDeployRequests({ limit: 200 }).find((r) => r.confirmationCode === code)!;
      const result = {
        connection: 'dev-org',
        executed: false,
        deployed: false,
        target_moved: true,
        checked_at: '2026-11-15T10:05:00.000Z',
        moved: [
          {
            type: 'ApexClass',
            api_name: 'Foo',
            last_modified_by: 'Other User',
            last_modified_date: '2026-11-15T10:04:00.000Z',
            frozen_date: '2026-11-15T09:00:00.000Z',
            state: 'changed',
          },
        ],
        // The engine adds `unchecked` when non-empty (a type the org cannot enumerate).
        unchecked: [{ type: 'BotVersion', api_name: 'MyBot.v1', reason: 'type_not_enumerable' }],
        refusal: REFUSAL,
        note: 'Nothing was deployed and this confirmation code is void.',
      };
      expect(db.voidRequestWithResult(row.id, JSON.stringify(result))).toBe(true);
      return { status: 'complete', result };
    };
  }

  it('approve(): the held call is refused with "did NOT execute", the row reads as target moved', async () => {
    const connId = seedConnection('developer', 'dev-org');
    const requestId = seedRequest(connId, 'MOVE-DONE');
    db.setDeployRequestDesktopFields(requestId, { sessionId: 'session-1', origin: 'desktop' });
    const events: ChatEvent[] = [];
    service.attachSessions({ announce: (_s, e) => events.push(e) });
    movedDeploy();
    const held = service.interceptAgentExecute('session-1', 'deploy', connId);
    const view = await service.approve(requestId, 'go');
    const result = await held!;
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toBe(
      'The user approved this deploy, but Contrail did NOT execute it — the target changed in ' +
        `the org after validation:${String.fromCharCode(10)}${REFUSAL}`,
    );
    expect(text).not.toContain('"approved": true');
    expect(text).not.toContain('"outcome": "executed"');
    expect(text).not.toContain('MOVE-DONE');
    expect(events).toContainEqual({
      type: 'approval_resolved',
      requestId,
      outcome: 'execution_failed',
    });

    expect(view.status).toBe('superseded');
    expect(view.desktopState).toBe('approved');
    expect(view.targetMoved).toEqual({
      checkedAt: '2026-11-15T10:05:00.000Z',
      refusal: REFUSAL,
      moved: [
        {
          label: 'ApexClass Foo',
          state: 'changed',
          detail: 'last modified by Other User at 2026-11-15T10:04:00.000Z',
        },
      ],
      unchecked: [{ label: 'BotVersion MyBot.v1', state: 'type_not_enumerable', detail: null }],
    });
    expect(view.targetCheck).toBeNull();
    expect(JSON.stringify(view)).not.toContain('MOVE-DONE');
    expect(JSON.stringify(pushes)).not.toContain('MOVE-DONE');
  });

  it('the decided-before-execute replay refuses the moved request — never "executed"', async () => {
    const connId = seedConnection('developer', 'dev-org');
    const requestId = seedRequest(connId, 'MOVE-LATE');
    db.setDeployRequestDesktopFields(requestId, { sessionId: 'session-1', origin: 'desktop' });
    movedDeploy();
    await service.approve(requestId, 'approved before the agent called execute');
    const late = service.interceptAgentExecute('session-1', 'deploy', connId);
    expect(late).not.toBeNull();
    const result = await late!;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('did NOT execute');
    expect(result.content[0].text).toContain(REFUSAL);
    expect(result.content[0].text).not.toContain('"outcome": "executed"');
    expect(result.content[0].text).not.toContain('MOVE-LATE');
  });

  it('a call that lost the race to a concurrent void reads the stored refusal back', async () => {
    const connId = seedConnection('developer', 'dev-org');
    const requestId = seedRequest(connId, 'MOVE-RACE');
    (deps.deploys as unknown as { executeDeploy: unknown }).executeDeploy = async () => {
      // Another caller's guard voided it first; the claim refuses this one.
      db.voidRequestWithResult(
        requestId,
        JSON.stringify({ executed: false, deployed: false, target_moved: true, refusal: REFUSAL }),
      );
      throw new ContrailError(
        `This code was already voided and was not executed — ${REFUSAL}`,
        'code_unusable',
      );
    };
    const held = service.interceptAgentExecute('session-1', 'deploy', connId);
    await service.approve(requestId, 'go');
    const result = await held!;
    expect(result.isError).toBe(true);
    // Exactly the STORED refusal (read back from the voided row) — not the
    // thrown claim error, which carries a code_unusable prefix.
    expect(result.content[0].text).toBe(targetMovedRefusal('deploy', REFUSAL));
    expect(result.content[0].text).not.toContain('MOVE-RACE');
    const view = service.get(requestId);
    expect(view.status).toBe('superseded');
    expect(view.targetMoved?.refusal).toBe(REFUSAL);
  });

  it('a moved activation names the BotVersion, its current status and the approved starting one', async () => {
    const connId = seedConnection('developer', 'dev-org');
    const id = db.insertDeployRequest({
      connectionId: connId,
      kind: 'activation',
      confirmationCode: 'ACTM-OVED',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      summaryJson: JSON.stringify({
        rows: [{ label: 'ACTIVATE MyBot v2', warnings: [] }],
        agent: 'MyBot',
        version: 'v2',
      }),
    }).id;
    const ACT_REFUSAL =
      'TARGET MOVED — not executed, and this code is now void. SELECT Status at 10:05 reports ' +
      'BotVersion v2 of MyBot is Active; the approval was for a change from Inactive. Re-run ' +
      'agent_activation_propose.';
    (deps.deploys as unknown as { executeActivation: unknown }).executeActivation = async () => {
      const result = {
        connection: 'dev-org',
        executed: false,
        target_moved: true,
        checked_at: '2026-11-15T10:05:00.000Z',
        agent: 'MyBot',
        version: 'v2',
        bot_version_id: '0X9000000000001AAA',
        approved_from_status: 'Inactive',
        current_status: 'Active',
        refusal: ACT_REFUSAL,
      };
      db.voidRequestWithResult(id, JSON.stringify(result));
      return result;
    };
    const held = service.interceptAgentExecute('session-1', 'activation', connId);
    const view = await service.approve(id, 'go');
    const result = await held!;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(targetMovedRefusal('activation', ACT_REFUSAL));
    expect(result.content[0].text).not.toContain('ACTM-OVED');
    expect(view.status).toBe('superseded');
    expect(view.targetMoved?.moved).toEqual([
      {
        label: 'BotVersion MyBot.v2',
        state: 'changed',
        detail: 'status is now Active; the approval was for a change from Inactive',
      },
    ]);
    expect(view.targetMoved?.refusal).toBe(ACT_REFUSAL);
  });

  it('a moved DML (any kind) resolves the same way', async () => {
    const connId = seedConnection('developer', 'dev-org');
    const conn = db.resolveConnection(connId)!;
    db.updateGrants(connId, { ...conn.grants, data_write: true });
    const id = db.insertDeployRequest({
      connectionId: connId,
      kind: 'dml',
      confirmationCode: 'DMLM-OVED',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      summaryJson: JSON.stringify({ operation: 'update', object: 'Account', row_count: 1 }),
    }).id;
    const dmlRefusal =
      'TARGET MOVED — not executed, and this code is now void. Re-running the preview query ' +
      'at 10:05 shows the records you approved have changed since dml_propose.';
    (deps.deploys as unknown as { executeDml: unknown }).executeDml = async () => {
      const result = {
        executed: false,
        target_moved: true,
        checked_at: '2026-11-15T10:05:00.000Z',
        moved: [{ object: 'Account', id: '001000000000001AAA', field: 'Name', state: 'changed' }],
        refusal: dmlRefusal,
      };
      db.voidRequestWithResult(id, JSON.stringify(result));
      return result;
    };
    const held = service.interceptAgentExecute('session-1', 'dml', connId);
    const view = await service.approve(id, 'go');
    const result = await held!;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      'The user approved this dml, but Contrail did NOT execute it',
    );
    expect(result.content[0].text).toContain(dmlRefusal);
    expect(result.content[0].text).not.toContain('DMLM-OVED');
    expect(view.targetMoved?.moved).toEqual([
      { label: 'Account 001000000000001AAA Name', state: 'changed', detail: null },
    ]);
  });

  it('a plain superseded, expired or locked approved row is refused on replay, never "executed"', async () => {
    const connId = seedConnection('developer', 'dev-org');
    // locked: its result_json is null, which must never read as an executed success.
    for (const status of ['superseded', 'expired', 'locked'] as const) {
      const id = seedRequest(connId, `PLAN-${status.slice(0, 4).toUpperCase()}`);
      db.setDeployRequestDesktopFields(id, { sessionId: `s-${status}`, origin: 'desktop' });
      db.recordDeployDecision(id, 'approved', null);
      db.updateDeployRequestStatus(id, status);
      const late = await service.interceptAgentExecute(`s-${status}`, 'deploy', connId)!;
      expect(late.isError).toBe(true);
      expect(late.content[0].text).toBe(
        `The user approved this deploy, but it did not execute — the request is now ${status}. ` +
          'Re-validate for a fresh code.',
      );
      expect(late.content[0].text).not.toContain('"approved": true');
    }
  });

  it('an executed replay whose result failed is not reported as executed', async () => {
    const connId = seedConnection('developer', 'dev-org');
    const id = seedRequest(connId, 'EXEC-FAIL');
    db.setDeployRequestDesktopFields(id, { sessionId: 's-x', origin: 'desktop' });
    db.recordDeployDecision(id, 'approved', null);
    db.claimRequestForExecution(id);
    db.finishDeployRequest(id, 'executed', JSON.stringify({ executed: false, error: 'boom' }));
    const late = await service.interceptAgentExecute('s-x', 'deploy', connId)!;
    expect(late.isError).toBe(true);
    expect(late.content[0].text).toContain('execution failed');
  });

  it('an approved deploy a quit stranded (reconciled to execution_failed) replays the failure', async () => {
    const connId = seedConnection('developer', 'dev-org');
    const id = seedRequest(connId, 'STRF-AILD');
    db.setDeployRequestDesktopFields(id, { sessionId: 's-f', origin: 'desktop' });
    db.recordDeployDecision(id, 'approved', null);
    db.claimRequestForExecution(id);
    expect(service.reconcileStrandedExecutions(-1)).toBe(1);
    expect(db.getDeployRequest(id)!.status).toBe('execution_failed');
    expect(db.getDeployRequest(id)!.desktopState).toBe('approved');
    const late = await service.interceptAgentExecute('s-f', 'deploy', connId)!;
    expect(late.isError).toBe(true);
    expect(late.content[0].text).toContain('The user approved this deploy, but execution failed');
    expect(late.content[0].text).toContain('Contrail closed while this execution was running');
    expect(late.content[0].text).not.toContain('"outcome": "executed"');
    expect(late.content[0].text).not.toContain('STRF-AILD');
  });

  it("an older approved request is never replayed past this session's newer undecided one", async () => {
    const connId = seedConnection('developer', 'dev-org');
    const dml = (code: string) =>
      db.insertDeployRequest({
        connectionId: connId,
        kind: 'dml',
        confirmationCode: code,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        summaryJson: JSON.stringify({ operation: 'update', object: 'Account', row_count: 1 }),
      }).id;
    const setCreated = (id: string, iso: string) =>
      (db as any).db.prepare('UPDATE deploy_requests SET created_at = ? WHERE id = ?').run(iso, id);
    // R1: approved and executed.
    const r1 = dml('OLDR-EXEC');
    db.setDeployRequestDesktopFields(r1, { sessionId: 's-y', origin: 'desktop' });
    db.recordDeployDecision(r1, 'approved', null);
    db.claimRequestForExecution(r1);
    db.finishDeployRequest(r1, 'executed', JSON.stringify({ executed: true }));
    setCreated(r1, '2026-11-15T10:00:00.000Z');
    // R2: newer, never decided, then expired by the S45 sweep.
    const r2 = dml('NEWR-XPRD');
    db.setDeployRequestDesktopFields(r2, {
      sessionId: 's-y',
      origin: 'desktop',
      desktopState: 'awaiting_approval',
    });
    db.updateDeployRequestStatus(r2, 'expired');
    setCreated(r2, '2026-11-15T10:30:00.000Z');

    const late = await service.interceptAgentExecute('s-y', 'dml', connId)!;
    expect(late.isError).toBe(true);
    expect(late.content[0].text).toBe(
      'Your latest dml request was never approved in Deploy Review and did not execute — it ' +
        'is now expired. Propose again for a fresh request.',
    );
    expect(late.content[0].text).not.toContain('"outcome": "executed"');
    expect(late.content[0].text).not.toContain('NEWR-XPRD');

    // A newer undecided row the engine answers for itself (e.g. executed
    // with a code typed elsewhere) is not replayed either: null.
    db.updateDeployRequestStatus(r2, 'executed');
    expect(service.interceptAgentExecute('s-y', 'dml', connId)).toBeNull();
  });

  it('a hold whose request lapses undecided settles with what it is now, never "stays valid"', async () => {
    vi.useFakeTimers();
    try {
      const connId = seedConnection('developer', 'dev-org');
      const id = seedRequest(connId, 'HOLD-LAPS');
      db.setDeployRequestDesktopFields(id, { sessionId: 'session-1', origin: 'desktop' });
      const held = service.interceptAgentExecute('session-1', 'deploy', connId)!;
      // The S45 sweep (any validate) expires it while the call waits.
      db.updateDeployRequestStatus(id, 'expired');
      vi.advanceTimersByTime(5 * 60_000);
      const result = await held;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(
        'Your latest deploy request was never approved in Deploy Review and did not execute — ' +
          'it is now expired. Validate again for a fresh request.',
      );
      expect(result.content[0].text).not.toContain('stays valid');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a hold superseded by a newer validation points at the newer request, never "validate again"', async () => {
    vi.useFakeTimers();
    try {
      const connId = seedConnection('developer', 'dev-org');
      const id = seedRequest(connId, 'HOLD-SUPR');
      db.setDeployRequestDesktopFields(id, { sessionId: 'session-1', origin: 'desktop' });
      const held = service.interceptAgentExecute('session-1', 'deploy', connId)!;
      // Another session validates the same target while the call waits: this
      // request is superseded and the newer one sits in Deploy Review.
      db.supersedePendingRequests(connId, 'deploy');
      const newer = seedRequest(connId, 'NEWR-PEND');
      db.setDeployRequestDesktopFields(newer, {
        sessionId: 'session-2',
        origin: 'desktop',
        desktopState: 'awaiting_approval',
      });
      vi.advanceTimersByTime(5 * 60_000);
      const result = await held;
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text)).toEqual({
        status: 'superseded',
        request_id: id,
        awaiting_request_id: newer,
        note:
          'A newer deploy validation replaced this request before the user decided in Deploy ' +
          'Review, so it did not execute.\nA newer deploy request on this connection is awaiting ' +
          'the user’s decision in Deploy Review — do not validate again (that would replace it); ' +
          'call again to wait on it.',
      });
      for (const banned of ['Validate again', 'stays valid', 'HOLD-SUPR', 'NEWR-PEND']) {
        expect(result.content[0].text).not.toContain(banned);
      }
      // Calling again holds on the newer request, as the note says.
      const again = service.interceptAgentExecute('session-1', 'deploy', connId);
      expect(again).not.toBeNull();
      service.releaseHeldForSession('session-1');
      expect(JSON.parse((await again!).content[0].text).request_id).toBe(newer);

      // The newer request decided or lapsed too: nothing awaits, so say so.
      const conn2 = seedConnection('developer', 'dev-org-2');
      const old2 = seedRequest(conn2, 'HOLD-SUP2');
      db.setDeployRequestDesktopFields(old2, { sessionId: 'session-3', origin: 'desktop' });
      const wait2 = service.interceptAgentExecute('session-3', 'deploy', conn2)!;
      db.supersedePendingRequests(conn2, 'deploy');
      db.updateDeployRequestStatus(seedRequest(conn2, 'NEWR-GONE'), 'expired');
      vi.advanceTimersByTime(5 * 60_000);
      const result2 = await wait2;
      expect(result2.isError).toBe(true);
      expect(result2.content[0].text).toBe(
        'A newer deploy validation replaced this request before the user decided in Deploy ' +
          'Review, so it did not execute. No deploy request on this connection is awaiting a ' +
          'decision now — validate again only if the user still wants this change.',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('a hold whose request went terminal elsewhere states its status, never "stays valid"', async () => {
    vi.useFakeTimers();
    try {
      const REFUSAL = 'TARGET MOVED — not executed, and this code is now void. Re-run validate_deploy.';
      const elsewhere = 'with a confirmation code entered outside Deploy Review';
      const cases: Array<{
        name: string;
        mutate: (id: string, connId: string) => void;
        expect: (r: { content: Array<{ text: string }>; isError?: boolean }, id: string) => void;
      }> = [
        {
          name: 'locked',
          mutate: (id) => db.updateDeployRequestStatus(id, 'locked'),
          expect: (r) => {
            expect(r.isError).toBe(true);
            expect(r.content[0].text).toBe(
              'This deploy request was never approved in Deploy Review and did not execute — it ' +
                'is now locked (too many wrong confirmation codes). Validate again for a fresh request.',
            );
          },
        },
        {
          name: 'locked-newer',
          mutate: (id, connId) => {
            db.updateDeployRequestStatus(id, 'locked');
            seedRequest(connId, 'NEWR-LOCK');
          },
          expect: (r, id) => {
            expect(r.isError).toBeUndefined();
            const body = JSON.parse(r.content[0].text);
            expect(body).toMatchObject({ status: 'locked', request_id: id });
            expect(typeof body.awaiting_request_id).toBe('string');
            expect(body.note).toContain('do not validate again (that would replace it)');
            expect(body.note).not.toContain('Validate again');
          },
        },
        {
          name: 'executing',
          mutate: (id) => db.claimRequestForExecution(id),
          expect: (r, id) => {
            expect(r.isError).toBeUndefined();
            expect(JSON.parse(r.content[0].text)).toEqual({
              status: 'executing',
              request_id: id,
              note: `This deploy is executing ${elsewhere}, not by this call — do not execute it again.`,
            });
          },
        },
        {
          name: 'executed',
          mutate: (id) => {
            db.claimRequestForExecution(id);
            db.finishDeployRequest(id, 'executed', JSON.stringify({ deployed: true, id: 'deploy-9' }));
          },
          expect: (r, id) => {
            expect(r.isError).toBeUndefined();
            expect(JSON.parse(r.content[0].text)).toEqual({
              status: 'executed',
              request_id: id,
              note:
                `This deploy was executed ${elsewhere} while this call waited — do not execute it again.`,
              detail: { deployed: true, id: 'deploy-9' },
            });
          },
        },
        {
          name: 'execution_failed',
          mutate: (id) => {
            db.claimRequestForExecution(id);
            db.finishDeployRequest(
              id,
              'execution_failed',
              JSON.stringify({ deployed: false, error: 'INVALID_CROSS_REFERENCE_KEY' }),
            );
          },
          expect: (r) => {
            expect(r.isError).toBe(true);
            expect(r.content[0].text).toContain(
              `This deploy was run ${elsewhere} while this call waited, but execution failed:\n`,
            );
            expect(r.content[0].text).toContain('INVALID_CROSS_REFERENCE_KEY');
            expect(r.content[0].text).not.toContain('"outcome": "executed"');
          },
        },
        {
          name: 'target-moved',
          mutate: (id) =>
            db.voidRequestWithResult(id, JSON.stringify({ target_moved: true, refusal: REFUSAL })),
          expect: (r) => {
            expect(r.isError).toBe(true);
            expect(r.content[0].text).toBe(
              'This deploy was never approved in Deploy Review and did not execute — a ' +
                'confirmation code entered outside Deploy Review was refused because the target ' +
                `changed in the org after validation:\n${REFUSAL}`,
            );
          },
        },
      ];
      for (const c of cases) {
        const connId = seedConnection('developer', `dev-${c.name}`);
        const code = `TERM-${c.name.slice(0, 4).toUpperCase()}`;
        const id = seedRequest(connId, code);
        const sessionId = `s-t-${c.name}`;
        db.setDeployRequestDesktopFields(id, { sessionId, origin: 'desktop' });
        const held = service.interceptAgentExecute(sessionId, 'deploy', connId)!;
        c.mutate(id, connId);
        vi.advanceTimersByTime(5 * 60_000);
        const result = await held;
        c.expect(result, id);
        expect(result.content[0].text).not.toContain('stays valid');
        expect(result.content[0].text).not.toContain(code);
        expect(result.content[0].text).not.toContain('NEWR-LOCK');
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('a claim refused because the row left validated during the guard reads as the replay does', async () => {
    const connId = seedConnection('developer', 'dev-org');
    for (const status of ['expired', 'superseded', 'locked'] as const) {
      const code = `GARD-${status.slice(0, 4).toUpperCase()}`;
      const id = seedRequest(connId, code);
      const sessionId = `s-g-${status}`;
      db.setDeployRequestDesktopFields(id, { sessionId, origin: 'desktop' });
      (deps.deploys as unknown as { executeDeploy: unknown }).executeDeploy = async () => {
        // The guard's org read outlived the row: the in-job claim refuses.
        db.updateDeployRequestStatus(id, status);
        throw new ContrailError(
          status === 'expired'
            ? 'This confirmation code has expired. Re-run validate_deploy for a new code.'
            : 'This code can no longer be used.',
          status === 'expired' ? 'code_expired' : 'code_unusable',
        );
      };
      const held = service.interceptAgentExecute(sessionId, 'deploy', connId);
      await service.approve(id, 'go');
      const live = await held!;
      const replay = await service.interceptAgentExecute(sessionId, 'deploy', connId)!;
      expect(live.isError).toBe(true);
      expect(live.content[0].text).toBe(
        `The user approved this deploy, but it did not execute — the request is now ${status}. ` +
          'Re-validate for a fresh code.',
      );
      expect(replay.content[0].text).toBe(live.content[0].text);
      expect(live.content[0].text).not.toContain('execution failed');
      expect(live.content[0].text).not.toContain(code);
    }
  });
});

describe('S45: a write that ran without a target check is executed, and says so', () => {
  it("fail-open 'unavailable': approved:true with target_check in the detail, plus the notice", async () => {
    const connId = seedConnection('developer', 'dev-org');
    const requestId = seedRequest(connId, 'OPEN-FAIL');
    const targetCheck = {
      status: 'unavailable',
      reason: 'listMetadata failed: HTTP 500',
      note:
        'Contrail could not re-read the org to confirm nothing had moved before executing ' +
        '(listMetadata failed: HTTP 500); this deploy ran against whatever the org held at ' +
        'that moment.',
    };
    (deps.deploys as unknown as { executeDeploy: unknown }).executeDeploy = async () => {
      const result = {
        connection: 'dev-org',
        deployed: true,
        status: 'Succeeded',
        target_check: targetCheck,
      };
      db.claimRequestForExecution(requestId);
      db.finishDeployRequest(requestId, 'executed', JSON.stringify(result));
      return { status: 'complete', result };
    };
    const held = service.interceptAgentExecute('session-1', 'deploy', connId);
    const view = await service.approve(requestId, 'go');
    const result = await held!;
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload).toMatchObject({ approved: true, outcome: 'executed' });
    expect(payload.detail.target_check).toEqual(targetCheck);
    expect(result.content[0].text).not.toContain('OPEN-FAIL');

    expect(view.status).toBe('executed');
    expect(view.targetCheck).toMatchObject({
      status: 'unavailable',
      reason: 'listMetadata failed: HTTP 500',
      note: targetCheck.note,
    });
    expect(view.notices).toEqual([
      'Executed — the target was NOT re-checked before running (listMetadata failed: HTTP 500)',
    ]);
    expect(view.targetMoved).toBeNull();
  });

  it("'not_checked': approved:true, and the notice names what could not be compared", async () => {
    const connId = seedConnection('developer', 'dev-org');
    const conn = db.resolveConnection(connId)!;
    db.updateGrants(connId, { ...conn.grants, data_write: true });
    const id = db.insertDeployRequest({
      connectionId: connId,
      kind: 'dml',
      confirmationCode: 'NOTC-HECK',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      summaryJson: JSON.stringify({ operation: 'update', object: 'Account', row_count: 1 }),
    }).id;
    const targetCheck = {
      status: 'not_checked',
      checked_at: '2026-11-15T10:05:00.000Z',
      checked: [],
      unchecked: [{ object: 'Account', id: '001000000000001AAA', reason: 'no_precheck_recorded' }],
      note: 'dml_propose recorded no before-values Contrail could compare against',
    };
    (deps.deploys as unknown as { executeDml: unknown }).executeDml = async () => {
      const result = { executed: true, target_check: targetCheck };
      db.claimRequestForExecution(id);
      db.finishDeployRequest(id, 'executed', JSON.stringify(result));
      return result;
    };
    const held = service.interceptAgentExecute('session-1', 'dml', connId);
    const view = await service.approve(id, 'go');
    const result = await held!;
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0].text).detail.target_check.status).toBe('not_checked');
    expect(view.targetCheck?.unchecked).toEqual([
      { label: 'Account 001000000000001AAA', state: 'no_precheck_recorded', detail: null },
    ]);
    expect(view.notices).toEqual([
      // Seeded without review_json, exactly like a DML proposed outside the app.
      'Proposed outside the app — if its own approval page showed an automation card (what ' +
        'the local snapshot says fires on the objects it touches), that card is not stored ' +
        'here. Re-propose here to see it.',
      'Executed — the target was NOT re-checked before running (nothing could be compared — ' +
        'Account 001000000000001AAA: no_precheck_recorded)',
    ]);
  });

  it("execution_failed with target_check 'unavailable' still discloses the missing check", () => {
    const connId = seedConnection('developer', 'dev-org');
    const id = seedRequest(connId, 'FAIL-UNAV');
    db.claimRequestForExecution(id);
    db.finishDeployRequest(
      id,
      'execution_failed',
      JSON.stringify({
        deployed: false,
        target_check: {
          status: 'unavailable',
          reason: 'listMetadata failed: HTTP 500',
          note: 'Contrail could not re-read the org to confirm nothing had moved.',
        },
      }),
    );
    const view = service.get(id);
    expect(view.notices).toEqual([
      'Execution failed — the target was NOT re-checked before running (listMetadata failed: HTTP 500)',
    ]);
    expect(JSON.stringify(view)).not.toContain('FAIL-UNAV');
  });

  it("a deploy 'not_checked' over many members names the first three and counts the rest", () => {
    const connId = seedConnection('developer', 'dev-org');
    const id = seedRequest(connId, 'MANY-UNCH');
    db.claimRequestForExecution(id);
    db.finishDeployRequest(
      id,
      'executed',
      JSON.stringify({
        deployed: true,
        target_check: {
          status: 'not_checked',
          checked_at: '2026-11-15T10:05:00.000Z',
          checked: [],
          unchecked: ['C1', 'C2', 'C3', 'C4', 'C5'].map((name) => ({
            type: 'ApexClass',
            api_name: name,
            reason: 'live_check_unavailable_no_org_clock',
          })),
        },
      }),
    );
    expect(service.get(id).notices).toEqual([
      'Executed — the target was NOT re-checked before running (nothing could be compared — ' +
        'ApexClass C1: live_check_unavailable_no_org_clock; ' +
        'ApexClass C2: live_check_unavailable_no_org_clock; ' +
        'ApexClass C3: live_check_unavailable_no_org_clock; 2 more)',
    ]);
  });

  it("'not_applicable' (apex/bulk) is reported but raises no notice", () => {
    const connId = seedConnection('developer', 'dev-org');
    const id = seedRequest(connId, 'NAPP-LCBL');
    db.claimRequestForExecution(id);
    db.finishDeployRequest(
      id,
      'executed',
      JSON.stringify({
        executed: true,
        target_check: { status: 'not_applicable', note: 'no fixed org target to re-check' },
      }),
    );
    const view = service.get(id);
    expect(view.targetCheck).toMatchObject({
      status: 'not_applicable',
      note: 'no fixed org target to re-check',
    });
    expect(view.notices).toEqual([]);
  });
});

describe('S45: one decision per request at a time (the guard window)', () => {
  it('a second approve() or a reject() while the first approval re-checks the target is refused', async () => {
    const connId = seedConnection('developer', 'dev-org');
    const conn = db.resolveConnection(connId)!;
    db.updateGrants(connId, { ...conn.grants, data_write: true });
    const id = db.insertDeployRequest({
      connectionId: connId,
      kind: 'dml',
      confirmationCode: 'TWIC-EAPR',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      summaryJson: JSON.stringify({ operation: 'update', object: 'Account', row_count: 1 }),
    }).id;
    db.setDeployRequestDesktopFields(id, { sessionId: 'session-1', origin: 'desktop' });
    const audited: string[] = [];
    (deps as unknown as { audit: unknown }).audit = {
      record: (type: string) => {
        audited.push(type);
      },
    };
    const events: ChatEvent[] = [];
    service.attachSessions({ announce: (_s, e) => events.push(e) });
    let release!: () => void;
    const guard = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    (deps.deploys as unknown as { executeDml: unknown }).executeDml = async () => {
      calls++;
      // The execute-time guard's org read: the row stays 'validated' until the claim.
      await guard;
      const result = { executed: true };
      db.claimRequestForExecution(id);
      db.finishDeployRequest(id, 'executed', JSON.stringify(result));
      return result;
    };
    const held = service.interceptAgentExecute('session-1', 'dml', connId);
    const first = service.approve(id, 'go');
    expect(db.getDeployRequest(id)!.status).toBe('validated');
    expect(db.getDeployRequest(id)!.desktopState).toBe('approved');
    // A reloaded renderer reads this instead of its own (cleared) busy flag.
    expect(service.get(id).deciding).toBe(true);
    await expect(service.approve(id, 'again')).rejects.toThrow(/already being decided/);
    await expect(service.reject(id, 'no')).rejects.toThrow(/already being decided/);

    release();
    const view = await first;
    const result = await held!;
    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain('"approved": true');
    expect(calls).toBe(1);
    expect(audited.filter((t) => t === 'deploy.approved')).toHaveLength(1);
    expect(audited).not.toContain('deploy.rejected');
    expect(events.filter((e) => e.type === 'approval_resolved')).toEqual([
      { type: 'approval_resolved', requestId: id, outcome: 'executed' },
    ]);
    expect(db.getDeployRequest(id)!.approvedComment).toBe('go');
    expect(view.status).toBe('executed');
    expect(view.deciding).toBe(false);
    expect(service.list().find((v) => v.id === id)!.deciding).toBe(false);
  });

  it('a refused decision leaves nothing in flight: the request can be decided again', async () => {
    const connId = seedConnection('production', 'client-prod');
    const id = seedRequest(connId, 'RETR-YDEC');
    // Production without a comment throws inside the decision.
    await expect(service.approve(id, '  ')).rejects.toThrow(/comment/);
    expect(service.get(id).deciding).toBe(false);
    const view = await service.reject(id, 'not now');
    expect(view.desktopState).toBe('rejected');
    expect(view.deciding).toBe(false);
  });
});

describe('S45: the review panel says what was checked, and never more (renderer-free)', () => {
  it('an approval in flight reads as re-checking, never "Awaiting approval"', () => {
    const r = {
      kind: 'deploy' as const,
      status: 'validated' as const,
      desktopState: 'approved',
      targetMoved: null,
      deciding: true,
    };
    expect(stateLabel(r)).toBe('Approved — re-checking the target…');
    expect(stateLabel({ ...r, kind: 'apex' })).toBe('Approved — starting…');
    expect(stateLabel({ ...r, deciding: false, desktopState: 'awaiting_approval' })).toBe(
      'Awaiting approval',
    );
    expect(stateLabel({ ...r, status: 'executing' })).toBe('Executing…');
  });

  it("'ok' says what each kind compared: stamps (not bytes) for a deploy, values for DML", () => {
    const ok = (checked: number, unchecked = 0) => ({
      status: 'ok' as const,
      checkedAt: null,
      reason: null,
      note: null,
      checked: Array.from({ length: checked }, (_, i) => ({
        label: `ApexClass C${i}`,
        state: null,
        detail: null,
      })),
      unchecked: Array.from({ length: unchecked }, (_, i) => ({
        label: `Account 00${i}`,
        state: 'no_before_value_shown',
        detail: null,
      })),
    });
    expect(targetCheckHeadline('deploy', ok(2))).toBe(
      'Re-checked before executing — last-modified stamps of 2 member(s) unchanged (stamps, ' +
        "not bytes; a change during the org's own processing is not caught)",
    );
    expect(targetCheckHeadline('dml', ok(3))).toBe(
      'Re-checked before executing — values of 3 record(s) unchanged',
    );
    expect(targetCheckHeadline('activation', ok(1))).toBe(
      'Re-checked before executing — status unchanged',
    );
    // Every DML record unchecked for want of a shown before-value: never "0 compared".
    const none = targetCheckHeadline('dml', ok(0, 2));
    expect(none).toBe(
      'Re-checked before executing — the records still exist, but no approved values were ' +
        'shown to compare',
    );
    expect(none).not.toContain('0 ');
  });

  it('the target-moved lead never says "after validation"; an unknown outcome conditions its deletes', () => {
    expect(TARGET_MOVED_LEAD).not.toContain('after');
    expect(TARGET_MOVED_LEAD).toContain('could not rule a change out');
    expect(TARGET_MOVED_LEAD).toContain('did NOT execute');
    const m = { type: 'ApexClass', apiName: 'NewOne' };
    expect(revertDeleteLabel(m, 'executed')).toBe('delete ApexClass:NewOne (this deploy added it)');
    expect(revertDeleteLabel(m, 'unknown')).toBe(
      'delete ApexClass:NewOne (this deploy added it, if it committed)',
    );
  });
});
