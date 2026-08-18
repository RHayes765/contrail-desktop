import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strToU8 } from 'fflate';
import { ContrailDb } from '../core/db.js';
import { MemoryTokenStore } from '../core/keychain.js';
import { DEFAULT_CONFIG } from '../core/config.js';
import { createEngineDeps, type EngineDeps } from '../core/deps.js';
import { invokeCapability, type ToolResult } from '../capabilities/index.js';
import { emptyGrantSet } from '../core/grants.js';
import { SnapshotStore } from '../snapshot/store.js';

/**
 * retrieve_metadata's read budget (ported from the plugin).
 *
 * The old behaviour cut every artifact at 60 KB with only a note in the text.
 * A real flow is bigger than that, so the capability handed back a fragment of
 * XML and the caller analysed it as if it were whole — which produces
 * confident wrong answers about branches that were never in the window.
 */

const BIG_FLOW = `<?xml version="1.0" encoding="UTF-8"?>\n<Flow>${'<decisions><name>D</name></decisions>'.repeat(
  4000,
)}</Flow>`; // ~148 KB — past the old 60 KB cap, inside the new default

let tmp: string;
let db: ContrailDb;
let store: SnapshotStore;
let deps: EngineDeps;
let connId: string;

function textOf(result: ToolResult): string {
  return (result.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
}

function flowRow(name: string, i = 0) {
  return {
    type: 'Flow',
    apiName: name,
    filePath: `flows/${name}.flow`,
    contentHash: `h${i}`,
    lastModifiedDate: null,
    lastModifiedBy: null,
    retrievedAt: new Date().toISOString(),
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-reads-'));
  process.env.CONTRAIL_DATA_DIR = tmp;
  db = new ContrailDb(path.join(tmp, 'test.db'));
  store = new SnapshotStore(path.join(tmp, 'snapshots'));

  const grants = emptyGrantSet();
  grants.metadata_read = true;
  const conn = db.insertConnection({
    alias: 'read-org',
    instanceUrl: 'https://reads.stub.salesforce.com',
    loginUrl: 'https://login.salesforce.com',
    orgId: '00D9',
    orgName: 'Reads',
    orgType: 'developer',
    isSandbox: false,
    username: null,
    userId: null,
    grants,
  });
  connId = conn.id;

  store.writeCurrent(connId, new Map([['flows/Big_Flow.flow', strToU8(BIG_FLOW)]]));
  db.replaceArtifactsForTypes(connId, ['Flow'], [flowRow('Big_Flow')]);

  deps = createEngineDeps({
    db,
    tokens: new MemoryTokenStore(),
    config: { ...DEFAULT_CONFIG },
    store,
    flowOps: {
      exchangeCode: async () => {
        throw new Error('not exercised');
      },
      fetchOrgInfo: async () => {
        throw new Error('not exercised');
      },
      fetchIdentity: async () => ({ username: null, userId: null, displayName: null }),
      revokeToken: async () => ({ ok: true }),
      openBrowser: async () => undefined,
    },
  });
});

afterEach(() => {
  db.close();
  delete process.env.CONTRAIL_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function retrieve(extra: Record<string, unknown> = {}) {
  const result = await invokeCapability(deps, 'retrieve_metadata', {
    connection: 'read-org',
    type: 'Flow',
    names: ['Big_Flow'],
    include_dependencies: false,
    ...extra,
  });
  return {
    result,
    json: JSON.parse(textOf(result)) as { artifacts: Array<Record<string, unknown>> },
  };
}

describe('a big flow comes back whole', () => {
  it('returns all ~148 KB by default — past the old 60 KB wall', async () => {
    const { json } = await retrieve();
    const a = json.artifacts[0]!;
    expect(a.truncated).toBe(false);
    expect(a.bytes_total).toBe(BIG_FLOW.length);
    expect(a.bytes_returned).toBe(BIG_FLOW.length);
    expect(String(a.content).endsWith('</Flow>')).toBe(true);
  });
});

describe('when content IS cut, it says so usefully', () => {
  it('reports the real size, flags the cut, and hands back the file path', async () => {
    const { json } = await retrieve({ max_bytes: 1_000 });
    const a = json.artifacts[0]!;
    expect(a.truncated).toBe(true);
    expect(a.truncated_reason).toBe('max_bytes');
    expect(a.bytes_total).toBe(BIG_FLOW.length);
    expect(Number(a.bytes_returned)).toBeLessThan(BIG_FLOW.length);
    // The escape hatch: read the file directly instead of paging blindly.
    expect(String(a.snapshot_path)).toContain('Big_Flow.flow');
    expect(fs.readFileSync(String(a.snapshot_path), 'utf8')).toBe(BIG_FLOW);
    expect(String(a.content)).toContain('[truncated');
  });

  it('refuses a max_bytes past the hard ceiling instead of honouring it', async () => {
    const result = await invokeCapability(deps, 'retrieve_metadata', {
      connection: 'read-org',
      type: 'Flow',
      names: ['Big_Flow'],
      max_bytes: 50_000_000,
    });
    expect(result.isError).toBe(true);
  });
});

describe('one call cannot drain a context window', () => {
  it('stops at the per-call budget across many names and labels why', async () => {
    const names: string[] = [];
    const files = new Map<string, Uint8Array>();
    const rows = [];
    for (let i = 0; i < 10; i++) {
      const name = `Flow_${i}`;
      names.push(name);
      files.set(`flows/${name}.flow`, strToU8(BIG_FLOW));
      rows.push(flowRow(name, i));
    }
    store.writeCurrent(connId, files);
    db.replaceArtifactsForTypes(connId, ['Flow'], rows);

    const result = await invokeCapability(deps, 'retrieve_metadata', {
      connection: 'read-org',
      type: 'Flow',
      names,
      max_bytes: 2_000_000,
      include_dependencies: false,
    });
    const json = JSON.parse(textOf(result)) as { artifacts: Array<Record<string, unknown>> };
    const returned = json.artifacts.reduce((n, a) => n + Number(a.bytes_returned ?? 0), 0);
    expect(returned).toBeLessThanOrEqual(2_000_000);
    expect(json.artifacts[0]!.truncated).toBe(false);
    const cut = json.artifacts.filter((a) => a.truncated);
    if (cut.length) expect(cut[0]!.truncated_reason).toBe('call_budget');
  });
});
