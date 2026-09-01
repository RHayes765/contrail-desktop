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
let executed: Array<{ connId: string; code: string; kind: 'deploy' | 'dml' | 'apex' | 'bulk' }>;
let bulkProposals: Array<{ stopOnFailure: boolean; steps: Array<Record<string, unknown>> }>;
let bulkExecutedOk: boolean;
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
    kind?: 'deploy' | 'dml' | 'apex' | 'bulk';
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
  bulkProposals = [];
  bulkExecutedOk = true;
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
    executeApex: async (conn: { id: string }, code: string) => {
      executed.push({ connId: conn.id, code, kind: 'apex' });
      const result = { executed: true, status: 'executed' };
      finish(code, result);
      return result;
    },
    proposeBulkLoad: async (
      _conn: { id: string },
      input: { stopOnFailure: boolean; steps: Array<Record<string, unknown>> },
    ) => {
      bulkProposals.push(input);
      return { request_id: 'bulk-req', total_rows: 1, stop_on_failure: input.stopOnFailure };
    },
    executeBulkLoad: async (conn: { id: string }, code: string) => {
      executed.push({ connId: conn.id, code, kind: 'bulk' });
      const result = bulkExecutedOk
        ? { bulk: true, executed: true, total_processed: 3, total_failed: 0 }
        : { bulk: true, executed: false, total_processed: 3, total_failed: 2, halted_after_step: 1 };
      finish(code, result);
      return { status: 'complete', result };
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

describe('default-off is a revocation (review finding, S12)', () => {
  it('flipping defaultOn true->false ends sessions using the server; other flips do not', async () => {
    const { McpConfigService } = await import('../main/services/mcpConfig.js');
    const revoked: string[] = [];
    const svc = new McpConfigService(deps, async (serverId) => {
      revoked.push(serverId);
    });
    const server = db.addCustomMcpServer({
      name: 'Team Jira',
      transport: 'http',
      urlOrCommand: 'https://jira.example/mcp',
    });

    await svc.setDefaultOn(server.id, true); // off -> on: nothing to revoke
    expect(revoked).toEqual([]);
    await svc.setDefaultOn(server.id, true); // on -> on: no-op
    expect(revoked).toEqual([]);
    await svc.setDefaultOn(server.id, false); // on -> off: THE revocation
    expect(revoked).toEqual([server.id]);
    await svc.setDefaultOn(server.id, false); // off -> off: no double-kill
    expect(revoked).toEqual([server.id]);
  });
});

describe('multi-step DML plans at the native seam (S14)', () => {
  it('a plan row renders its per-step rows even without review_json, and the hold stays kind-agnostic', async () => {
    const connId = seedConnection('developer', 'dev');
    // A plan proposed via the PLUGIN: kind 'dml', plan-shaped summary, no
    // desktop review_json. The screen must show the steps, not a blank.
    const rec = db.insertDeployRequest({
      connectionId: connId,
      kind: 'dml',
      confirmationCode: 'PLAN-CODE',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      summaryJson: JSON.stringify({
        plan: true,
        all_or_none: true,
        steps: 3,
        row_count: 3,
        rows: [
          { label: 'Step 1 · INSERT Account (ref "acct"): Name = "X"', warnings: [] },
          { label: 'Step 2 · INSERT Contact: AccountId = <new Account from step 1>', warnings: [] },
          { label: 'Step 3 · DELETE Account 001000000000001AAA', warnings: [], destructive: true },
        ],
      }),
    });

    const view = service.get(rec.id);
    expect(view.changeRows.map((r) => r.label).join('\n')).toContain('Step 1 · INSERT Account');
    expect(view.changeRows.map((r) => r.label).join('\n')).toContain('new Account from step 1');
    expect(view.destructiveRows.map((r) => r.label).join('\n')).toContain('Step 3 · DELETE Account');
    // The code never rides along in any view field.
    expect(JSON.stringify(view)).not.toContain('PLAN-CODE');

    // interceptAgentExecute treats a plan row as any dml row (kind is identity).
    const held = service.interceptAgentExecute('s-plan', 'dml', connId);
    expect(held).not.toBeNull();
    await service.approve(rec.id, 'run the plan');
    const result = await held!;
    expect(result.isError).not.toBe(true);
    expect(executed).toEqual([{ connId, code: 'PLAN-CODE', kind: 'dml' }]);
  });
});

describe('bulk loads at the native seam (S27)', () => {
  function seedBulkRequest(connId: string, sessionId?: string): string {
    // Proposed via the PLUGIN (shared DB): kind 'bulk', plan-shaped summary
    // rows (same shape as DML plans), no desktop review_json.
    const rec = db.insertDeployRequest({
      connectionId: connId,
      kind: 'bulk',
      confirmationCode: 'BULK-CODE',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      summaryJson: JSON.stringify({
        bulk: true,
        steps: 2,
        total_rows: 1200,
        stop_on_failure: true,
        rows: [
          {
            label: 'STEP 1  INSERT Account — 1,000 rows',
            warnings: [],
            detail: 'from Migration/accounts.csv\nfrozen sha256 ab12cd34ef567890… · 45,231 bytes',
            destructive: false,
          },
          {
            label: 'STEP 2  DELETE Contact — 200 rows',
            warnings: ['Bulk delete is a SOFT delete — rows go to the Recycle Bin (~15 days).'],
            destructive: true,
          },
        ],
      }),
    });
    if (sessionId) db.setDeployRequestDesktopFields(rec.id, { sessionId });
    return rec.id;
  }

  it('a plugin-proposed bulk row renders its steps (details, red deletes), hides the code, and approve drives executeBulkLoad', async () => {
    const connId = seedConnection('developer', 'dev');
    const id = seedBulkRequest(connId, 's-bulk');
    const view = service.get(id);
    expect(view.kind).toBe('bulk');
    expect(view.changeRows[0]?.label).toContain('STEP 1  INSERT Account');
    expect(view.changeRows[0]?.detail).toContain('frozen sha256');
    expect(view.destructiveRows[0]?.label).toContain('DELETE Contact');
    expect(view.destructiveRows[0]?.warnings.join(' ')).toContain('Recycle Bin');
    expect(JSON.stringify(view)).not.toContain('BULK-CODE');

    // An agent bulk_load_execute with no human-typed code holds on the
    // 'bulk' kind and the decision drives executeBulkLoad — NEVER executeDml
    // (the DML fallthrough was the trap here).
    const held = service.interceptAgentExecute('s-bulk', 'bulk', connId);
    expect(held).not.toBeNull();
    await service.approve(id, 'load it');
    expect(executed).toEqual([{ connId, code: 'BULK-CODE', kind: 'bulk' }]);
    const result = await held!;
    expect(result.isError).not.toBe(true);
    expect(result.content[0]!.text).toContain('"approved": true');
  });

  it('a bulk outcome with executed:false is a FAILURE to the review flow and the held agent call', async () => {
    bulkExecutedOk = false;
    const connId = seedConnection('developer', 'dev');
    const id = seedBulkRequest(connId, 's-bulk2');
    const held = service.interceptAgentExecute('s-bulk2', 'bulk', connId);
    await service.approve(id, 'try it');
    const result = await held!;
    // outcomeFailed understands the bulk payload's `executed` key — a partial
    // load must never read back to the agent as a success.
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('execution failed');
    expect(result.content[0]!.text).toContain('"total_failed": 2');
  });

  it('a deploy hold is NOT satisfied by a bulk decision (kind is identity)', () => {
    const connId = seedConnection('developer', 'dev');
    seedBulkRequest(connId, 's-y');
    expect(service.interceptAgentExecute('s-y', 'deploy', connId)).toBeNull();
  });
});

describe('bulk_load_propose path resolution (S27 silo)', () => {
  it('strips agent-supplied abs_path, resolves {folder, path} in the linked folder, refuses escapes', async () => {
    const projects = new ProjectService(deps);
    const project = projects.create('Migration Project');
    const connId = seedConnection('developer', 'dev');
    db.addProjectBinding(project.id, connId, 'dev');

    // A real linked folder with a real CSV, and a secret OUTSIDE it.
    const folderDir = path.join(tmp, 'MigrationData');
    fs.mkdirSync(folderDir, { recursive: true });
    fs.writeFileSync(path.join(folderDir, 'good.csv'), 'Name\nAcme\n');
    fs.writeFileSync(path.join(folderDir, 'notes.txt'), 'not a csv');
    fs.writeFileSync(path.join(tmp, 'secret.csv'), 'Name\nleaked\n');
    projects.linkFolder(project.id, folderDir);

    const run = new AgentSessionRun(
      deps,
      {
        project: { id: project.id, name: 'Migration Project', description: null, instructions: null },
        bindings: [],
        model: 'claude-haiku-4-5',
        maxTurns: 10,
        maxBudgetUsd: 0.5,
      },
      'session-bulk',
      projects,
      () => service,
    );

    // THE SPOOF: the agent names a real {folder, path} but smuggles an
    // abs_path of its own choosing. The host must strip it and inject the
    // resolved linked-folder path.
    const spoofed = await run.executeCapability('bulk_load_propose', {
      connection: 'dev',
      steps: [
        {
          folder: 'MigrationData',
          path: 'good.csv',
          object: 'Account',
          operation: 'insert',
          abs_path: path.join(tmp, 'secret.csv'),
        },
      ],
    });
    expect(spoofed.isError).toBeFalsy();
    expect(bulkProposals).toHaveLength(1);
    const sent = String(bulkProposals[0]!.steps[0]!.sourcePath);
    expect(sent).toBe(fs.realpathSync(path.join(folderDir, 'good.csv')));
    expect(sent).not.toContain('secret');

    // Traversal out of the folder is refused before the engine hears of it.
    const escape = await run.executeCapability('bulk_load_propose', {
      connection: 'dev',
      steps: [
        { folder: 'MigrationData', path: '../secret.csv', object: 'Account', operation: 'insert' },
      ],
    });
    expect(escape.isError).toBe(true);
    expect(escape.content[0]!.text).toMatch(/without "\.\."|outside the linked folder/);
    expect(bulkProposals).toHaveLength(1);

    // Non-CSV files are not bulk sources, even inside the folder.
    const wrongType = await run.executeCapability('bulk_load_propose', {
      connection: 'dev',
      steps: [
        { folder: 'MigrationData', path: 'notes.txt', object: 'Account', operation: 'insert' },
      ],
    });
    expect(wrongType.isError).toBe(true);
    expect(wrongType.content[0]!.text).toContain('.csv files only');
    expect(bulkProposals).toHaveLength(1);
  });
});

describe('anonymous Apex at the native seam (S22)', () => {
  it('a plugin-proposed apex row shows the script, hides the code, and approve drives executeApex', async () => {
    const connId = seedConnection('developer', 'dev');
    const script = "List<Account> a = [SELECT Id FROM Account];\ndelete a;";
    // Proposed via the PLUGIN (shared DB): kind 'apex', payload carries the
    // script, no desktop review_json. The screen must show the script — an
    // approvable blank for a script would be the worst blank of all.
    const rec = db.insertDeployRequest({
      connectionId: connId,
      kind: 'apex',
      confirmationCode: 'APEX-CODE',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      payloadJson: JSON.stringify({ apex: true, code: script }),
      summaryJson: JSON.stringify({ lines: 2, chars: script.length }),
    });

    const view = service.get(rec.id);
    expect(view.kind).toBe('apex');
    expect(view.changeRows[0]?.label).toContain('anonymous Apex');
    expect(view.changeRows[0]?.detail).toBe(script);
    expect(view.changeRows[0]?.warnings.join(' ')).toContain('COMMITS');
    // The code never rides along in any view field.
    expect(JSON.stringify(view)).not.toContain('APEX-CODE');

    // An agent apex_execute with no human-typed code is held on the 'apex'
    // kind and resolved by the human's decision — driving executeApex, never
    // executeDml.
    const held = service.interceptAgentExecute('s-apex', 'apex', connId);
    expect(held).not.toBeNull();
    await service.approve(rec.id, 'run it');
    const result = await held!;
    expect(result.isError).not.toBe(true);
    expect(executed).toEqual([{ connId, code: 'APEX-CODE', kind: 'apex' }]);
  });
});
