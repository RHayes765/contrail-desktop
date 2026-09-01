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
import { invokeCapability } from '../capabilities/index.js';
import { emptyGrantSet } from '../core/grants.js';
import { deploysDir } from '../core/paths.js';

/**
 * S27 bulk-load tests at the capability surface (the engine internals are
 * pinned byte-identically by the plugin repo's bulk suite). What THIS suite
 * pins: the ritual holds for kind 'bulk' through invokeCapability; the
 * abs_path host-injection contract (a step without one is refused — the
 * desktop's agentRuntime is the only thing that mints them); the structured
 * approval view carries the whole plan and the code while the tool result
 * carries neither code nor row data; frozen payload directories are created,
 * superseded, and cleaned.
 */

let tmp: string;
let db: ContrailDb;
let deps: EngineDeps;
let presenter: RecordingPresenter;

let createdJobs: Array<{ id: string; body: Record<string, unknown> }>;
let uploads: Map<string, string>;
let patches: Array<{ jobId: string; state: string }>;
let failedRowsByJobIndex: Map<number, number>;

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

function stubSalesforce(): void {
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/services/oauth2/token')) {
      return new Response(
        JSON.stringify({
          access_token: 'AT',
          instance_url: 'https://bulk.stub.salesforce.com',
          id: 'https://login.salesforce.com/id/00D9/0059',
          token_type: 'Bearer',
        }),
      );
    }
    if (/\/jobs\/ingest\/?$/.test(url) && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      const id = `750BULK00000${createdJobs.length + 1}`;
      createdJobs.push({ id, body });
      return new Response(JSON.stringify({ id, state: 'Open' }));
    }
    const batches = /\/jobs\/ingest\/([^/]+)\/batches\/?$/.exec(url);
    if (batches && method === 'PUT') {
      uploads.set(batches[1]!, String(init?.body ?? ''));
      return new Response('', { status: 201 });
    }
    const failedRes = /\/jobs\/ingest\/([^/]+)\/failedResults\/?$/.exec(url);
    if (failedRes) {
      const idx = createdJobs.findIndex((j) => j.id === failedRes[1]);
      const n = failedRowsByJobIndex.get(idx) ?? 0;
      const rows = Array.from({ length: n }, (_, i) => `"badrow${i + 1}","","MALFORMED_ID:bad"`);
      return new Response(['"Name","sf__Id","sf__Error"', ...rows, ''].join('\n'));
    }
    if (/\/unprocessedrecords\/?$/.test(url)) {
      return new Response('"Name"\n');
    }
    const jobUrl = /\/jobs\/ingest\/([^/]+)\/?$/.exec(url);
    if (jobUrl && method === 'PATCH') {
      const state = (JSON.parse(String(init?.body ?? '{}')) as { state?: string }).state ?? '';
      patches.push({ jobId: jobUrl[1]!, state });
      return new Response(JSON.stringify({ id: jobUrl[1], state }));
    }
    if (jobUrl && method === 'GET') {
      const jobId = jobUrl[1]!;
      const idx = createdJobs.findIndex((j) => j.id === jobId);
      const rows = (uploads.get(jobId) ?? '').trim().split(/\r?\n/).length - 1;
      const failed = failedRowsByJobIndex.get(idx) ?? 0;
      return new Response(
        JSON.stringify({
          id: jobId,
          state: 'JobComplete',
          numberRecordsProcessed: Math.max(rows, 0),
          numberRecordsFailed: failed,
          errorMessage: null,
        }),
      );
    }
    return new Response('not found', { status: 404 });
  });
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? '').join('\n');
}

function writeCsv(name: string, content: string): string {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, content);
  return p;
}

