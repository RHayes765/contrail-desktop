import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ContrailDb } from '../core/db.js';
import { MemoryTokenStore } from '../core/keychain.js';
import { DEFAULT_CONFIG } from '../core/config.js';
import { SnapshotStore } from '../snapshot/store.js';
import { createEngineDeps, type EngineDeps } from '../core/deps.js';
import { invokeCapability, type ToolResult } from '../capabilities/index.js';
import { emptyGrantSet } from '../core/grants.js';

/**
 * S35 (desktop mirror of the plugin's agenteval.test.ts, condensed): the
 * pins that carry the contract — the dual-grant MODE SPLIT (submit needs
 * data_write on top of diagnostics_read; polling does not) and pass-field
 * tolerance for both observed result schemas.
 */

let tmp: string;
let db: ContrailDb;
let deps: EngineDeps;
let submitPosts: Array<Record<string, unknown>>;
let runStatus: Record<string, unknown>;
let runResults: Record<string, unknown>;

const RUN_ID = '4KB000000000001AAA';

function stubSalesforce(): void {
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/services/oauth2/token')) {
      return new Response(
        JSON.stringify({
          access_token: 'AT',
          instance_url: 'https://eval.stub.salesforce.com',
          id: 'https://login.salesforce.com/id/00D1/0051',
          token_type: 'Bearer',
        }),
      );
    }
    if (url.endsWith('/einstein/ai-evaluations/runs') && method === 'POST') {
      submitPosts.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return new Response(JSON.stringify({ runId: RUN_ID, status: 'NEW' }));
    }
    if (/\/einstein\/ai-evaluations\/runs\/[a-zA-Z0-9]+\/results$/.test(url)) {
      return new Response(JSON.stringify(runResults));
    }
    if (/\/einstein\/ai-evaluations\/runs\/[a-zA-Z0-9]+$/.test(url)) {
      return new Response(JSON.stringify(runStatus));
    }
    return new Response('not found', { status: 404 });
  });
}

