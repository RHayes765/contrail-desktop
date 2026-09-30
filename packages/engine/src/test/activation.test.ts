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
 * S34 (desktop mirror of the plugin's activation.test.ts): agent activation
 * behind the full ritual — kind 'activation' on the shared claim machinery,
 * one documented Connect POST + a confirming re-GET. The presenter seam is
 * structured here, so the code and the LIVE-BEHAVIOR warning are read off the
 * captured ApprovalRequestView.
 */

let tmp: string;
let db: ContrailDb;
let deps: EngineDeps;
let presenter: RecordingPresenter;

let botVersionRows: Array<{ Id: string; DeveloperName: string; Status: string }>;
let activationPosts: Array<{ id: string; body: Record<string, unknown> }>;
let postResult: { isActivated: boolean; messages: string[]; success: boolean };
let getResult: { isActivated: boolean; messages: string[]; success: boolean };

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
          instance_url: 'https://agent.stub.salesforce.com',
          id: 'https://login.salesforce.com/id/00D1/0051',
          token_type: 'Bearer',
        }),
      );
    }
    if (url.includes('/query?q=')) {
      const q = decodeURIComponent(url);
      if (q.includes('FROM BotVersion')) {
        return new Response(
          JSON.stringify({ totalSize: botVersionRows.length, done: true, records: botVersionRows }),
        );
      }
      return new Response(JSON.stringify({ totalSize: 0, done: true, records: [] }));
    }
    const activation = url.match(/\/connect\/bot-versions\/([^/]+)\/activation$/);
    if (activation) {
      if (method === 'POST') {
        activationPosts.push({
          id: activation[1]!,
          body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
        });
        return new Response(JSON.stringify(postResult));
      }
      return new Response(JSON.stringify(getResult));
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-activation-'));
  process.env.CONTRAIL_DATA_DIR = tmp;
  db = new ContrailDb(path.join(tmp, 'test.db'));
  presenter = new RecordingPresenter();
  botVersionRows = [
    { Id: '0X9000000000001AAA', DeveloperName: 'v1', Status: 'Inactive' },
    { Id: '0X9000000000002AAA', DeveloperName: 'v2', Status: 'Active' },
  ];
  activationPosts = [];
  postResult = { isActivated: false, messages: [], success: true };
  getResult = { isActivated: false, messages: [], success: true };

  const tokens = new MemoryTokenStore();
  const grants = emptyGrantSet();
  grants.metadata_read = true;
  grants.metadata_write = true;
  const conn = db.insertConnection({
    alias: 'agent-org',
    instanceUrl: 'https://agent.stub.salesforce.com',
    loginUrl: 'https://login.salesforce.com',
    orgId: '00D1',
    orgName: 'Agent Org',
    orgType: 'developer',
    isSandbox: false,
    username: 'dev@agent.example',
    userId: '005000000000001AAA',
    grants,
  });
  tokens.setRefreshToken(conn.id, 'RT');

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
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  db.close();
  delete process.env.CONTRAIL_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function propose(
  args: Partial<{ agent: string; version: string; status: string }> = {},
): Promise<ToolResult> {
  return invokeCapability(deps, 'agent_activation_propose', {
    connection: 'agent-org',
    agent: args.agent ?? 'Support_Agent',
    version: args.version ?? 'v2',
    status: args.status ?? 'Inactive',
  });
}

async function execute(confirmationCode: string): Promise<ToolResult> {
  return invokeCapability(deps, 'agent_activation_execute', {
    connection: 'agent-org',
    confirmation_code: confirmationCode,
  });
}

describe('agent activation ritual (desktop engine)', () => {
  it('propose → structured view with the LIVE-BEHAVIOR warning → execute POSTs and re-GETs', async () => {
    const proposed = await propose();
    expect(proposed.isError ?? false).toBe(false);
    const proposedText = textOf(proposed);
    expect(proposedText).toContain('nothing changed yet');
    // The code lives only on the presented view, never in the tool result.
    expect(proposedText).not.toMatch(/[A-Z2-9]{4}-[A-Z2-9]{4}/);
    expect(presenter.views).toHaveLength(1);
    const view = presenter.views[0]!;
    expect(view.kind).toBe('activation');
    expect(view.warnings.join(' ')).toContain('LIVE AGENT BEHAVIOR');
    expect(view.changes[0]!.label).toBe('DEACTIVATE Support_Agent v2 (currently Active)');

    getResult = { isActivated: false, messages: [], success: true };
    const executed = await execute(view.code);
    const parsed = JSON.parse(textOf(executed)) as Record<string, unknown>;
    expect(parsed.executed).toBe(true);
    expect(parsed.confirmed_status).toBe('Inactive');
    expect(activationPosts).toEqual([
      { id: '0X9000000000002AAA', body: { status: 'Inactive' } },
    ]);
  });

  it('already-in-state refuses without presenting; unconfirmed changes report execution_failed', async () => {
    const noop = await propose({ status: 'Active' });
    const parsed = JSON.parse(textOf(noop)) as Record<string, unknown>;
    expect(parsed.proposed).toBe(false);
    expect(presenter.views).toHaveLength(0);

    await propose();
    postResult = { isActivated: true, messages: ['Version cannot be deactivated.'], success: false };
    getResult = { isActivated: true, messages: [], success: true };
    const executed = await execute(presenter.views[0]!.code);
    const out = JSON.parse(textOf(executed)) as Record<string, unknown>;
    expect(out.executed).toBe(false);
    expect(out.confirmed_status).toBe('Active');
    expect(JSON.stringify(out.messages)).toContain('cannot be deactivated');
  });
});
