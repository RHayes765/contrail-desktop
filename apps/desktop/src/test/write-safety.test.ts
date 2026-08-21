import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ContrailDb, type EngineDeps, type GrantSet } from '@contrail/engine';
import { DeployService } from '../main/services/deploys.js';
import { AgentSessionRun, type SessionSpec } from '../main/services/agentRuntime.js';
import { ProjectService } from '../main/services/projects.js';

/**
 * S10 — the M5 adversarial write-safety suite. Every test here is an ATTACK:
 * it does the wrong thing on purpose and asserts the system refuses, contains,
 * or survives it. The base invariants (code-free renderer, approve-only
 * execution, reject-kills-code, prod comment) live in deploy-approval.test.ts;
 * this file covers what an adversary — a confused agent, injected org text
 * steering one, or a raced UI — would actually try next.
 */

let tmp: string;
let db: ContrailDb;
let executed: Array<{ connId: string; code: string; kind: 'deploy' | 'dml' }>;
let deps: EngineDeps;
let service: DeployService;

function grants(over: Partial<GrantSet> = {}): GrantSet {
  return {
    metadata_read: true,
    metadata_write: true,
    diagnostics_read: false,
    data_read: true,
    data_write: true,
    ...over,
  };
}

function seedConnection(orgType: string, alias: string, g: Partial<GrantSet> = {}): string {
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
    grants: grants(g),
  }).id;
}