function textOf(result: ToolResult): string {
  return result.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-eval-'));
  process.env.CONTRAIL_DATA_DIR = tmp;
  db = new ContrailDb(path.join(tmp, 'test.db'));
  submitPosts = [];
  runStatus = { status: 'IN_PROGRESS' };
  runResults = {};

  const tokens = new MemoryTokenStore();
  const diagOnly = emptyGrantSet();
  diagOnly.diagnostics_read = true;
  const conn = db.insertConnection({
    alias: 'diag-only',
    instanceUrl: 'https://eval.stub.salesforce.com',
    loginUrl: 'https://login.salesforce.com',
    orgId: '00D1',
    orgName: 'Diag Only',
    orgType: 'sandbox',
    isSandbox: true,
    username: null,
    userId: null,
    grants: diagOnly,
  });
  tokens.setRefreshToken(conn.id, 'RT');

  const full = emptyGrantSet();
  full.diagnostics_read = true;
  full.data_read = true;
  full.data_write = true;
  const fullConn = db.insertConnection({
    alias: 'eval-org',
    instanceUrl: 'https://eval.stub.salesforce.com',
    loginUrl: 'https://login.salesforce.com',
    orgId: '00D2',
    orgName: 'Eval Org',
    orgType: 'developer',
    isSandbox: false,
    username: null,
    userId: null,
    grants: full,
  });
  tokens.setRefreshToken(fullConn.id, 'RT');

  stubSalesforce();
  deps = createEngineDeps({
    db,
    tokens,
    config: { ...DEFAULT_CONFIG },
    store: new SnapshotStore(path.join(tmp, 'snapshots')),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  db.close();
  delete process.env.CONTRAIL_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('run_agent_eval (desktop engine)', () => {
  it('THE MODE SPLIT: diagnostics-only polls but cannot start (audited refusal)', async () => {
    const poll = await invokeCapability(deps, 'run_agent_eval', {
      connection: 'diag-only',
      run_id: RUN_ID,
    });
    expect(poll.isError ?? false).toBe(false);

    const start = await invokeCapability(deps, 'run_agent_eval', {
      connection: 'diag-only',
      eval: 'Order_Agent_Smoke',
    });
    expect(start.isError).toBe(true);
    expect(textOf(start)).toContain('data_write');
    expect(submitPosts).toHaveLength(0);
    const audits = db.queryAuditEvents({ limit: 10 });
    expect(
      audits.some(
        (a) =>
          a.eventType === 'grant.refused' &&
          JSON.stringify(a.detail ?? {}).includes('agent_eval_start'),
      ),
    ).toBe(true);
  });

  it('submits with data_write and tolerates both pass-field schemas on results', async () => {
    const submitted = await invokeCapability(deps, 'run_agent_eval', {
      connection: 'eval-org',
      eval: 'Order_Agent_Smoke',
    });
    expect(JSON.parse(textOf(submitted)).run_id).toBe(RUN_ID);
    expect(submitPosts).toEqual([{ aiEvaluationDefinitionName: 'Order_Agent_Smoke' }]);

    runStatus = { status: 'COMPLETED' };
    runResults = {
      testCases: [
        {
          status: 'PASSED',
          testNumber: 1,
          inputs: { utterance: 'hi' },
          generatedData: { topic: 'T', actionsSequence: [] },
          testResults: [
            { name: 'topic_sequence_match', metricScore: 'FAILED' },
            { name: 'action_sequence_match', result: 'PASS', score: 1 },
            { name: 'instruction_adherence', metricScore: 'HIGH' },
          ],
        },
      ],
    };
    const done = JSON.parse(
      textOf(await invokeCapability(deps, 'run_agent_eval', { connection: 'eval-org', run_id: RUN_ID })),
    ) as { cases: Array<{ expectations: Array<{ passed: boolean | null }> }> };
    expect(done.cases[0]!.expectations.map((e) => e.passed)).toEqual([false, true, null]);
  });

  it('S40: case verdicts derive from EXPECTATIONS, never the completion status', async () => {
    runStatus = { status: 'COMPLETED', startTime: 't0', endTime: 't1' };
    const mkCase = (n: number, rows: Array<Record<string, unknown>>) => ({
      // The org's case status is a completion marker, not a pass
      // (live-confirmed "COMPLETED") — it must not drive the buckets.
      status: 'COMPLETED',
      testNumber: n,
      inputs: { utterance: 'u' },
      generatedData: { topic: 'T', actionsSequence: [], outcome: 'ok' },
      testResults: rows,
    });
    runResults = {
      subjectName: 'Order_Agent',
      testCases: [
        mkCase(1, [{ name: 'a', result: 'PASS' }, { name: 'b', result: 'PASS' }]),
        mkCase(2, [{ name: 'a', result: 'PASS' }, { name: 'b', result: 'FAILURE' }]),
        mkCase(3, [{ name: 'a', result: 'PASS' }, { name: 'judge', metricScore: 'HIGH' }]),
        mkCase(4, []),
      ],
    };
    const parsed = JSON.parse(
      textOf(await invokeCapability(deps, 'run_agent_eval', { connection: 'eval-org', run_id: RUN_ID })),
    ) as {
      totals: { cases: number; passed: number; failed: number; indeterminate: number };
      cases: Array<{ verdict: string; status: string }>;
    };
    expect(parsed.cases.map((c) => c.verdict)).toEqual([
      'passed',
      'failed',
      'indeterminate', // a null-verdict label metric means READ the rows
      'indeterminate', // no expectations at all is never a pass
    ]);
    expect(parsed.totals).toEqual({ cases: 4, passed: 1, failed: 1, indeterminate: 2 });
    // The raw status stays visible — derivation is additive, not a rewrite.
    expect(parsed.cases[0]!.status).toBe('COMPLETED');
  });
});
