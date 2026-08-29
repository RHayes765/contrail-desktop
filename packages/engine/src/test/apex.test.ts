import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ContrailDb } from '../core/db.js';
import { MemoryTokenStore } from '../core/keychain.js';
import { DEFAULT_CONFIG, type ContrailConfig } from '../core/config.js';
import { SnapshotStore } from '../snapshot/store.js';
import {
  ApprovalPageServer,
  type ApprovalPresentation,
  type ApprovalPresenter,
  type ApprovalRequestView,
} from '../deploy/approval.js';
import { createEngineDeps, type EngineDeps } from '../core/deps.js';
import { invokeCapability, type ToolResult } from '../capabilities/index.js';
import { emptyGrantSet } from '../core/grants.js';

/**
 * S22 tests (desktop mirror of the plugin's apex.test.ts): anonymous Apex
 * behind the full approval ritual (kind 'apex' on the shared claim machinery),
 * and set_trace_flag. The presenter seam is structured here, so codes and the
 * verbatim script are read off the captured ApprovalRequestView.
 */

let tmp: string;
let db: ContrailDb;
let deps: EngineDeps;
let presenter: RecordingPresenter;

let execResult: {
  line: number;
  column: number;
  compiled: boolean;
  success: boolean;
  compileProblem: string | null;
  exceptionMessage: string | null;
  exceptionStackTrace: string | null;
};
let lastAnonymousBody: string | null;
let executeCalls: number;
let traceFlagRows: Array<{ Id: string; ExpirationDate: string | null }>;
let debugLevelRows: Array<{ Id: string }>;
let userRows: Array<{ Id: string }>;
let postedDebugLevel: Record<string, unknown> | null;
let postedTraceFlag: Record<string, unknown> | null;
let patchedTraceFlag: { id: string; body: Record<string, unknown> } | null;

class RecordingPresenter implements ApprovalPresenter {
  readonly views: ApprovalRequestView[] = [];
  private readonly inner = new ApprovalPageServer(async () => {});
  async present(
    view: ApprovalRequestView,
    statusCheck?: () => { active: boolean; status: string },
    ttlMs?: number,
  ): Promise<ApprovalPresentation> {
    this.views.push(view);
    return this.inner.present(view, statusCheck, ttlMs);
  }
  close(id: string): void {
    this.inner.close(id);
  }
}

function successExec(): typeof execResult {
  return {
    line: -1,
    column: -1,
    compiled: true,
    success: true,
    compileProblem: null,
    exceptionMessage: null,
    exceptionStackTrace: null,
  };
}

