import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ContrailDb,
  ContrailError,
  REBASELINE_PROGRESS,
  hhmm,
  policyChangedText,
  unmatchedRuleText,
  type ApprovalRequestView,
  type AuditLog,
  type ContrailConfig,
  type EngineDeps,
  type GovernanceState,
} from '@contrail/engine';
// The engine's own execute-result builder (not re-exported by the package
// index): the re-baseline note Deploy Review reads is the engine's text.
import { executeSnapshotResult } from '@contrail/engine/dist/snapshot/members.js';
import type { ChatEvent, DeployChangeView } from '@contrail/shared';
import { freezeOn, governanceEngine } from './governance-engine.js';
import {
  DeployService,
  NativeApprovalPresenter,
  executePolicyRefusalText,
  targetMovedRefusal,
} from '../main/services/deploys.js';
import {
  TARGET_MOVED_LEAD,
  approveDisabled,
  blockedAlsoFrozen,
  blockedClosingText,
  commentHint,
  commentLabel,
  commentPrefill,
  executeCheckText,
  expiredReviewText,
  freezeReviewNote,
  localStamp,
  rejectComment,
  revertDeleteLabel,
  snapshotRebaselineLines,
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
/** S46: the real governance engine's config (mutate `config.policies`) and audit log. */
let config: ContrailConfig;
let realAudit: AuditLog;

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
  // S46 (B): a REAL engine answers Deploy Review's change record and the
  // policy gate (governanceState, reviewGovernance) under the built-in rule;
  // only its org-facing execute calls are the stubs below.
  const gov = governanceEngine(db, tmp);
  config = gov.config;
  realAudit = gov.audit;
  const audit = gov.audit;
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
  const deploysEngine = Object.assign(gov.engine, {
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
  });
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
    // S46 (B): the mode the engine reads at mint — native keeps the code off
    // the phone push and records governance.surface 'native'.
    expect(presenter.mode).toBe('native');
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
      // S46: a pre-S46 summary has neither key.
      probeFailures: {},
      retrieveNote: null,
      members: 1,
    });
    expect(view.changes[0].preImage).toMatchObject({
      present: true,
      source: 'retrieve',
      // A pre-S46 pre-image names no stamp source (every stamp was listed).
      stampSource: null,
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
      stampSource: 'listMetadata',
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

describe('S46 D: stamp sources, absent members and the one dates line in the review', () => {
  const AT = '2026-11-17T15:02:00.000Z';
  /** The engine's dates-unavailable line around its groups (verbatim). */
  const datesLine = (groups: string): string =>
    `Live diff is against the org (retrieved ${hhmm(AT)}); last-modified stamps were ` +
    `unavailable for ${groups}, so CHANGED-IN-TARGET detection for those members relies on ` +
    'content only and the execute-time check will report them as unchecked.';
  const datesLines = (notices: string[]): string[] =>
    notices.filter((n) => n.startsWith('Live diff is against the org'));

  /** A pre-image as the S46 engine summarizes it (snake_case). */
  const pre = (over: Record<string, unknown> = {}) => ({
    present: true,
    source: 'retrieve',
    stamp_source: 'tooling:CustomField',
    sha256: 'ab'.repeat(32),
    last_modified_date: '2026-11-17T14:00:00.000Z',
    last_modified_by: 'Other User',
    comparable: true,
    restorable: true,
    ...over,
  });
  const undated = { last_modified_date: null, last_modified_by: null };
  const member = (type: string, apiName: string, preImage: Record<string, unknown>) => ({
    type,
    api_name: apiName,
    change: 'modify',
    warnings: [],
    pre_image: preImage,
  });
  const liveOk = (over: Record<string, unknown> = {}) => ({
    status: 'ok',
    started_at: '2026-11-17T15:01:00.000Z',
    at: AT,
    dates_unavailable_types: [],
    stamp_scheme: 2,
    members: 1,
    ...over,
  });

  /** A deploy validated OUTSIDE this app (no review_json), e.g. by the plugin. */
  function seedValidated(
    connId: string,
    code: string,
    summary: { changes?: unknown[]; destructive?: unknown[]; live_check: unknown },
  ): string {
    return db.insertDeployRequest({
      connectionId: connId,
      kind: 'deploy',
      confirmationCode: code,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      summaryJson: JSON.stringify({ changes: [], destructive: [], ...summary }),
    }).id;
  }

  it('view() maps the stamp source, the probe failures (strings only) and the retrieve note', () => {
    const connId = seedConnection('developer', 'dev-org');
    const note =
      "The org's retrieve returned 1 message(s) — reported as sent; Contrail does not decide " +
      'what exists from them: Entity of type CustomField named Invoice__c.New__c cannot be found';
    const id = seedValidated(connId, 'STMP-SRCE', {
      changes: [
        member('CustomField', 'Invoice__c.Amount__c', pre()),
        member('ApexClass', 'Foo', pre({ stamp_source: 'listMetadata' })),
      ],
      live_check: liveOk({
        dates_unavailable_types: ['ValidationRule'],
        probe_failures: { ValidationRule: 'no answer within 30 s', Odd: 42, Other: null },
        retrieve_note: note,
        members: 2,
      }),
    });
    const view = service.get(id);
    expect(view.changes.map((c) => c.preImage?.stampSource)).toEqual([
      'tooling:CustomField',
      'listMetadata',
    ]);
    expect(view.liveCheck).toMatchObject({
      status: 'ok',
      datesUnavailableTypes: ['ValidationRule'],
      probeFailures: { ValidationRule: 'no answer within 30 s' },
      retrieveNote: note,
    });
    expect(Object.keys(view.liveCheck!.probeFailures)).toEqual(['ValidationRule']);
    // The org's retrieve messages ride the view for the raw detail only:
    // never a notice (an ADD's "cannot be found" would read as a verdict).
    expect(view.notices.join('\n')).not.toContain('cannot be found');
    expect(view.notices.join('\n')).not.toContain("The org's retrieve returned");
    expect(JSON.stringify(view)).not.toContain('STMP-SRCE');
  });

  it('a row carrying only a retrieve note raises no notice of its own', () => {
    const connId = seedConnection('developer', 'dev-org');
    const note =
      "The org's retrieve returned 2 message(s) — reported as sent; Contrail does not decide " +
      'what exists from them: a | b';
    const id = seedValidated(connId, 'NOTE-ONLY', {
      changes: [member('CustomField', 'Invoice__c.Amount__c', pre())],
      live_check: liveOk({ retrieve_note: note }),
    });
    const view = service.get(id);
    expect(view.liveCheck?.retrieveNote).toBe(note);
    expect(datesLines(view.notices)).toEqual([]);
    for (const n of view.notices) {
      expect(n).not.toContain("The org's retrieve returned");
      expect(n).not.toContain('a | b');
    }
  });

  it('a failed stamp query is named with its own reason — never "listMetadata reported INVALID_TYPE"', () => {
    const connId = seedConnection('developer', 'dev-org');
    const reason = 'Salesforce API error 500 on /services/data/v66.0/tooling/query: oops';
    const id = seedValidated(connId, 'PROB-FAIL', {
      // Its type's query failed: undated, but never "returned no usable stamp".
      changes: [member('CustomField', 'Account.Tier__c', pre(undated))],
      live_check: liveOk({
        dates_unavailable_types: ['CustomField'],
        probe_failures: { CustomField: reason },
      }),
    });
    const notices = service.get(id).notices;
    expect(datesLines(notices)).toEqual([
      datesLine(`CustomField (the stamp query failed: ${reason})`),
    ]);
    expect(notices.join('\n')).not.toContain('INVALID_TYPE');
    expect(notices.join('\n')).not.toContain('returned no usable stamp');
  });

  it('a standard field has no stamp query; a probeable undated member had no usable stamp', () => {
    const connId = seedConnection('developer', 'dev-org');
    const standard = seedValidated(connId, 'STND-FLD1', {
      changes: [member('CustomField', 'Account.Industry', pre(undated))],
      live_check: liveOk(),
    });
    const standardNotices = service.get(standard).notices;
    expect(datesLines(standardNotices)).toEqual([
      datesLine('CustomField Account.Industry (Contrail has no stamp query for them)'),
    ]);
    expect(standardNotices.join('\n')).not.toContain('returned no');

    const noStamp = seedValidated(connId, 'NOST-AMP1', {
      changes: [
        member('CustomField', 'Invoice__c.Amount__c', pre(undated)),
        // Not dated by a stamp query (listed): its gaps reach the line
        // through dates_unavailable_types, never as a member group.
        member('ApexClass', 'Foo', pre({ stamp_source: 'listMetadata', ...undated })),
      ],
      destructive: [
        // Absent at validate: nothing to stamp, so nothing to disclose.
        {
          ...member('CustomField', 'Invoice__c.Gone__c', pre({ present: false, ...undated })),
          change: 'delete',
        },
      ],
      live_check: liveOk({ members: 3 }),
    });
    expect(datesLines(service.get(noStamp).notices)).toEqual([
      datesLine(
        'CustomField Invoice__c.Amount__c (the stamp query returned no usable stamp for them)',
      ),
    ]);
  });

  it('every reason at once is still ONE line, its groups in the engine order', () => {
    const connId = seedConnection('developer', 'dev-org');
    const id = seedValidated(connId, 'ONEL-INE1', {
      changes: [
        member('BotVersion', 'Agent.v1', pre({ stamp_source: 'listMetadata', ...undated })),
        member(
          'ValidationRule',
          'Invoice__c.Positive_Amount',
          pre({ stamp_source: 'tooling:ValidationRule', ...undated }),
        ),
        member('CustomField', 'Account.Industry', pre(undated)),
        member('CustomField', 'Invoice__c.Amount__c', pre(undated)),
        member('CustomField', 'Invoice__c.Dated__c', pre()),
      ],
      live_check: liveOk({
        dates_unavailable_types: ['BotVersion', 'ValidationRule'],
        probe_failures: { ValidationRule: 'no answer within 30 s' },
        members: 5,
      }),
    });
    const notices = service.get(id).notices;
    expect(datesLines(notices)).toEqual([
      datesLine(
        'BotVersion (listMetadata reported INVALID_TYPE); ' +
          'ValidationRule (the stamp query failed: no answer within 30 s); ' +
          'CustomField Account.Industry (Contrail has no stamp query for them); ' +
          'CustomField Invoice__c.Amount__c (the stamp query returned no usable stamp for them)',
      ),
    ]);
    // The other notice is the outside-the-app one; no second dates line.
    expect(notices).toHaveLength(2);
    expect(notices[0]).toMatch(/^Validated outside the app/);
  });

  it('a member no stamp query named is said so even when the query of its OWN type failed', () => {
    const connId = seedConnection('developer', 'dev-org');
    const reason = 'Salesforce API error 500 on /services/data/v66.0/tooling/query: stamp query down';
    const id = seedValidated(connId, 'OWNT-FAIL', {
      changes: [
        // The custom field's query failed; nothing was asked about the
        // standard field, so the failure must not swallow it.
        member('CustomField', 'Invoice__c.Status__c', pre(undated)),
        member('CustomField', 'Account.Industry', pre(undated)),
      ],
      live_check: liveOk({
        dates_unavailable_types: ['CustomField'],
        probe_failures: { CustomField: reason },
        members: 2,
      }),
    });
    const lines = datesLines(service.get(id).notices);
    expect(lines).toEqual([
      datesLine(
        `CustomField (the stamp query failed: ${reason}); ` +
          'CustomField Account.Industry (Contrail has no stamp query for them)',
      ),
    ]);
    // The type's group covers the custom field: it is not listed twice.
    expect(lines[0]).not.toContain('Invoice__c.Status__c');
    expect(lines[0]).not.toContain('returned no usable stamp');
  });

  it('a long member group names the first ten and counts the rest', () => {
    const connId = seedConnection('developer', 'dev-org');
    const standard = Array.from(
      { length: 12 },
      (_, i) => `Account.Std${String(i + 1).padStart(2, '0')}`,
    );
    const custom = Array.from(
      { length: 11 },
      (_, i) => `Invoice__c.Field${String(i + 1).padStart(2, '0')}__c`,
    );
    const id = seedValidated(connId, 'LONG-GRP1', {
      changes: [...standard, ...custom].map((n) => member('CustomField', n, pre(undated))),
      live_check: liveOk({ members: 23 }),
    });
    const firstTen = (names: string[]): string =>
      names
        .slice(0, 10)
        .map((n) => `CustomField ${n}`)
        .join(', ');
    expect(datesLines(service.get(id).notices)).toEqual([
      datesLine(
        `${firstTen(standard)} and 2 more (Contrail has no stamp query for them); ` +
          `${firstTen(custom)} and 1 more (the stamp query returned no usable stamp for them)`,
      ),
    ]);
  });

  it('a thrown listing names only the listing-sourced member types', () => {
    const connId = seedConnection('developer', 'dev-org');
    const id = seedValidated(connId, 'LIST-PROB', {
      changes: [
        member('ApexClass', 'Foo', pre({ stamp_source: 'listMetadata', ...undated })),
        member('CustomField', 'Invoice__c.Amount__c', pre()),
      ],
      live_check: liveOk({ dates_unavailable: 'listMetadata failed: HTTP 500', members: 2 }),
    });
    expect(datesLines(service.get(id).notices)).toEqual([
      datesLine('ApexClass (listMetadata failed: HTTP 500)'),
    ]);
  });

  it('a row this app presented keeps the page line it stored — no second one', () => {
    const connId = seedConnection('developer', 'dev-org');
    const id = seedValidated(connId, 'PRES-ENTD', {
      changes: [member('CustomField', 'Account.Industry', pre(undated))],
      live_check: liveOk(),
    });
    const pageLine = datesLine(
      'CustomField Account.Industry (Contrail has no stamp query for them)',
    );
    const presenter = new NativeApprovalPresenter();
    presenter.attach(service);
    service.expectPresentation('session-1', connId);
    void presenter.present({
      requestId: id,
      kind: 'deploy',
      code: 'PRES-ENTD',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      org: { alias: 'dev-org', orgName: 'Dev', orgType: 'developer', instanceUrl: 'https://x' },
      changes: [{ label: 'MODIFY CustomField:Account.Industry', warnings: [] }],
      destructive: [],
      results: [],
      blast: [],
      warnings: [pageLine],
    });
    const view = service.get(id);
    expect(view.warnings).toEqual([pageLine]);
    expect(datesLines(view.notices)).toEqual([]);
    expect(JSON.stringify(view)).not.toContain('PRES-ENTD');
  });

  it('a checked member the approval assumed absent reads as absent; the headline counts it apart', () => {
    const connId = seedConnection('developer', 'dev-org');
    const id = seedRequest(connId, 'ABSN-CHEK');
    db.claimRequestForExecution(id);
    const checkedAt = '2026-11-17T15:10:00.000Z';
    db.finishDeployRequest(
      id,
      'executed',
      JSON.stringify({
        deployed: true,
        target_check: {
          status: 'ok',
          checked_at: checkedAt,
          checked: [
            { type: 'ApexClass', api_name: 'Foo' },
            { type: 'CustomField', api_name: 'Account.Tier__c', absent: true },
            // Anything but `true` is not the marker.
            { type: 'ApexClass', api_name: 'Bar', absent: 'yes' },
          ],
          unchecked: [
            { type: 'CustomField', api_name: 'Account.Rank__c', reason: 'stamp_row_unmatched' },
          ],
        },
      }),
    );
    const view = service.get(id);
    expect(view.targetCheck?.checked).toEqual([
      { label: 'ApexClass Foo', state: null, detail: null },
      { label: 'CustomField Account.Tier__c', state: 'absent', detail: null },
      { label: 'ApexClass Bar', state: null, detail: null },
    ]);
    // The engine's reason code, printed as it is.
    expect(view.targetCheck?.unchecked).toEqual([
      { label: 'CustomField Account.Rank__c', state: 'stamp_row_unmatched', detail: null },
    ]);
    expect(targetCheckHeadline('deploy', view.targetCheck!)).toBe(
      `Re-checked before executing at ${new Date(checkedAt).toLocaleTimeString()} — ` +
        'last-modified stamps of 2 member(s) unchanged, and the execute-time read returned ' +
        'nothing for 1 member(s) the approval assumed absent (stamps, not bytes; a change ' +
        "during the org's own processing is not caught)",
    );
    // A passed check raises no notice.
    expect(view.notices).toEqual([]);
    expect(JSON.stringify(view)).not.toContain('ABSN-CHEK');
  });

  it("a stranded deploy's stored check keeps its absent marker on the panel", () => {
    const connId = seedConnection('developer', 'dev-org');
    const requestId = seedRequest(connId, 'STRA-ABSN');
    db.claimRequestForExecution(requestId);
    const check = {
      status: 'ok',
      checked_at: '2026-11-17T15:10:00.000Z',
      checked: [{ type: 'CustomField', api_name: 'Account.Tier__c', absent: true }],
      unchecked: [],
    };
    (deps.deploys as unknown as { finalizeStrandedRevert: unknown }).finalizeStrandedRevert = (
      id: string,
      error: string,
    ) => {
      strandedFinalized.push({ requestId: id, error, statusAtCall: 'executing' });
      return { revert_package: null, revert_note: 'No revert package.', target_check: check };
    };
    expect(service.reconcileStrandedExecutions(-1)).toBe(1);
    const view = service.get(requestId);
    expect(view.status).toBe('execution_failed');
    expect(view.targetCheck?.checked).toEqual([
      { label: 'CustomField Account.Tier__c', state: 'absent', detail: null },
    ]);
    expect(targetCheckHeadline('deploy', view.targetCheck!)).toContain(
      '1 member(s) the approval assumed absent: the execute-time read returned nothing for them',
    );
    // 'ok' raises no not-re-checked notice, stranded or not.
    expect(view.notices).toEqual([]);
  });

  it('the headline variants say what was read, never "absent at validate" (renderer-free)', () => {
    const check = (stamped: number, absent: number) => ({
      status: 'ok' as const,
      checkedAt: null,
      reason: null,
      note: null,
      checked: [
        ...Array.from({ length: stamped }, (_, i) => ({
          label: `ApexClass C${i}`,
          state: null,
          detail: null,
        })),
        ...Array.from({ length: absent }, (_, i) => ({
          label: `CustomField Account.New${i}__c`,
          state: 'absent',
          detail: null,
        })),
      ],
      unchecked: [],
    });
    const none = targetCheckHeadline('deploy', check(3, 0));
    const both = targetCheckHeadline('deploy', check(2, 1));
    const onlyAbsent = targetCheckHeadline('deploy', check(0, 2));
    expect(none).toBe(
      'Re-checked before executing — last-modified stamps of 3 member(s) unchanged (stamps, ' +
        "not bytes; a change during the org's own processing is not caught)",
    );
    expect(both).toBe(
      'Re-checked before executing — last-modified stamps of 2 member(s) unchanged, and the ' +
        'execute-time read returned nothing for 1 member(s) the approval assumed absent ' +
        "(stamps, not bytes; a change during the org's own processing is not caught)",
    );
    expect(onlyAbsent).toBe(
      'Re-checked before executing — 2 member(s) the approval assumed absent: the ' +
        'execute-time read returned nothing for them (no stamp was compared; a change during ' +
        "the org's own processing is not caught)",
    );
    for (const text of [both, onlyAbsent]) {
      expect(text).toContain('the approval assumed absent');
      expect(text).toContain('the execute-time read returned nothing for');
    }
    for (const text of [none, both, onlyAbsent]) {
      expect(text).not.toContain('absent at validate');
      expect(text).not.toContain('the org has none');
      expect(text).not.toContain('0 member(s)');
    }
    // Only absent members is still a check that ran, never "nothing could be compared".
    expect(onlyAbsent).not.toContain('nothing could be compared');
  });
});

// ── S46 (B): the change record in Deploy Review ─────────────────────────

describe('S46 B: the change record — the justification is the approval comment', () => {
  const DRAFT = 'The client asked for the invoice fix to reach their org before month end.';
  const RULE = 'acme justification';
  const JUSTIFY = { rules: [{ name: RULE, match: { connections: ['acme-*'] }, requireJustification: true }] };

  /** A request minted by 0.40: its governance record as mintGovernance stores it. */
  function seedGoverned(
    connId: string,
    over: {
      justification?: Record<string, unknown> | null;
      ticket?: string | null;
      destructive?: boolean;
      code?: string;
      sessionId?: string;
      expiresAt?: string;
    } = {},
  ): string {
    const conn = db.getConnection(connId)!;
    const rec = db.insertDeployRequest({
      connectionId: connId,
      kind: 'deploy',
      confirmationCode: over.code ?? 'GOVR-NNCE',
      expiresAt: over.expiresAt ?? new Date(Date.now() + 3_600_000).toISOString(),
      summaryJson: JSON.stringify({
        changes: [{ type: 'ApexClass', api_name: 'InvoiceService', change: 'modify', warnings: [] }],
        destructive: [],
        blast: [],
        governance: {
          v: 1,
          surface: 'native',
          target: {
            alias: conn.alias,
            org_id: conn.orgId,
            org_name: conn.orgName,
            org_type: conn.orgType,
            username: conn.username,
          },
          ticket: over.ticket ?? null,
          justification:
            over.justification === undefined ? { text: DRAFT, source: 'agent' } : over.justification,
          inputs: { destructive: over.destructive ?? false, test_level: null },
          policy: {
            evaluated_at: new Date().toISOString(),
            source: 'config',
            sha256: 'x'.repeat(64),
            rules: [],
            requirements: {
              justification: false,
              ticket: false,
              ticketPatterns: [],
              denyDestructiveMetadata: false,
              denyDataDeletes: false,
              denyAnonymousApex: false,
              minTestLevel: null,
            },
            lines: [],
          },
          freeze: null,
          freeze_override: null,
          execute_check: null,
        },
      }),
    });
    if (over.sessionId) db.setDeployRequestDesktopFields(rec.id, { sessionId: over.sessionId });
    return rec.id;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const governanceOf = (id: string) => JSON.parse(db.getDeployRequest(id)!.summaryJson).governance as any;
  const detailOf = (eventType: string) =>
    realAudit.query({ eventType }).map((e) => e.detail as Record<string, unknown>);

  it('view().governance carries the agent draft, its provenance, the ticket and the policies — never the code', () => {
    config.policies = JUSTIFY;
    const connId = seedConnection('developer', 'acme-dev');
    const id = seedGoverned(connId, { ticket: 'ACME-42', code: 'VIEW-CODE' });
    const view = service.get(id);
    const g = view.governance!;
    expect(g.ticket).toBe('ACME-42');
    expect(g.justification).toEqual({
      text: DRAFT,
      source: 'agent',
      provenance: 'Drafted by the agent. Edit it if it is not what you would say.',
    });
    expect(g.justificationRequired).toBe(true);
    expect(g.policySource).toBe('config');
    expect(g.policyLines).toEqual([`A justification is required (rule "${RULE}").`]);
    expect(g.gate).toBe('open');
    expect(g.blockedBy).toBeNull();
    expect(g.reasonMin).toBe(15);
    expect(JSON.stringify(view)).not.toContain('VIEW-CODE');
    // The list carries it too (deploys:changed refreshes read it).
    expect(service.list().find((r) => r.id === id)!.governance!.ticket).toBe('ACME-42');

    // The review prefills the comment with the draft and says whose it is.
    expect(commentPrefill(g)).toBe(DRAFT);
    expect(commentLabel(false, g)).toBe('Approval comment (REQUIRED by policy)');
    expect(commentLabel(true, g)).toBe('Approval comment (REQUIRED for production)');
    expect(commentHint(g, DRAFT)).toBe(
      'Drafted by the agent — edit it if it is not what you would say. Approving records it as ' +
        'your approval comment; Reject sends a reason only if you type one over it.',
    );
    expect(commentHint(g, 'Something else.')).toBe('Edited — recorded as typed in Deploy Review.');
    expect(commentHint(g, '')).toBeNull();
  });

  it('approving the draft unchanged confirms it — source agent, confirmed_at, comment_source agent_draft_unchanged', async () => {
    config.policies = JUSTIFY;
    const connId = seedConnection('developer', 'acme-dev');
    const id = seedGoverned(connId, { code: 'CONF-IRMD' });
    await service.approve(id, DRAFT);
    expect(executed).toEqual([{ connId, code: 'CONF-IRMD' }]);
    const j = governanceOf(id).justification;
    expect(j).toMatchObject({ text: DRAFT, source: 'agent' });
    expect(typeof j.confirmed_at).toBe('string');
    expect(detailOf('deploy.approved')[0]).toMatchObject({
      requestId: id,
      comment: DRAFT,
      comment_source: 'agent_draft_unchanged',
    });
    expect(detailOf('approval.justification_edited')).toEqual([]);
    expect(service.get(id).governance!.justification!.provenance).toMatch(
      /^Drafted by the agent; approved unchanged in Deploy Review at \d\d:\d\d\.$/,
    );
  });

  it("approving edited text records the human's words — source page, surface deploy_review, the draft kept", async () => {
    config.policies = JUSTIFY;
    const connId = seedConnection('developer', 'acme-dev');
    const id = seedGoverned(connId);
    const words = 'Finance signed off on this fix today; it unblocks the month-end run.';
    await service.approve(id, words);
    const j = governanceOf(id).justification;
    expect(j).toMatchObject({
      text: words,
      source: 'page',
      surface: 'deploy_review',
      agent_draft: DRAFT,
    });
    expect(typeof j.edited_at).toBe('string');
    expect(detailOf('deploy.approved')[0]).toMatchObject({ comment_source: 'typed' });
    const edited = detailOf('approval.justification_edited');
    expect(edited).toEqual([
      {
        requestId: id,
        kind: 'deploy',
        surface: 'deploy_review',
        chars: words.length,
        had_agent_draft: true,
      },
    ]);
    // The audit row carries the length, never the text.
    expect(JSON.stringify(edited)).not.toContain('Finance signed off');
    // Like every other Deploy Review audit row, its tool is the screen; the
    // surface in its detail stays 'deploy_review'.
    expect(realAudit.query({ eventType: 'approval.justification_edited' }).map((e) => e.tool)).toEqual([
      'deploy_review_screen',
    ]);
  });

  it('a text typed earlier on the approval page, approved unchanged, is left as it is — human_text_unchanged', async () => {
    config.policies = JUSTIFY;
    const connId = seedConnection('developer', 'acme-dev');
    const typed = {
      text: 'Typed by the human on the localhost page.',
      source: 'page',
      surface: 'approval_page',
      edited_at: '2026-11-18T09:03:00.000Z',
      agent_draft: DRAFT,
    };
    const id = seedGoverned(connId, { justification: typed });
    const g = service.get(id).governance!;
    expect(commentPrefill(g)).toBe(typed.text);
    expect(commentHint(g, typed.text)).toBe(
      `${g.justification!.provenance} Reject sends a reason only if you type one over it.`,
    );
    expect(g.justification!.provenance).toMatch(/^Typed on the approval page at \d\d:\d\d\.$/);
    await service.approve(id, typed.text);
    expect(governanceOf(id).justification).toEqual(typed);
    expect(detailOf('deploy.approved')[0]).toMatchObject({ comment_source: 'human_text_unchanged' });
    expect(detailOf('approval.justification_edited')).toEqual([]);
  });

  it('a text typed earlier in Deploy Review itself, approved unchanged, is typed — never "typed on the approval page"', async () => {
    // An earlier approval stored the human's words, then did not reach
    // execution (an execute-time refusal, or the app quit); the retry
    // prefills them and the human approves them as they are.
    config.policies = JUSTIFY;
    const connId = seedConnection('developer', 'acme-dev');
    const typed = {
      text: 'Typed by the human in Deploy Review on the first attempt.',
      source: 'page',
      surface: 'deploy_review',
      edited_at: '2026-11-18T09:03:00.000Z',
      agent_draft: DRAFT,
    };
    const id = seedGoverned(connId, { justification: typed, code: 'RETR-YTYP' });
    expect(commentPrefill(service.get(id).governance!)).toBe(typed.text);
    await service.approve(id, typed.text);
    expect(executed).toEqual([{ connId, code: 'RETR-YTYP' }]);
    // Nothing new is written: the stored record already says where it was typed.
    expect(governanceOf(id).justification).toEqual(typed);
    expect(detailOf('deploy.approved')[0]).toMatchObject({
      requestId: id,
      comment: typed.text,
      comment_source: 'typed',
    });
    expect(detailOf('approval.justification_edited')).toEqual([]);
  });

  it('deleting the prefilled draft and approving with no comment records the justification as cleared in Deploy Review', async () => {
    // No rule requires a justification here, so an empty comment is allowed.
    config.policies = { rules: [] };
    const connId = seedConnection('developer', 'acme-dev');
    const id = seedGoverned(connId, { code: 'CLER-DRFT' });
    const g = service.get(id).governance!;
    expect(g.justificationRequired).toBe(false);
    expect(approveDisabled({ busy: false, isProd: false, governance: g, comment: '', reason: '' })).toBe(false);
    await service.approve(id);
    expect(executed).toEqual([{ connId, code: 'CLER-DRFT' }]);
    const j = governanceOf(id).justification;
    expect(j).toMatchObject({ text: '', source: 'page', surface: 'deploy_review', agent_draft: DRAFT });
    expect(typeof j.edited_at).toBe('string');
    expect(detailOf('approval.justification_edited')).toEqual([
      { requestId: id, kind: 'deploy', surface: 'deploy_review', chars: 0, had_agent_draft: true },
    ]);
    const approved = detailOf('deploy.approved')[0]!;
    expect(approved).toMatchObject({ requestId: id, comment: null });
    expect('comment_source' in approved).toBe(false);
    expect(service.get(id).governance!.justification!.provenance).toMatch(
      /^Cleared in Deploy Review at \d\d:\d\d\.$/,
    );
  });

  it('validate first, write once: a frozen request approved with no reason is refused and NOTHING is written', async () => {
    config.policies = { rules: [...JUSTIFY.rules, ...freezeOn('acme-*').rules] };
    const connId = seedConnection('developer', 'acme-dev');
    const id = seedGoverned(connId, { sessionId: 's-frozen' });
    const before = db.getDeployRequest(id)!.summaryJson;
    const held = service.interceptAgentExecute('s-frozen', 'deploy', connId);
    expect(held).not.toBeNull();
    let settled = false;
    void held!.then(() => (settled = true));

    const g = service.get(id).governance!;
    expect(g.gate).toBe('frozen');
    expect(g.freezeLine).toContain('acme freeze');
    const gate = (reason: string) =>
      approveDisabled({ busy: false, isProd: false, governance: g, comment: DRAFT, reason });
    expect(gate('')).toBe(true);
    expect(gate('x'.repeat(14))).toBe(true);
    expect(gate('x'.repeat(15))).toBe(false);

    await expect(service.approve(id, DRAFT)).rejects.toThrow(/freeze/i);
    await expect(service.approve(id, DRAFT, 'too short 14ch')).rejects.toThrow(/at least 15 characters/);
    expect(executed).toEqual([]);
    // Byte-identical: no confirmed_at, no override, no decision.
    expect(db.getDeployRequest(id)!.summaryJson).toBe(before);
    expect(db.getDeployRequest(id)!.desktopState).toBe(null);
    expect(detailOf('approval.justification_edited')).toEqual([]);
    expect(detailOf('policy.freeze_overridden')).toEqual([]);
    expect(detailOf('deploy.approved')).toEqual([]);
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false); // the held agent call stays held
    service.releaseHeldForSession('s-frozen');
  });

  it('validate first, write once: a blocked gate refuses an edited comment with the policy lines, writing nothing', async () => {
    config.policies = {
      rules: [{ name: 'acme no deletes', match: { connections: ['acme-*'] }, denyDestructiveMetadata: true }],
    };
    const connId = seedConnection('developer', 'acme-dev');
    const id = seedGoverned(connId, { destructive: true });
    const before = db.getDeployRequest(id)!.summaryJson;
    const g = service.get(id).governance!;
    expect(g.gate).toBe('blocked');
    expect(g.blockedBy).toBe('violations');
    expect(g.blockedOnlyByJustification).toBe(false);
    expect(g.blockedLines).toHaveLength(1);
    expect(
      approveDisabled({ busy: false, isProd: false, governance: g, comment: 'edited words', reason: '' }),
    ).toBe(true);
    await expect(service.approve(id, 'Edited words, typed by the human.')).rejects.toThrow(
      g.blockedLines[0]!,
    );
    expect(executed).toEqual([]);
    expect(db.getDeployRequest(id)!.summaryJson).toBe(before);
    expect(detailOf('approval.justification_edited')).toEqual([]);
  });

  it('a row with no justification under a rule that now requires one is approved once the human types a comment', async () => {
    config.policies = JUSTIFY;
    const connId = seedConnection('developer', 'acme-dev');
    const id = seedGoverned(connId, { justification: null, code: 'TYPE-DONE' });
    const g = service.get(id).governance!;
    expect(g.justification).toBeNull();
    expect(g.gate).toBe('blocked');
    expect(g.blockedOnlyByJustification).toBe(true);
    // No freeze behind the block: the comment alone releases it.
    expect(g.freezeActive).toBe(false);
    expect(blockedAlsoFrozen(g)).toBe(false);
    expect(blockedClosingText(g, true)).not.toContain('freeze');
    expect(commentPrefill(g)).toBe('');
    expect(approveDisabled({ busy: false, isProd: false, governance: g, comment: '', reason: '' })).toBe(true);
    expect(approveDisabled({ busy: false, isProd: false, governance: g, comment: 'why', reason: '' })).toBe(
      false,
    );

    // No comment: the policy refuses, nothing is written.
    const before = db.getDeployRequest(id)!.summaryJson;
    await expect(service.approve(id)).rejects.toThrow(/requires a justification/);
    expect(db.getDeployRequest(id)!.summaryJson).toBe(before);

    const words = 'The client needs this before their auditors arrive on Monday.';
    await service.approve(id, words);
    expect(executed).toEqual([{ connId, code: 'TYPE-DONE' }]);
    const j = governanceOf(id).justification;
    expect(j).toMatchObject({ text: words, source: 'page', surface: 'deploy_review' });
    expect('agent_draft' in j).toBe(false);
  });

  it('a pre-0.40 production row (no governance) still needs the comment, which the built-in rule then takes as its justification', async () => {
    const connId = seedConnection('production', 'client-prod');
    const id = seedRequest(connId);
    const g = service.get(id).governance!;
    expect(g.policySource).toBe('config');
    expect(g.gate).toBe('blocked');
    expect(g.blockedOnlyByJustification).toBe(true);
    await expect(service.approve(id, '  ')).rejects.toThrow(
      'Production deploys require an approval comment.',
    );
    await service.approve(id, 'change window approved by client');
    expect(executed).toHaveLength(1);
    expect(governanceOf(id).justification).toMatchObject({
      text: 'change window approved by client',
      source: 'page',
      surface: 'deploy_review',
    });
  });

  it('a pre-0.40 production row blocked only for its justification during a freeze asks for the emergency reason too, and approves with both', async () => {
    // The built-in rule (production needs a justification) plus a freeze:
    // the row predates 0.40, so it has no justification and is blocked; the
    // freeze is in effect behind the block.
    config.policies = { rules: [...config.policies.rules, ...freezeOn('client-*').rules] };
    const REASON = 'P1 outage, checkout is down';
    const words = 'The client needs this before their auditors arrive on Monday.';
    const connId = seedConnection('production', 'client-prod');
    const id = seedRequest(connId, 'FRZN-JUST');
    const g = service.get(id).governance!;
    expect(g.gate).toBe('blocked');
    expect(g.blockedOnlyByJustification).toBe(true);
    expect(g.freezeActive).toBe(true);
    expect(g.override).toBeNull();
    expect(g.freezeLine).toContain('acme freeze');
    expect(blockedAlsoFrozen(g)).toBe(true);
    expect(blockedClosingText(g, true)).toBe(
      "This request does not satisfy this connection's policies as they stand now: it needs a " +
        'justification. Type it as the approval comment below — Approve records it with the ' +
        'request. A change freeze is also in effect on this connection, so Approve also needs an ' +
        'emergency reason, typed below. It is recorded in the audit log as a freeze override for ' +
        'this request only; the freeze itself stays configured.',
    );
    // Approve waits for both: the justification and an emergency reason long enough.
    const gate = (comment: string, reason: string) =>
      approveDisabled({ busy: false, isProd: true, governance: g, comment, reason });
    expect(gate('', REASON)).toBe(true);
    expect(gate(words, '')).toBe(true);
    expect(gate(words, 'x'.repeat(14))).toBe(true);
    expect(gate(words, 'x'.repeat(15))).toBe(false);

    // The justification alone: main re-evaluates, the freeze holds it — refused, nothing written.
    const before = db.getDeployRequest(id)!.summaryJson;
    await expect(service.approve(id, words)).rejects.toThrow(/freeze/i);
    expect(executed).toEqual([]);
    expect(db.getDeployRequest(id)!.summaryJson).toBe(before);
    expect(db.getDeployRequest(id)!.desktopState).toBe(null);
    expect(detailOf('approval.justification_edited')).toEqual([]);
    expect(detailOf('policy.freeze_overridden')).toEqual([]);
    expect(detailOf('deploy.approved')).toEqual([]);

    // Both: ONE write records the justification and the freeze override, then it executes.
    await service.approve(id, words, REASON);
    expect(executed).toEqual([{ connId, code: 'FRZN-JUST' }]);
    const recorded = governanceOf(id);
    expect(recorded.justification).toMatchObject({
      text: words,
      source: 'page',
      surface: 'deploy_review',
    });
    expect(recorded.freeze_override).toMatchObject({
      reason: REASON,
      surface: 'deploy_review',
      rule: 'acme freeze',
    });
    expect(detailOf('approval.justification_edited')).toHaveLength(1);
    expect(detailOf('policy.freeze_overridden')).toEqual([
      expect.objectContaining({ requestId: id, surface: 'deploy_review', reason: REASON }),
    ]);
    // Both rows are labelled with the screen, like every other Deploy Review row.
    expect(realAudit.query({ eventType: 'policy.freeze_overridden' }).map((e) => e.tool)).toEqual([
      'deploy_review_screen',
    ]);
    expect(realAudit.query({ eventType: 'approval.justification_edited' }).map((e) => e.tool)).toEqual([
      'deploy_review_screen',
    ]);
    expect(detailOf('deploy.approved')[0]).toMatchObject({ requestId: id, comment_source: 'typed' });
  });

  it('Reject never relays the prefilled draft as the reason; words typed over it are relayed', async () => {
    config.policies = JUSTIFY;
    const connId = seedConnection('developer', 'acme-dev');
    const id = seedGoverned(connId, { sessionId: 's-rej' });
    const held = service.interceptAgentExecute('s-rej', 'deploy', connId);
    await service.reject(id, DRAFT);
    const result = await held!;
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('REJECTED');
    expect(result.content[0]!.text).not.toContain('reason:');
    expect(db.getDeployRequest(id)!.approvedComment).toBeNull();
    expect(detailOf('deploy.rejected')[0]).toMatchObject({ requestId: id, comment: null });
    // The renderer sends '' for an untouched draft anyway.
    expect(rejectComment(DRAFT, DRAFT)).toBe('');
    expect(rejectComment(`  ${DRAFT}  `, DRAFT)).toBe('');
    expect(rejectComment('wrong org', DRAFT)).toBe('wrong org');

    const id2 = seedGoverned(connId, { sessionId: 's-rej2', code: 'REJE-CTED' });
    const held2 = service.interceptAgentExecute('s-rej2', 'deploy', connId);
    await service.reject(id2, 'wrong org');
    expect((await held2!).content[0]!.text).toContain('reason: wrong org');
    expect(db.getDeployRequest(id2)!.approvedComment).toBe('wrong org');

    // An edited justification's agent_draft is never a reason either.
    const id3 = seedGoverned(connId, {
      code: 'REJE-DRFT',
      justification: { text: 'typed', source: 'page', surface: 'approval_page', agent_draft: DRAFT },
    });
    await service.reject(id3, DRAFT);
    expect(db.getDeployRequest(id3)!.approvedComment).toBeNull();

    // No comment at all: unchanged.
    const id4 = seedGoverned(connId, { code: 'REJE-NONE' });
    await service.reject(id4);
    expect(db.getDeployRequest(id4)!.approvedComment).toBeNull();
    expect(executed).toEqual([]);
  });

  it('views: the policies-changed line and the unmatched-rule lines are live state — never in summary_json', () => {
    config.policies = JUSTIFY;
    const connId = seedConnection('developer', 'acme-dev');
    const id = seedGoverned(connId);
    // The first policies ever seen are not a change.
    expect(service.get(id).governance!.policyChangedLine).toBeNull();

    config.policies = {
      rules: [
        ...JUSTIFY.rules,
        { name: 'old client rule', match: { connections: ['globex-*'] }, requireTicket: true },
      ],
    };
    const g = service.get(id).governance!;
    const seen = realAudit
      .query({ eventType: 'policy.config_seen' })
      .find((e) => e.detail?.changed === true)!;
    expect(g.policyChangedLine).toBe(policyChangedText(seen.ts));
    expect(g.unmatchedRuleLines).toEqual([unmatchedRuleText('old client rule')]);
    const stored = db.getDeployRequest(id)!.summaryJson;
    expect(stored).not.toContain('Contrail noticed');
    expect(stored).not.toContain('Not applied to any connection');
  });

  it("an executed request's view carries its execute-time policy check and the recorded override", async () => {
    config.policies = { rules: [...JUSTIFY.rules, ...freezeOn('acme-*').rules] };
    const connId = seedConnection('developer', 'acme-dev');
    const id = seedGoverned(connId, { code: 'EXCK-0001' });
    expect(service.get(id).governance!.executeCheck).toBeNull();
    // The stub execute records what claimCode's patch records (the engine
    // twins pin that write; this pins what Deploy Review does with it).
    const stubExecute = (deps.deploys as unknown as { executeDeploy: (c: { id: string }, code: string) => Promise<unknown> })
      .executeDeploy;
    (deps.deploys as unknown as { executeDeploy: unknown }).executeDeploy = async (
      c: { id: string },
      code: string,
    ) => {
      db.patchDeployRequestSummary(id, (s) => ({
        ...s,
        governance: {
          ...(s.governance as Record<string, unknown>),
          execute_check: {
            at: '2026-11-18T09:30:00.000Z',
            rules: [RULE, 'acme freeze'],
            freeze_active: true,
            overridden: true,
            org_id: '00D-acme-dev',
            username: null,
          },
        },
      }));
      return stubExecute(c, code);
    };
    await service.approve(id, DRAFT, 'P1 outage, checkout is down');
    const g = service.get(id).governance!;
    expect(g.gate).toBe('overridden');
    expect(g.override).toMatchObject({ reason: 'P1 outage, checkout is down' });
    expect(g.executeCheck).toEqual({
      at: '2026-11-18T09:30:00.000Z',
      rules: [RULE, 'acme freeze'],
      freezeActive: true,
      overridden: true,
    });
    expect(executeCheckText(g)).toBe(
      `Policies re-checked when it executed (${localStamp('2026-11-18T09:30:00.000Z')}): rules ` +
        `"${RULE}", "acme freeze"; a change freeze was in effect, released for this request by the ` +
        'emergency reason.',
    );
    expect(executeCheckText(null)).toBeNull();
  });

  it('built-in default policies say so; a decided row reports what was recorded', async () => {
    // A wired engine reads config.json, where no policies section means the
    // built-in rule with source 'default'.
    (deps.deploys as unknown as { setPolicySource: (f: () => unknown) => void }).setPolicySource(() => ({
      ok: true,
      policies: { rules: [] },
      source: 'default',
    }));
    const connId = seedConnection('developer', 'acme-dev');
    const id = seedGoverned(connId);
    const g = service.get(id).governance!;
    expect(g.policySource).toBe('default');
    expect(g.policyLines).toEqual([]);
    await service.approve(id, DRAFT);
    const decided = service.get(id).governance!;
    expect(decided.gate).toBe('open');
    expect(decided.justification!.text).toBe(DRAFT);
    // A pre-0.40 row that is no longer pending has nothing to show.
    const old = seedRequest(connId, 'OLDR-OWWW');
    db.updateDeployRequestStatus(old, 'expired');
    expect(service.get(old).governance).toBeNull();
  });

  it('a request past its expiry, not yet swept: its gate cards never point at a form that is not shown', () => {
    // The row stays 'validated' until the next validation's sweep, so its
    // live gate still renders a card — but Deploy Review shows no comment
    // box, emergency-reason field or Approve for it.
    config.policies = { rules: [...JUSTIFY.rules, ...freezeOn('acme-*').rules] };
    const connId = seedConnection('developer', 'acme-dev');
    const past = new Date(Date.now() - 60_000).toISOString();
    const frozen = service.get(seedGoverned(connId, { code: 'EXPD-FRZN', expiresAt: past }));
    expect(frozen.status).toBe('validated');
    expect(frozen.governance!.gate).toBe('frozen');
    expect(stateLabel(frozen)).toBe('Expired');
    expect(stateLabel({ ...frozen, expiresAt: new Date(Date.now() + 60_000).toISOString() })).toBe(
      'Awaiting approval',
    );
    expect(expiredReviewText(frozen.kind)).toBe(
      'This request has expired and can no longer be approved — ask the agent to validate it again.',
    );
    expect(expiredReviewText('dml')).toBe(
      'This request has expired and can no longer be approved — ask the agent to propose it again.',
    );
    expect(freezeReviewNote(false)).toBeNull();
    expect(freezeReviewNote(true)).toBe(
      'While the freeze lasts, Approve stays disabled until you type an emergency reason. It is ' +
        'recorded in the audit log as a freeze override for this request only; the freeze itself ' +
        'stays configured.',
    );

    // Blocked only for its justification, with a freeze behind the block.
    const blockedId = seedGoverned(connId, { code: 'EXPD-BLKD', expiresAt: past, justification: null });
    const blocked = service.get(blockedId).governance!;
    expect(blocked.gate).toBe('blocked');
    expect(blockedAlsoFrozen(blocked)).toBe(true);
    expect(blockedClosingText(blocked, false)).toBe(
      "This request does not satisfy this connection's policies as they stand now: it needs a " +
        'justification. A change freeze is also in effect on this connection.',
    );
    expect(blockedClosingText(blocked, true)).toContain('emergency reason, typed below');
    // Without the freeze: the missing justification alone.
    config.policies = JUSTIFY;
    const alone = service.get(blockedId).governance!;
    expect(blockedAlsoFrozen(alone)).toBe(false);
    expect(blockedClosingText(alone, false)).toBe(
      "This request does not satisfy this connection's policies as they stand now: it needs a " +
        'justification.',
    );
    for (const text of [blockedClosingText(blocked, false), blockedClosingText(alone, false)]) {
      expect(text).not.toMatch(/below|Approve|Type it/);
    }
  });

  describe('a policy refusal at the claim, after the approval in Deploy Review', () => {
    type EngineSeams = {
      reviewGovernance: (id: string, input: unknown) => unknown;
      executeApex: (c: { id: string }, code: string) => Promise<unknown>;
      executeDeploy: (c: { id: string }, code: string) => Promise<unknown>;
      setPolicySource: (f: () => unknown) => void;
    };
    const engineOf = () => deps.deploys as unknown as EngineSeams;
    const UNREADABLE = 'policies.rules[0]: unknown key "requireTickets"';

    it('a freeze that begins between the approval and the claim: refused in Deploy Review, nothing runs, the held call stays held', async () => {
      const REASON = 'P1 outage, checkout is down';
      const connId = seedConnection('developer', 'acme-dev');
      const conn = db.resolveConnection(connId)!;
      db.updateGrants(connId, { ...conn.grants, data_write: true });
      const id = db.insertDeployRequest({
        connectionId: connId,
        kind: 'apex',
        confirmationCode: 'APEX-FRZN',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        payloadJson: JSON.stringify({ apex: true, code: 'System.debug(1);' }),
        summaryJson: JSON.stringify({ changes: [], destructive: [], blast: [] }),
      }).id;
      db.setDeployRequestDesktopFields(id, {
        sessionId: 's-claim',
        origin: 'desktop',
        desktopState: 'awaiting_approval',
      });
      const events: ChatEvent[] = [];
      service.attachSessions({ announce: (_s, e) => events.push(e) });
      const engine = engineOf();
      // The window: the approval's own check passes, then a freeze window
      // opens before the claim checks the policies again.
      const realReview = engine.reviewGovernance.bind(engine);
      let reviews = 0;
      engine.reviewGovernance = (rid, input) => {
        const r = realReview(rid, input);
        reviews += 1;
        if (reviews === 1) config.policies = freezeOn('acme-*');
        return r;
      };
      // The engine's REAL claim refuses the first call (assertPolicyAtExecute);
      // the retry's run is a faithful stub — there is no org here.
      const realApex = engine.executeApex.bind(engine);
      let apexCalls = 0;
      engine.executeApex = async (c, code) => {
        apexCalls += 1;
        if (apexCalls === 1) return realApex(c, code);
        executed.push({ connId: c.id, code });
        const result = { executed: true };
        db.claimRequestForExecution(id);
        db.finishDeployRequest(id, 'executed', JSON.stringify(result));
        return result;
      };
      const held = service.interceptAgentExecute('s-claim', 'apex', connId);
      expect(held).not.toBeNull();
      let settled = false;
      void held!.then(() => (settled = true));

      const refused = await service.approve(id, 'ship it').then(
        () => null,
        (err: Error) => err.message,
      );
      expect(refused).toMatch(
        /^Not executed — as execution started, Contrail checked this connection's policies again and they refused this request\. /,
      );
      expect(refused).toContain('Nothing ran, and the request is awaiting approval again.');
      expect(refused).toContain('FREEZE — policy rule "acme freeze" freezes changes to "acme-dev"');
      expect(refused).toContain('Approving it during the freeze needs an emergency reason.');
      expect(refused).not.toContain('execution failed');
      expect(refused).not.toContain('APEX-FRZN');
      expect(apexCalls).toBe(1);
      expect(executed).toEqual([]);
      // Still pending, its code unused, the decision withdrawn.
      const row = db.getDeployRequest(id)!;
      expect(row).toMatchObject({
        status: 'validated',
        desktopState: 'awaiting_approval',
        approvedAt: null,
        approvedComment: null,
        resultJson: null,
      });
      const view = service.get(id);
      expect(stateLabel(view)).toBe('Awaiting approval');
      expect(view.deciding).toBe(false);
      expect(view.governance!.gate).toBe('frozen');
      // Nothing announced; the held agent call stays held.
      expect(events).toEqual([]);
      await new Promise((r) => setTimeout(r, 10));
      expect(settled).toBe(false);
      // Both audit rows are true history: the approval, and the claim's refusal.
      expect(detailOf('deploy.approved')).toHaveLength(1);
      expect(detailOf('policy.refused')).toEqual([
        expect.objectContaining({ phase: 'execute', requestId: id, kind: 'apex', reason: 'freeze' }),
      ]);

      // The human records an emergency reason: the same request runs once,
      // and the held call gets the real outcome.
      await service.approve(id, 'ship it', REASON);
      expect(executed).toEqual([{ connId, code: 'APEX-FRZN' }]);
      const result = await held!;
      expect(result.isError).not.toBe(true);
      expect(result.content[0]!.text).toContain('"approved": true');
      expect(events).toEqual([{ type: 'approval_resolved', requestId: id, outcome: 'executed' }]);
      expect(db.getDeployRequest(id)!.desktopState).toBe('approved');
    });

    it('config.json unreadable at a deploy claim: pending again, and the timed-out hold says it awaits the user', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout'] });
      try {
        config.policies = { rules: [] };
        const connId = seedConnection('developer', 'acme-dev');
        const id = seedGoverned(connId, { code: 'UNRD-CNFG', sessionId: 's-unrd' });
        const engine = engineOf();
        const stubDeploy = engine.executeDeploy;
        // The engine's REAL execute: its policy check runs before any job.
        engine.executeDeploy = Object.getPrototypeOf(engine).executeDeploy.bind(engine);
        const realReview = engine.reviewGovernance.bind(engine);
        engine.reviewGovernance = (rid, input) => {
          const r = realReview(rid, input);
          engine.setPolicySource(() => ({ ok: false, problem: UNREADABLE }));
          return r;
        };
        const events: ChatEvent[] = [];
        service.attachSessions({ announce: (_s, e) => events.push(e) });
        const held = service.interceptAgentExecute('s-unrd', 'deploy', connId)!;

        const refused = await service.approve(id, DRAFT).then(
          () => null,
          (err: Error) => err.message,
        );
        expect(refused).toMatch(/^Not executed — /);
        expect(refused).toContain(
          'Nothing ran, and the request is awaiting approval again. Contrail could not read the ' +
            `policies in config.json: ${UNREADABLE}`,
        );
        expect(db.getDeployRequest(id)).toMatchObject({
          status: 'validated',
          desktopState: null,
          approvedAt: null,
          approvedComment: null,
        });
        expect(executed).toEqual([]);
        expect(events).toEqual([]);
        expect(detailOf('policy.refused')).toEqual([
          expect.objectContaining({ phase: 'execute', requestId: id, reason: 'config_unreadable' }),
        ]);

        vi.advanceTimersByTime(5 * 60_000);
        const answer = await held;
        expect(answer.isError).toBeUndefined();
        expect(JSON.parse(answer.content[0]!.text)).toMatchObject({
          status: 'awaiting_approval',
          request_id: id,
        });
        expect(answer.content[0]!.text).not.toContain('execution is starting');
        expect(answer.content[0]!.text).not.toContain('execution failed');

        // The file fixed, the same request approves and runs once.
        engine.reviewGovernance = realReview;
        engine.setPolicySource(() => ({ ok: true, policies: config.policies, source: 'config' }));
        engine.executeDeploy = stubDeploy;
        await service.approve(id, DRAFT);
        expect(executed).toEqual([{ connId, code: 'UNRD-CNFG' }]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a deploy poll's refusal while the job still re-checks the target is not the outcome — the job's claim decides", async () => {
      vi.useFakeTimers({ toFake: ['setTimeout'] });
      try {
        config.policies = { rules: [] };
        const connId = seedConnection('developer', 'acme-dev');
        const scenario = async (code: string, sessionId: string, jobClaims: boolean) => {
          const id = seedGoverned(connId, { code, sessionId });
          let calls = 0;
          // The first call starts the job (its target re-check outlives the
          // soft-wait); a poll's own policy check meets config.json mid-save
          // and refuses, while the job goes on to its claim.
          engineOf().executeDeploy = async (c, used) => {
            calls += 1;
            if (calls === 1) {
              return {
                status: 'in_progress',
                progress: 're-checking the target org before claiming the code',
                started_at: new Date().toISOString(),
              };
            }
            if (calls === 2) {
              if (jobClaims) setTimeout(() => db.claimRequestForExecution(id), 5_000);
              throw new ContrailError(
                `POLICY CHECK FAILED CLOSED — not executed. Contrail could not read the policies in config.json: ${UNREADABLE}.`,
                'policy_unreadable',
              );
            }
            // Re-attached to the job, which claimed the code and ran it.
            executed.push({ connId: c.id, code: used });
            const result = { deployed: true, id: 'deploy-race' };
            db.finishDeployRequest(id, 'executed', JSON.stringify(result));
            return { status: 'complete', result };
          };
          const held = service.interceptAgentExecute(sessionId, 'deploy', connId)!;
          const approving = service.approve(id, DRAFT).then(
            () => null,
            (err: Error) => err.message,
          );
          await vi.advanceTimersByTimeAsync(2_500);
          expect(calls).toBe(2);
          await vi.advanceTimersByTimeAsync(25_000);
          return { id, held, refused: await approving, calls };
        };

        // The job claimed despite the poll's refusal: it ran, and says so.
        const ran = await scenario('RACE-RANN', 's-ran', true);
        expect(ran.refused).toBeNull();
        expect(ran.calls).toBe(3);
        expect(executed).toEqual([{ connId, code: 'RACE-RANN' }]);
        expect(db.getDeployRequest(ran.id)).toMatchObject({ status: 'executed', desktopState: 'approved' });
        expect((await ran.held).content[0]!.text).toContain('"approved": true');

        // The job's claim was refused too: nothing ran, once its claim is decided.
        const stopped = await scenario('RACE-STOP', 's-stop', false);
        expect(stopped.calls).toBe(2);
        expect(stopped.refused).toMatch(/^Not executed — /);
        expect(executed).toHaveLength(1);
        expect(db.getDeployRequest(stopped.id)).toMatchObject({ status: 'validated', desktopState: null });
        service.releaseHeldForSession('s-stop');
        expect((await stopped.held).content[0]!.text).toContain('session ended');
      } finally {
        vi.useRealTimers();
      }
    });

    it('the refusal says what the policies require now, from the live gate (no org)', () => {
      const lead =
        "Not executed — as execution started, Contrail checked this connection's policies again " +
        'and they refused this request. Nothing ran, and the request is awaiting approval again.';
      const g = (over: Partial<GovernanceState>) =>
        ({ gate: 'open', blockedBy: null, blockedLines: [], freezeLine: null, ...over }) as GovernanceState;
      expect(
        executePolicyRefusalText(
          g({
            gate: 'blocked',
            blockedBy: 'violations',
            blockedLines: [
              'policy rule "a" requires a ticket for every change to "acme-dev"',
              'policy rule "b" denies anonymous Apex on "acme-dev"',
            ],
          }),
        ),
      ).toBe(
        `${lead} What blocks it now: policy rule "a" requires a ticket for every change to ` +
          '"acme-dev"; policy rule "b" denies anonymous Apex on "acme-dev"',
      );
      expect(executePolicyRefusalText(g({ gate: 'frozen', freezeLine: 'FREEZE — rule x.' }))).toBe(
        `${lead} FREEZE — rule x. Approving it during the freeze needs an emergency reason.`,
      );
      for (const gate of ['open', 'overridden'] as const) {
        expect(executePolicyRefusalText(g({ gate }))).toBe(
          `${lead} The policies allow it now — approve it again to run it.`,
        );
      }
    });

    it('a hold that times out on an approved request says "execution is starting" only while the approval is in flight', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout'] });
      try {
        // An approval an app quit interrupted: recorded, nothing in flight.
        const connId = seedConnection('developer', 'dev-org');
        const quit = seedRequest(connId, 'QUIT-APPR');
        db.setDeployRequestDesktopFields(quit, { sessionId: 's-quit', origin: 'desktop' });
        db.recordDeployDecision(quit, 'approved', 'go');
        const idle = service.interceptAgentExecute('s-quit', 'deploy', connId)!;
        vi.advanceTimersByTime(5 * 60_000);
        const idleText = (await idle).content[0]!.text;
        expect(JSON.parse(idleText)).toMatchObject({ status: 'awaiting_approval', request_id: quit });
        expect(idleText).not.toContain('execution is starting');

        // An approval in flight (its target re-check still running): starting.
        const conn2 = seedConnection('developer', 'dev-org-2');
        const live = seedRequest(conn2, 'LIVE-APPR');
        db.setDeployRequestDesktopFields(live, { sessionId: 's-live', origin: 'desktop' });
        let release!: () => void;
        const guard = new Promise<void>((r) => (release = r));
        const stub = engineOf().executeDeploy;
        engineOf().executeDeploy = async (c, code) => {
          await guard;
          return stub(c, code);
        };
        const held = service.interceptAgentExecute('s-live', 'deploy', conn2)!;
        const approving = service.approve(live, 'go');
        vi.advanceTimersByTime(5 * 60_000);
        expect(JSON.parse((await held).content[0]!.text)).toEqual({
          status: 'executing',
          request_id: live,
          note: 'The user approved it and execution is starting. Call again shortly for the outcome.',
        });
        release();
        await approving;
        expect(executed).toEqual([{ connId: conn2, code: 'LIVE-APPR' }]);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

// ── S46 (C): the snapshot re-baseline after an executed deploy ──────────

describe('S46 C: the re-baseline result in Deploy Review', () => {
  const member = (type: string, api_name: string) => ({ type, api_name });
  const block = (over: Record<string, unknown>) => ({
    status: 'complete',
    rebaselined: [member('ApexClass', 'Foo')],
    removed: [],
    skipped: [],
    note: 'The local snapshot was updated for this deploy.',
    ...over,
  });
  let seq = 0;

  function seedExecuted(connId: string, snapshot: Record<string, unknown>): string {
    seq += 1;
    const id = seedRequest(connId, `EXEC-${String(seq).padStart(4, '0')}`);
    db.claimRequestForExecution(id);
    db.finishDeployRequest(id, 'executed', JSON.stringify({ deployed: true, id: 'd', snapshot }));
    return id;
  }

  it('approve() during the re-baseline window shows pending while deciding, then resolves the held call with the FINAL block', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const connId = seedConnection('developer', 'dev-org');
      const id = seedRequest(connId, 'REBA-SELN');
      db.setDeployRequestDesktopFields(id, { sessionId: 's-rb' });
      const held = service.interceptAgentExecute('s-rb', 'deploy', connId);
      const pendingBlock = block({ status: 'pending', rebaselined: [], note: 'still re-reading' });
      const finalBlock = block({});
      let calls = 0;
      let midView: ReturnType<DeployService['get']> | null = null;
      (deps.deploys as unknown as { executeDeploy: unknown }).executeDeploy = async () => {
        calls += 1;
        if (calls === 1) {
          // finishExecution stored the row 'executed' with snapshot pending;
          // the engine is still re-reading — the call returns in-progress.
          db.claimRequestForExecution(id);
          db.finishDeployRequest(id, 'executed', JSON.stringify({ deployed: true, snapshot: pendingBlock }));
          midView = service.get(id);
          return { status: 'in_progress', job_id: 'x', progress: 'deployed — re-reading' };
        }
        const result = { deployed: true, snapshot: finalBlock };
        db.amendDeployRequestResult(id, JSON.stringify(result));
        return { status: 'complete', result };
      };
      const approving = service.approve(id, 'go');
      await vi.advanceTimersByTimeAsync(3_000);
      const view = await approving;

      expect(calls).toBe(2);
      expect(midView!.deciding).toBe(true);
      expect(midView!.snapshotRebaseline!.status).toBe('pending');
      expect(snapshotRebaselineLines(midView!.snapshotRebaseline, midView!.deciding)).toEqual({
        notice: false,
        text: 'Updating the local snapshot for this deploy…',
        rows: [],
      });
      expect(view.deciding).toBe(false);
      expect(view.snapshotRebaseline!.status).toBe('complete');
      const result = await held!;
      expect(result.isError).not.toBe(true);
      expect(result.content[0]!.text).toContain('"status": "complete"');
      expect(result.content[0]!.text).not.toContain('"pending"');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a pending row with no approval in flight reads deciding false and says the snapshot may be stale', () => {
    const connId = seedConnection('developer', 'dev-org');
    const id = seedExecuted(connId, block({ status: 'pending', rebaselined: [], note: 'n' }));
    const view = service.get(id);
    expect(view.deciding).toBe(false);
    expect(view.snapshotRebaseline!.status).toBe('pending');
    expect(snapshotRebaselineLines(view.snapshotRebaseline, view.deciding)).toEqual({
      notice: true,
      text:
        'No finished snapshot update is recorded for this deploy — the snapshot may be stale for ' +
        'its components.',
      rows: [],
    });
  });

  it('a failed_after_write view carries the reason and says the snapshot may be only partly updated', () => {
    const connId = seedConnection('developer', 'dev-org');
    const note = 'the re-read stopped while writing; run refresh_snapshot with members to repair it.';
    const id = seedExecuted(
      connId,
      block({ status: 'unavailable', reason: 'failed_after_write', rebaselined: [], note }),
    );
    const view = service.get(id);
    expect(view.snapshotRebaseline).toMatchObject({
      status: 'unavailable',
      reason: 'failed_after_write',
      note,
    });
    expect(snapshotRebaselineLines(view.snapshotRebaseline, false)).toEqual({
      notice: true,
      text: `Local snapshot may be only partly updated — ${note}`,
      rows: [],
    });
    const timeout = service.get(
      seedExecuted(connId, block({ status: 'unavailable', reason: 'timeout', rebaselined: [], note: 'n1' })),
    );
    expect(timeout.snapshotRebaseline!.reason).toBe('timeout');
    expect(snapshotRebaselineLines(timeout.snapshotRebaseline, false)!.text).toBe(
      'Local snapshot NOT updated — n1',
    );
  });

  it('complete, partial, none and disabled say what was updated (renderer-free)', () => {
    const connId = seedConnection('developer', 'dev-org');
    const complete = service.get(
      seedExecuted(connId, block({ removed: [member('ApexClass', 'Old')] })),
    ).snapshotRebaseline;
    expect(complete!.reason).toBeNull();
    expect(snapshotRebaselineLines(complete, false)).toEqual({
      notice: false,
      text: 'Local snapshot updated for 2 component(s).',
      rows: [],
    });
    const skipped = [
      { ...member('Layout', 'Account-Account Layout'), code: 'not_confirmed', reason: 'not confirmed' },
    ];
    const partial = service.get(seedExecuted(connId, block({ status: 'partial', skipped }))).snapshotRebaseline;
    expect(partial!.skipped).toEqual([
      { type: 'Layout', apiName: 'Account-Account Layout', code: 'not_confirmed', reason: 'not confirmed' },
    ]);
    expect(snapshotRebaselineLines(partial, false)).toEqual({
      notice: false,
      text: 'Local snapshot updated for 1 of 2 component(s). Not updated:',
      rows: ['Layout Account-Account Layout — not confirmed'],
    });
    const none = service.get(
      seedExecuted(connId, block({ status: 'none', rebaselined: [], skipped })),
    ).snapshotRebaseline;
    expect(snapshotRebaselineLines(none, false)).toEqual({
      notice: false,
      text: 'Local snapshot not updated for this deploy:',
      rows: ['Layout Account-Account Layout — not confirmed'],
    });
    const disabled = service.get(
      seedExecuted(connId, block({ status: 'disabled', rebaselined: [] })),
    ).snapshotRebaseline;
    expect(disabled!.status).toBe('disabled');
    expect(snapshotRebaselineLines(disabled, false)).toBeNull();
    // A pre-0.40 result has no block.
    const plain = seedRequest(connId, 'PLAI-NRES');
    db.claimRequestForExecution(plain);
    db.finishDeployRequest(plain, 'executed', JSON.stringify({ deployed: true }));
    expect(service.get(plain).snapshotRebaseline).toBeNull();
    expect(snapshotRebaselineLines(null, false)).toBeNull();
  });

  it("a 'none' that still re-wrote a parent document says so — never 'not updated' over rows that contradict it", () => {
    const connId = seedConnection('developer', 'dev-org');
    const field = member('CustomField', 'Invoice__c.Due__c');
    // The engine's own result for a deployed field its re-read object no
    // longer holds: the field is skipped, yet the object's document was
    // written (`units`) — or, with no unit written, nothing was.
    const ran = (units: string[]) =>
      executeSnapshotResult(
        {
          status: 'ran',
          summary: {
            connection: 'dev-org',
            members: [
              { ...field, outcome: 'skipped', unit: 'CustomObject:Invoice__c', reason: 'child_not_in_parent' },
            ],
            counts: { refreshed: 0, removed: 0, skipped: 1 },
            units,
            artifact_counts: {},
            edge_counts: { extractor: 0 },
            retrieved_at: '2026-11-18T09:00:00.000Z',
            notes: [],
            duration_ms: 5,
          },
        },
        [field],
        60_000,
      );
    const seed = (r: { snapshot: unknown; note: string }, code: string) => {
      const id = seedRequest(connId, code);
      db.claimRequestForExecution(id);
      db.finishDeployRequest(id, 'executed', JSON.stringify({ deployed: true, id: 'd', ...r }));
      return id;
    };
    const wrote = service.get(seed(ran(['CustomObject:Invoice__c']), 'NONE-WROT')).snapshotRebaseline!;
    expect(wrote.status).toBe('none');
    expect(wrote.wroteDocuments).toBe(true);
    expect(wrote.skipped).toHaveLength(1);
    expect(snapshotRebaselineLines(wrote, false)).toEqual({
      notice: false,
      text:
        'No component in this deploy was re-baselined, but Contrail re-wrote in the local snapshot ' +
        'a parent document or folder it re-read for them:',
      rows: [`CustomField Invoice__c.Due__c — ${wrote.skipped[0]!.reason}`],
    });
    const nothing = service.get(seed(ran([]), 'NONE-NOTH')).snapshotRebaseline!;
    expect(nothing.status).toBe('none');
    expect(nothing.wroteDocuments).toBe(false);
    expect(snapshotRebaselineLines(nothing, false)!.text).toBe('Local snapshot not updated for this deploy:');
    // Only a 'none' can carry it.
    const complete = service.get(seedExecuted(connId, block({}))).snapshotRebaseline!;
    expect(complete.wroteDocuments).toBe(false);
  });

  it('an agent call during the re-baseline window waits for the final block — never the stored "pending" one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const connId = seedConnection('developer', 'dev-org');
      const id = seedRequest(connId, 'REPL-AYRB');
      db.setDeployRequestDesktopFields(id, { sessionId: 's-rp' });
      // Held now; its hold lapses inside the re-read window below.
      const held = service.interceptAgentExecute('s-rp', 'deploy', connId)!;
      const pendingBlock = block({ status: 'pending', rebaselined: [], note: 'still re-reading' });
      const finalBlock = block({});
      let calls = 0;
      let finishReread!: () => void;
      const reread = new Promise<void>((r) => (finishReread = r));
      (deps.deploys as unknown as { executeDeploy: unknown }).executeDeploy = async () => {
        calls += 1;
        if (calls === 1) {
          // finishExecution stored the row 'executed' with snapshot pending.
          db.claimRequestForExecution(id);
          db.finishDeployRequest(id, 'executed', JSON.stringify({ deployed: true, snapshot: pendingBlock }));
          return { status: 'in_progress', job_id: 'x', progress: REBASELINE_PROGRESS };
        }
        await reread;
        const result = { deployed: true, snapshot: finalBlock };
        db.amendDeployRequestResult(id, JSON.stringify(result));
        return { status: 'complete', result };
      };
      const approving = service.approve(id, 'go');
      await vi.advanceTimersByTimeAsync(3_000);
      expect(calls).toBe(2);

      const REREAD = {
        status: 'executing',
        request_id: id,
        note:
          'The user approved it and the deploy has completed in the org; Contrail is still ' +
          're-reading the deployed components into the local snapshot. Call again shortly for ' +
          'the final outcome.',
      };
      // Nothing is pending, so a codeless call replays the row — but not its pending block.
      const replay = await service.interceptAgentExecute('s-rp', 'deploy', connId)!;
      expect(JSON.parse(replay.content[0]!.text)).toEqual(REREAD);
      // The earlier call's hold lapses in the same window: the same answer.
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(JSON.parse((await held).content[0]!.text)).toEqual(REREAD);

      finishReread();
      await approving;
      const after = (await service.interceptAgentExecute('s-rp', 'deploy', connId)!).content[0]!.text;
      expect(after).toContain('"approved": true');
      expect(after).toContain('"status": "complete"');
      expect(after).not.toContain('"pending"');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a stored "pending" block with no approval in flight is replayed as stored (its note says it may be stale)', async () => {
    const connId = seedConnection('developer', 'dev-org');
    const id = seedExecuted(connId, block({ status: 'pending', rebaselined: [], note: 'may be stale' }));
    db.setDeployRequestDesktopFields(id, { sessionId: 's-st' });
    db.recordDeployDecision(id, 'approved', 'go');
    const text = (await service.interceptAgentExecute('s-st', 'deploy', connId)!).content[0]!.text;
    expect(text).toContain('"approved": true');
    expect(text).toContain('"status": "pending"');
  });
});
