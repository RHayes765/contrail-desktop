import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ContrailDb, type EngineDeps } from '@contrail/engine';
import { DeployService, NativeApprovalPresenter } from '../main/services/deploys.js';

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