function stubSalesforce(): void {
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/services/oauth2/token')) {
      return new Response(
        JSON.stringify({
          access_token: 'AT',
          instance_url: 'https://apex.stub.salesforce.com',
          id: 'https://login.salesforce.com/id/00D1/0051',
          token_type: 'Bearer',
        }),
      );
    }
    if (url.includes('/tooling/executeAnonymous/')) {
      executeCalls += 1;
      lastAnonymousBody = new URL(url).searchParams.get('anonymousBody');
      return new Response(JSON.stringify(execResult));
    }
    // Tooling query must be matched BEFORE the generic /query?q= branch.
    if (url.includes('/tooling/query?q=')) {
      const q = decodeURIComponent(url);
      if (q.includes('FROM TraceFlag')) {
        return new Response(JSON.stringify({ totalSize: traceFlagRows.length, done: true, records: traceFlagRows }));
      }
      if (q.includes('FROM DebugLevel')) {
        return new Response(JSON.stringify({ totalSize: debugLevelRows.length, done: true, records: debugLevelRows }));
      }
      return new Response(JSON.stringify({ totalSize: 0, done: true, records: [] }));
    }
    if (url.includes('/query?q=')) {
      const q = decodeURIComponent(url);
      if (q.includes('FROM User')) {
        return new Response(JSON.stringify({ totalSize: userRows.length, done: true, records: userRows }));
      }
      return new Response(JSON.stringify({ totalSize: 0, done: true, records: [] }));
    }
    if (url.endsWith('/tooling/sobjects/DebugLevel') && method === 'POST') {
      postedDebugLevel = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return new Response(JSON.stringify({ id: '7dl000000000001AAA', success: true }), { status: 201 });
    }
    if (url.endsWith('/tooling/sobjects/TraceFlag') && method === 'POST') {
      postedTraceFlag = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return new Response(JSON.stringify({ id: '7tf000000000001AAA', success: true }), { status: 201 });
    }
    if (url.includes('/tooling/sobjects/TraceFlag/') && method === 'PATCH') {
      patchedTraceFlag = {
        id: url.split('/').pop()!,
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      };
      return new Response(null, { status: 204 });
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-apex-'));
  process.env.CONTRAIL_DATA_DIR = tmp;
  db = new ContrailDb(path.join(tmp, 'test.db'));
  presenter = new RecordingPresenter();
  execResult = successExec();
  lastAnonymousBody = null;
  executeCalls = 0;
  traceFlagRows = [];
  debugLevelRows = [];
  userRows = [{ Id: '005000000000009AAA' }];
  postedDebugLevel = null;
  postedTraceFlag = null;
  patchedTraceFlag = null;

  const tokens = new MemoryTokenStore();
  const grants = emptyGrantSet();
  grants.metadata_read = true;
  grants.data_read = true;
  grants.data_write = true;
  grants.diagnostics_read = true;
  const conn = db.insertConnection({
    alias: 'apex-org',
    instanceUrl: 'https://apex.stub.salesforce.com',
    loginUrl: 'https://login.salesforce.com',
    orgId: '00D1',
    orgName: 'Apex Org',
    orgType: 'developer',
    isSandbox: false,
    username: 'dev@apex.example',
    userId: '005000000000001AAA',
    grants,
  });
  tokens.setRefreshToken(conn.id, 'RT');

  const roGrants = emptyGrantSet();
  roGrants.data_read = true;
  const ro = db.insertConnection({
    alias: 'no-writes',
    instanceUrl: 'https://apex.stub.salesforce.com',
    loginUrl: 'https://login.salesforce.com',
    orgId: '00D2',
    orgName: 'RO',
    orgType: 'production',
    isSandbox: false,
    username: null,
    userId: null,
    grants: roGrants,
  });
  tokens.setRefreshToken(ro.id, 'RT');

  const diagGrants = emptyGrantSet();
  diagGrants.diagnostics_read = true;
  const noId = db.insertConnection({
    alias: 'username-only',
    instanceUrl: 'https://apex.stub.salesforce.com',
    loginUrl: 'https://login.salesforce.com',
    orgId: '00D3',
    orgName: 'Username Only',
    orgType: 'sandbox',
    isSandbox: true,
    username: 'fallback@apex.example',
    userId: null,
    grants: { ...diagGrants },
  });
  tokens.setRefreshToken(noId.id, 'RT');
  const noIdentity = db.insertConnection({
    alias: 'no-identity',
    instanceUrl: 'https://apex.stub.salesforce.com',
    loginUrl: 'https://login.salesforce.com',
    orgId: '00D4',
    orgName: 'No Identity',
    orgType: 'sandbox',
    isSandbox: true,
    username: null,
    userId: null,
    grants: { ...diagGrants },
  });
  tokens.setRefreshToken(noIdentity.id, 'RT');

  stubSalesforce();

  const config: ContrailConfig = {
    ...DEFAULT_CONFIG,
    salesforce: { ...DEFAULT_CONFIG.salesforce },
    oauth: { ...DEFAULT_CONFIG.oauth },
    snapshot: { ...DEFAULT_CONFIG.snapshot },
    deploy: { ...DEFAULT_CONFIG.deploy, pollIntervalMs: 10, toolWaitMs: 10_000 },
  };
  deps = createEngineDeps({
    db,
    tokens,
    config,
    store: new SnapshotStore(path.join(tmp, 'snapshots')),
    approvals: presenter,
    flowOps: {
      exchangeCode: async () => {
        throw new Error('not used');
      },
      fetchOrgInfo: async () => {
        throw new Error('not used');
      },
      fetchIdentity: async () => ({ username: null, userId: null, displayName: null }),
      revokeToken: async () => ({ ok: true }),
      openBrowser: async () => {},
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  db.close();
  delete process.env.CONTRAIL_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const SCRIPT = `List<Account> stale = [SELECT Id FROM Account WHERE Name = 'Zombie'];
delete stale;
System.debug('cleaned ' + stale.size());`;

async function propose(code = SCRIPT, connection = 'apex-org') {
  return invokeCapability(deps, 'apex_propose', { connection, code });
}

async function execute(confirmationCode: string, connection = 'apex-org') {
  return invokeCapability(deps, 'apex_execute', {
    connection,
    confirmation_code: confirmationCode,
  });
}

describe('anonymous Apex ritual', () => {
  it('propose → human code → execute; the org gets the exact script; DML-commits note is honest', async () => {
    const proposed = await propose();
    const proposedText = textOf(proposed);
    expect(proposed.isError ?? false).toBe(false);
    expect(proposedText).toContain('nothing executed');

    // The structured view carries the warning, the verbatim script, and the code.
    expect(presenter.views).toHaveLength(1);
    const view = presenter.views[0]!;
    expect(view.kind).toBe('apex');
    expect(view.warnings?.join(' ')).toContain('ANONYMOUS APEX');
    expect(view.changes[0]?.detail).toBe(SCRIPT);
    const code = view.code;
    // The code exists ONLY on the approval surface — never in the tool result.
    expect(proposedText).not.toContain(code);

    const executed = await execute(code);
    const body = JSON.parse(textOf(executed)) as Record<string, unknown>;
    expect(body.executed).toBe(true);
    expect(body.status).toBe('executed');
    expect(String(body.note)).toContain('COMMITTED');
    // What ran is byte-identical to what was approved.
    expect(lastAnonymousBody).toBe(SCRIPT);
  });

  it('never executes without the code, and refuses a code-less call with guidance', async () => {
    await propose();
    expect(executeCalls).toBe(0);

    const wrong = await execute('AAAA-2222');
    expect(wrong.isError).toBe(true);
    expect(textOf(wrong)).toContain('No Apex script on "apex-org" matches that code');

    const noCode = await invokeCapability(deps, 'apex_execute', { connection: 'apex-org' });
    expect(noCode.isError).toBe(true);
    expect(textOf(noCode)).toContain('No confirmation code');
    expect(executeCalls).toBe(0);
  });

  it('a compile error spends the code and reports that nothing ran', async () => {
    execResult = {
      ...successExec(),
      compiled: false,
      line: 2,
      column: 8,
      compileProblem: 'Unexpected token: delete',
    };
    await propose();
    const code = presenter.views[0]!.code;
    const result = JSON.parse(textOf(await execute(code))) as Record<string, unknown>;
    expect(result.executed).toBe(false);
    expect(result.status).toBe('compile_error');
    expect(result.compile_error).toMatchObject({ line: 2, column: 8, problem: 'Unexpected token: delete' });
    expect(String(result.note)).toContain('nothing ran');

    // Spent: the same code now returns the stored terminal result, no re-run.
    const again = JSON.parse(textOf(await execute(code))) as Record<string, unknown>;
    expect(again.already_completed).toBe(true);
    expect(executeCalls).toBe(1);
  });

  it('a runtime error reports the rollback honestly', async () => {
    execResult = {
      ...successExec(),
      success: false,
      exceptionMessage: 'System.LimitException: Too many SOQL queries: 101',
      exceptionStackTrace: 'AnonymousBlock: line 1, column 1',
    };
    await propose();
    const result = JSON.parse(textOf(await execute(presenter.views[0]!.code))) as Record<
      string,
      unknown
    >;
    expect(result.executed).toBe(false);
    expect(result.status).toBe('runtime_error');
    expect(String(result.note)).toContain('NOT committed');
  });

  it('a new proposal supersedes the previous code', async () => {
    await propose();
    const first = presenter.views[0]!.code;
    await propose("System.debug('v2');");
    const stale = await execute(first);
    expect(stale.isError).toBe(true);
    expect(textOf(stale)).toContain('superseded');
    expect(executeCalls).toBe(0);
  });

  it('refuses empty scripts and ungranted connections', async () => {
    const empty = await propose('   \n  ');
    expect(empty.isError).toBe(true);
    expect(textOf(empty)).toContain('script is empty');

    const overCap = await propose('x'.repeat(32_001));
    expect(overCap.isError).toBe(true);

    const ungranted = await propose(SCRIPT, 'no-writes');
    expect(ungranted.isError).toBe(true);
    expect(textOf(ungranted)).toContain('data_write');
  });

  it('mentions the debug log when a trace flag was active during the run', async () => {
    traceFlagRows = [{ Id: '7tf000000000009AAA', ExpirationDate: '2999-01-01T00:00:00.000Z' }];
    await propose();
    const result = JSON.parse(textOf(await execute(presenter.views[0]!.code))) as Record<
      string,
      unknown
    >;
    expect(String(result.debug_log)).toContain('get_debug_logs');
  });
});

describe('set_trace_flag', () => {
  async function setFlag(connection = 'apex-org', minutes?: number) {
    return invokeCapability(deps, 'set_trace_flag', {
      connection,
      ...(minutes !== undefined ? { minutes } : {}),
    });
  }

  it('creates the Contrail_Debug level and a USER_DEBUG flag when neither exists', async () => {
    const result = JSON.parse(textOf(await setFlag())) as Record<string, unknown>;
    expect(result.action).toBe('created');
    expect(result.debug_level).toBe('Contrail_Debug');
    expect(postedDebugLevel).toMatchObject({
      DeveloperName: 'Contrail_Debug',
      ApexCode: 'DEBUG',
      System: 'DEBUG',
    });
    expect(postedTraceFlag).toMatchObject({
      TracedEntityId: '005000000000001AAA',
      LogType: 'USER_DEBUG',
      DebugLevelId: '7dl000000000001AAA',
    });
    const expires = new Date(String(result.expires_at)).getTime();
    expect(Math.abs(expires - (Date.now() + 30 * 60_000))).toBeLessThan(15_000);
  });

  it('reuses an existing Contrail_Debug level instead of creating a second one', async () => {
    debugLevelRows = [{ Id: '7dl00000000000eAAA' }];
    await setFlag();
    expect(postedDebugLevel).toBeNull();
    expect(postedTraceFlag).toMatchObject({ DebugLevelId: '7dl00000000000eAAA' });
  });

  it('extends an existing flag rather than stacking a second one', async () => {
    traceFlagRows = [{ Id: '7tf00000000000eAAA', ExpirationDate: '2020-01-01T00:00:00.000Z' }];
    const result = JSON.parse(textOf(await setFlag('apex-org', 45))) as Record<string, unknown>;
    expect(result.action).toBe('extended');
    expect(postedTraceFlag).toBeNull();
    expect(patchedTraceFlag?.id).toBe('7tf00000000000eAAA');
    const patched = new Date(String(patchedTraceFlag?.body.ExpirationDate)).getTime();
    expect(Math.abs(patched - (Date.now() + 45 * 60_000))).toBeLessThan(15_000);
  });

  it('falls back to a username lookup when the stored user id is missing', async () => {
    await setFlag('username-only');
    expect(postedTraceFlag).toMatchObject({ TracedEntityId: '005000000000009AAA' });
  });

  it('refuses a connection with no identity, and one without diagnostics_read', async () => {
    const noIdentity = await setFlag('no-identity');
    expect(noIdentity.isError).toBe(true);
    expect(textOf(noIdentity)).toContain('Re-connect');

    const noGrant = await setFlag('no-writes');
    expect(noGrant.isError).toBe(true);
    expect(textOf(noGrant)).toContain('diagnostics_read');
  });
});