function seedRequest(
  connId: string,
  over: {
    code?: string;
    kind?: 'deploy' | 'dml';
    expiresAt?: string;
    sessionId?: string;
    destructive?: boolean;
  } = {},
): string {
  const rec = db.insertDeployRequest({
    connectionId: connId,
    kind: over.kind ?? 'deploy',
    confirmationCode: over.code ?? 'ABCD-EFGH',
    expiresAt: over.expiresAt ?? new Date(Date.now() + 3_600_000).toISOString(),
    summaryJson: JSON.stringify(
      over.kind === 'dml'
        ? { operation: 'delete', object: 'Account', row_count: 3, rows: [] }
        : {
            changes: [{ type: 'ApexClass', api_name: 'Foo', change: 'modify', warnings: [] }],
            destructive: over.destructive
              ? [
                  {
                    type: 'CustomObject',
                    api_name: 'Legacy__c',
                    change: 'delete',
                    warnings: ['DELETION — cannot be undone by rollback'],
                  },
                ]
              : [],
            blast: [],
          },
    ),
  });
  if (over.sessionId) db.setDeployRequestDesktopFields(rec.id, { sessionId: over.sessionId });
  return rec.id;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-ws-'));
  db = new ContrailDb(path.join(tmp, 'test.db'));
  executed = [];
  // Faithful engine stub (see deploy-approval.test.ts for why faithfulness
  // matters): claims the row and writes the terminal state like the real one.
  const finish = (code: string, payload: Record<string, unknown>) => {
    const row = db.listDeployRequests({ limit: 200 }).find((r) => r.confirmationCode === code);
    if (row) {
      db.claimRequestForExecution(row.id);
      db.finishDeployRequest(row.id, 'executed', JSON.stringify(payload));
    }
  };
  const engine = {
    executeDeploy: async (conn: { id: string }, code: string) => {
      executed.push({ connId: conn.id, code, kind: 'deploy' });
      const result = { deployed: true, id: `deploy-${executed.length}` };
      finish(code, result);
      return { status: 'complete', result };
    },
    executeDml: async (conn: { id: string }, code: string) => {
      executed.push({ connId: conn.id, code, kind: 'dml' });
      const result = { executed: true };
      finish(code, result);
      return result;
    },
  };
  deps = { db, audit: { record: () => undefined }, deploys: engine } as unknown as EngineDeps;
  service = new DeployService(deps, () => undefined);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── cross-request attacks ────────────────────────────────────────────────

describe('cross-request attacks', () => {
  it('approving B executes exactly B — A keeps its own code and stays pending', async () => {
    const connId = seedConnection('developer', 'dev');
    const idA = seedRequest(connId, { code: 'AAAA-1111' });
    const idB = seedRequest(connId, { code: 'BBBB-2222' });

    await service.approve(idB, 'ship B');
    expect(executed).toHaveLength(1);
    expect(executed[0]!.code).toBe('BBBB-2222'); // the ROW's code, never A's

    // A was untouched by B's approval — still independently decidable.
    expect(db.getDeployRequest(idA)!.status).toBe('validated');
    await service.reject(idA, 'not this one');
    expect(db.getDeployRequest(idA)!.desktopState).toBe('rejected');
    expect(executed).toHaveLength(1);
    void idB;
  });

  it('a forged or stale request id is refused, not guessed around', async () => {
    const connId = seedConnection('developer', 'dev');
    const id = seedRequest(connId);
    await service.reject(id, 'no');
    // Re-approving the rejected row and approving an invented id both die.
    await expect(service.approve(id, 'please')).rejects.toThrow(/only a validated/);
    await expect(service.approve('not-a-real-id', 'x')).rejects.toThrow(/not found/);
    expect(executed).toHaveLength(0);
  });

  it('a deleted target connection blocks approval outright', async () => {
    const connId = seedConnection('developer', 'doomed');
    const id = seedRequest(connId);
    db.deleteConnection(connId);
    await expect(service.approve(id, 'x')).rejects.toThrow(/no longer exists/);
    expect(executed).toHaveLength(0);
  });
});

// ── expiry: refusal AND the escape hatch ─────────────────────────────────

describe('expired requests', () => {
  it('an already-expired request never engages the hold — the engine refuses directly', () => {
    const connId = seedConnection('developer', 'dev');
    seedRequest(connId, {
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      sessionId: 'session-1',
    });
    // null = fall through to the engine, whose claim machinery answers
    // "expired" immediately. Holding here would wedge the agent on a request
    // the human can no longer approve.
    expect(service.interceptAgentExecute('session-1', 'deploy', connId)).toBeNull();
  });

  it('a request that expires WHILE held: approve refuses, reject still releases the agent', async () => {
    const connId = seedConnection('developer', 'dev');
    const id = seedRequest(connId, { sessionId: 'session-1' }); // valid now
    const held = service.interceptAgentExecute('session-1', 'deploy', connId);
    expect(held).not.toBeNull();

    // The clock runs out while the human deliberates.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).db
      .prepare(`UPDATE deploy_requests SET expires_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 1_000).toISOString(), id);

    await expect(service.approve(id, 'too late')).rejects.toThrow(/expired/);
    expect(executed).toHaveLength(0);

    // The human's escape hatch: reject works on the expired row and the
    // agent gets a structured refusal instead of hanging out the hold window.
    await service.reject(id, 'expired, re-validate');
    const result = await held!;
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('REJECTED');
  });
});

// ── DML and destructive through the same seam ────────────────────────────

describe('DML through the native approval seam', () => {
  it('approve executes the DML with the row code; the held dml call resolves', async () => {
    const connId = seedConnection('developer', 'dev');
    const id = seedRequest(connId, { kind: 'dml', code: 'DMLC-0001', sessionId: 's-dml' });
    const held = service.interceptAgentExecute('s-dml', 'dml', connId);
    expect(held).not.toBeNull();

    await service.approve(id, 'ok');
    expect(executed).toEqual([{ connId, code: 'DMLC-0001', kind: 'dml' }]);
    const result = await held!;
    expect(result.isError).not.toBe(true);
    expect(result.content[0]!.text).toContain('"approved": true');
  });

  it('a deploy hold is NOT satisfied by a dml decision (kind is part of identity)', async () => {
    const connId = seedConnection('developer', 'dev');
    seedRequest(connId, { kind: 'dml', code: 'DMLC-0002', sessionId: 's-x' });
    // The agent holds for a DEPLOY; only a dml request is pending.
    expect(service.interceptAgentExecute('s-x', 'deploy', connId)).toBeNull();
  });

  it('production DML demands a comment exactly like a deploy', async () => {
    const connId = seedConnection('production', 'prod');
    const id = seedRequest(connId, { kind: 'dml' });
    await expect(service.approve(id, '   ')).rejects.toThrow(/comment/i);
    expect(executed).toHaveLength(0);
  });

  it('revoking data_write blocks a pending DML while metadata_write stays irrelevant', async () => {
    const connId = seedConnection('developer', 'dev');
    const id = seedRequest(connId, { kind: 'dml' });
    db.updateGrants(connId, grants({ data_write: false }));
    await expect(service.approve(id, 'x')).rejects.toThrow(/data_write/);
    expect(executed).toHaveLength(0);
  });

  it('a destructive deploy renders its red rows and executes like any other', async () => {
    const connId = seedConnection('developer', 'dev');
    const id = seedRequest(connId, { destructive: true });
    const view = service.get(id);
    expect(view.destructive).toHaveLength(1);
    expect(view.destructive[0]!.warnings[0]).toMatch(/cannot be undone/);
    await service.approve(id, 'delete it');
    expect(executed).toHaveLength(1);
  });
});

// ── the agent cannot reach the decision surface at all ───────────────────

describe('agent-side unreachability of approve/reject', () => {
  function makeRun() {
    const spec: SessionSpec = {
      project: { id: 'p1', name: 'P', description: null, instructions: null },
      bindings: [],
      model: 'claude-haiku-4-5',
      maxTurns: 10,
      maxBudgetUsd: 0.5,
    };
    const world = {
      resolveConnection: (ref: string) => db.resolveConnection(ref),
      listProjectBindings: () => [],
      getProject: (id: string) => ({ id, name: 'P', description: null, instructions: null }),
      getServerToggles: () => [],
    };
    return new AgentSessionRun(
      { db: world } as never,
      spec,
      'session-attacker',
      {} as never,
      () => service,
    );
  }

  it('no capability by any approve-ish name exists for the runtime to call', async () => {
    const run = makeRun();
    for (const name of ['approve', 'reject', 'deploys:approve', 'approve_deploy']) {
      const result = await run.executeCapability(name, { requestId: 'anything', comment: 'x' });
      expect(result.isError, `${name} must not be invocable`).toBe(true);
    }
    expect(executed).toHaveLength(0);
  });
});

// ── cross-silo attacks against the REAL project service ──────────────────

describe('cross-project isolation under concurrent sessions (real silo)', () => {
  it('a note written in project A is invisible to a live session in project B', async () => {
    const projects = new ProjectService(deps);
    const a = projects.create('Client A');
    const b = projects.create('Client B');
    const runFor = (projectId: string, name: string) =>
      new AgentSessionRun(
        deps,
        {
          project: { id: projectId, name, description: null, instructions: null },
          bindings: [],
          model: 'claude-haiku-4-5',
          maxTurns: 10,
          maxBudgetUsd: 0.5,
        },
        `session-${name}`,
        projects,
        () => service,
      );
    const runA = runFor(a.id, 'A');
    const runB = runFor(b.id, 'B');

    const SECRET = 'client-A-renewal-strategy-CONFIDENTIAL-93x';
    const saved = await runA.executeCapability('add_project_note', { body: SECRET });
    expect(saved.isError).toBeFalsy();

    // The attack: B lists notes, and also tries to NAME A's project outright.
    const listB = await runB.executeCapability('list_project_notes', {});
    expect(listB.content[0]!.text).not.toContain(SECRET);
    const forged = await runB.executeCapability('list_project_notes', { project_id: a.id });
    expect(forged.content[0]!.text).not.toContain(SECRET);

    // And A still sees its own — isolation, not amnesia.
    const listA = await runA.executeCapability('list_project_notes', {});
    expect(listA.content[0]!.text).toContain(SECRET);
  });
});