function payloadDirs(): string[] {
  return fs
    .readdirSync(deploysDir())
    .filter(
      (e) =>
        fs.statSync(path.join(deploysDir(), e)).isDirectory() &&
        !e.startsWith('bulk-stage-') &&
        !e.endsWith('-results'),
    )
    .map((e) => path.join(deploysDir(), e));
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-dbulk-'));
  process.env.CONTRAIL_DATA_DIR = tmp;
  db = new ContrailDb(path.join(tmp, 'test.db'));
  createdJobs = [];
  uploads = new Map();
  patches = [];
  failedRowsByJobIndex = new Map();

  const tokens = new MemoryTokenStore();
  const grants = emptyGrantSet();
  grants.data_read = true;
  grants.data_write = true;
  const conn = db.insertConnection({
    alias: 'bulk-org',
    instanceUrl: 'https://bulk.stub.salesforce.com',
    loginUrl: 'https://login.salesforce.com',
    orgId: '00D9',
    orgName: 'Bulk Org',
    orgType: 'developer',
    isSandbox: false,
    username: null,
    userId: null,
    grants,
  });
  tokens.setRefreshToken(conn.id, 'RT');
  stubSalesforce();
  presenter = new RecordingPresenter();

  const config: ContrailConfig = {
    ...DEFAULT_CONFIG,
    salesforce: { ...DEFAULT_CONFIG.salesforce },
    oauth: { ...DEFAULT_CONFIG.oauth },
    snapshot: { ...DEFAULT_CONFIG.snapshot },
    deploy: { ...DEFAULT_CONFIG.deploy },
    bulkLoad: { ...DEFAULT_CONFIG.bulkLoad, pollIntervalMs: 5, toolWaitMs: 10_000 },
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

const ACCOUNTS_CSV = 'Name,External_Id__c\nAcme,A-1\nGlobex,A-2\n';

function stepArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const abs = writeCsv('accounts.csv', ACCOUNTS_CSV);
  return {
    folder: 'Migration',
    path: 'accounts.csv',
    object: 'Account',
    operation: 'insert',
    abs_path: abs,
    ...overrides,
  };
}

async function propose(args: Record<string, unknown>) {
  return invokeCapability(deps, 'bulk_load_propose', { connection: 'bulk-org', ...args });
}

async function execute(code?: string) {
  return invokeCapability(deps, 'bulk_load_execute', {
    connection: 'bulk-org',
    ...(code ? { confirmation_code: code } : {}),
  });
}

describe('bulk_load capabilities', () => {
  it('carries the plan and code on the approval view, never in the tool result', async () => {
    const res = await propose({
      steps: [
        stepArgs(),
        stepArgs({
          path: 'del.csv',
          operation: 'delete',
          abs_path: writeCsv('del.csv', 'Id\n001000000000001AAA\n'),
        }),
      ],
    });
    expect(res.isError ?? false).toBe(false);
    const text = textOf(res);
    const view = presenter.views.at(-1)!;

    expect(view.kind).toBe('bulk');
    expect(text).not.toContain(view.code);
    expect(text).toContain('"total_rows": 3');
    expect(text).not.toContain('Acme'); // row data never reaches the agent

    expect(view.changes.some((c) => c.label.includes('STEP 1  INSERT Account — 2 rows'))).toBe(true);
    expect(view.destructive.some((c) => c.label.includes('STEP 2  DELETE Account — 1 row'))).toBe(
      true,
    );
    expect(
      view.destructive.some((c) => c.warnings.some((w) => w.includes('Recycle Bin'))),
    ).toBe(true);
    expect(view.warnings?.some((w) => w.includes('NOT atomic'))).toBe(true);
    expect(view.results.some((r) => r.value.includes('stop-on-failure'))).toBe(true);
    // The human sees the linked-folder coordinates, and the payload is frozen.
    expect(view.changes.some((c) => (c.detail ?? '').includes('Migration/accounts.csv'))).toBe(
      true,
    );
    const [dir] = payloadDirs();
    expect(fs.readFileSync(path.join(dir!, 'step-1.csv'), 'utf8')).toBe(ACCOUNTS_CSV);
  });

  it('refuses a step without the host-injected abs_path — direct paths never reach the engine', async () => {
    const res = await propose({ steps: [{ ...stepArgs(), abs_path: undefined }] });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('resolved by the desktop app');
    expect(payloadDirs()).toHaveLength(0);
  });

  it('executes sequentially with the code, cleans the payload, and replays terminally', async () => {
    await propose({
      steps: [
        stepArgs(),
        stepArgs({
          path: 'contacts.csv',
          object: 'Contact',
          operation: 'upsert',
          external_id_field: 'Ext__c',
          abs_path: writeCsv('contacts.csv', 'LastName,Ext__c,Account.External_Id__c\nAsh,C-1,A-1\n'),
        }),
      ],
    });
    const code = presenter.views.at(-1)!.code;
    const [payloadDir] = payloadDirs();
    const res = await execute(code);
    const text = textOf(res);

    expect(text).toContain('"executed": true');
    expect(createdJobs.map((j) => j.body.object)).toEqual(['Account', 'Contact']);
    expect(createdJobs[1]!.body.externalIdFieldName).toBe('Ext__c');
    expect(patches.filter((p) => p.state === 'UploadComplete')).toHaveLength(2);
    expect(fs.existsSync(payloadDir!)).toBe(false);

    const replay = textOf(await execute(code));
    expect(replay).toContain('"already_completed": true');
    expect(createdJobs).toHaveLength(2);
  });

  it('reports failed rows as file paths and skips later steps; the results dir survives', async () => {
    failedRowsByJobIndex.set(0, 1);
    await propose({
      steps: [
        stepArgs(),
        stepArgs({ path: 'more.csv', abs_path: writeCsv('more.csv', 'Name\nInitech\n') }),
      ],
    });
    const code = presenter.views.at(-1)!.code;
    const [payloadDir] = payloadDirs();
    const text = textOf(await execute(code));

    expect(text).toContain('"executed": false');
    expect(text).toContain('"state": "Skipped"');
    expect(text).toContain('step-1-failed.csv');
    expect(text).not.toContain('badrow');
    expect(fs.readFileSync(path.join(`${payloadDir}-results`, 'step-1-failed.csv'), 'utf8')).toContain(
      'badrow1',
    );
    expect(fs.existsSync(payloadDir!)).toBe(false);
    expect(createdJobs).toHaveLength(1);
  });

  it('supersedes the pending plan and deletes its payload DIRECTORY on re-propose', async () => {
    await propose({ steps: [stepArgs()] });
    const oldCode = presenter.views.at(-1)!.code;
    const [oldDir] = payloadDirs();
    await propose({ steps: [stepArgs()] });
    expect(fs.existsSync(oldDir!)).toBe(false);
    expect(payloadDirs()).toHaveLength(1);
    const res = await execute(oldCode);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('superseded');
  });

  it('a codeless execute is refused at the capability (native approval lives upstream)', async () => {
    await propose({ steps: [stepArgs()] });
    const res = await execute();
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('no pending native approval');
    // A wrong code speaks the bulk noun.
    const wrong = await execute('XXXX-XXXX');
    expect(textOf(wrong)).toContain('No bulk data load on "bulk-org"');
  });
});
