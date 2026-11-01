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
import { flowMetadataJsonToXml } from '../salesforce/flowversion.js';

/**
 * S40 (desktop mirror of the plugin's flowversion.test.ts): historical flow
 * versions — the Tooling-JSON → flow-XML converter and the retrieve_metadata
 * flow_version mode that rides it, at the capability surface.
 */

describe('flowMetadataJsonToXml', () => {
  it('round-trips names, nesting, repeats, and primitives; escapes XML', () => {
    const xml = flowMetadataJsonToXml({
      label: 'Fees & <Credits>',
      status: 'Obsolete',
      assignments: [
        {
          name: 'Set_A',
          assignmentItems: [{ assignToReference: 'x', operator: 'Assign' }],
        },
        { name: 'Set_B' },
      ],
      start: { locationX: 50, connector: { targetReference: 'Set_A' } },
      areMetricsLoggedToDataCloud: false,
    });
    expect(xml).toContain('<Flow xmlns="http://soap.sforce.com/2006/04/metadata">');
    expect(xml).toContain('<label>Fees &amp; &lt;Credits&gt;</label>');
    // Repeats become repeated elements, nesting recurses.
    expect(xml.match(/<assignments>/g)).toHaveLength(2);
    expect(xml).toContain('<assignToReference>x</assignToReference>');
    expect(xml).toContain('<targetReference>Set_A</targetReference>');
    // Primitives stringify the way flow XML carries them.
    expect(xml).toContain('<locationX>50</locationX>');
    expect(xml).toContain('<areMetricsLoggedToDataCloud>false</areMetricsLoggedToDataCloud>');
    // Nulls are skipped, not serialized as "null".
    expect(xml).not.toContain('null');
  });

  it('is deterministic: identical input objects yield identical XML', () => {
    const meta = { b: '2', a: '1', list: [{ z: 'x', y: 'w' }] };
    expect(flowMetadataJsonToXml(meta)).toBe(flowMetadataJsonToXml({ ...meta }));
  });
});

describe('retrieve_metadata flow_version', () => {
  let tmp: string;
  let db: ContrailDb;
  let deps: EngineDeps;
  /** VersionNumber the stub recognizes; others 404 into the versions list. */
  const KNOWN_VERSION = 12;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-dflowver-'));
    process.env.CONTRAIL_DATA_DIR = tmp;
    db = new ContrailDb(path.join(tmp, 'test.db'));
    const grants = emptyGrantSet();
    grants.metadata_read = true;
    const conn = db.insertConnection({
      alias: 'ver-org',
      instanceUrl: 'https://flowver.stub.salesforce.com',
      loginUrl: 'https://login.salesforce.com',
      orgId: '00DV',
      orgName: 'Versions',
      orgType: 'developer',
      isSandbox: false,
      username: null,
      userId: null,
      grants,
    });
    const tokens = new MemoryTokenStore();
    tokens.setRefreshToken(conn.id, 'RT');

    vi.stubGlobal('fetch', async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/services/oauth2/token')) {
        return new Response(
          JSON.stringify({
            access_token: 'AT',
            instance_url: 'https://flowver.stub.salesforce.com',
            id: 'https://login.salesforce.com/id/00DV/005V',
            token_type: 'Bearer',
          }),
        );
      }
      if (url.includes('/tooling/query?q=')) {
        const q = decodeURIComponent(url);
        if (q.includes(`VersionNumber = ${KNOWN_VERSION}`)) {
          return new Response(
            JSON.stringify({
              totalSize: 1,
              done: true,
              records: [{ Id: '301V00000000001AAA', Status: 'Obsolete' }],
            }),
          );
        }
        if (q.includes('ORDER BY VersionNumber')) {
          return new Response(
            JSON.stringify({
              totalSize: 2,
              done: true,
              records: [
                { VersionNumber: 12, Status: 'Obsolete' },
                { VersionNumber: 13, Status: 'Active' },
              ],
            }),
          );
        }
        return new Response(JSON.stringify({ totalSize: 0, done: true, records: [] }));
      }
      if (url.includes('/tooling/sobjects/Flow/301V00000000001AAA')) {
        return new Response(
          JSON.stringify({
            Status: 'Obsolete',
            Metadata: {
              label: 'Order Router v12',
              // Big enough that a 1,000-byte budget truncates the converted XML.
              description: 'd'.repeat(2500),
              assignments: [{ name: 'Set_Flag' }],
              start: { connector: { targetReference: 'Set_Flag' } },
            },
          }),
        );
      }
      return new Response('not found', { status: 404 });
    });

    deps = createEngineDeps({
      db,
      tokens,
      config: { ...DEFAULT_CONFIG },
      store: new SnapshotStore(path.join(tmp, 'snapshots')),
    });
  });

  afterEach(() => {
    db.close();
    vi.unstubAllGlobals();
    delete process.env.CONTRAIL_DATA_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function textOf(result: ToolResult): string {
    return result.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n');
  }

  it('fetches a historical version as converted XML with the honesty note', async () => {
    const result = await invokeCapability(deps, 'retrieve_metadata', {
      connection: 'ver-org',
      type: 'Flow',
      names: ['Order_Router'],
      flow_version: KNOWN_VERSION,
    });
    expect(result.isError).not.toBe(true);
    const text = textOf(result);
    expect(text).toContain('<label>Order Router v12</label>');
    expect(text).toContain('tooling (version 12, Obsolete)');
    expect(text).toContain('NOT guaranteed deploy-ready');
  });

  it('a truncated historical version NEVER points at the snapshot (it holds only the latest)', async () => {
    const result = await invokeCapability(deps, 'retrieve_metadata', {
      connection: 'ver-org',
      type: 'Flow',
      names: ['Order_Router'],
      flow_version: KNOWN_VERSION,
      max_bytes: 1000,
    });
    const parsed = JSON.parse(textOf(result)) as { artifacts: Array<Record<string, unknown>> };
    const a = parsed.artifacts[0]!;
    expect(a.truncated).toBe(true);
    // Following a snapshot_path here would splice v12's head onto the LATEST
    // version's file — the honest answer is "no file holds this version".
    expect(a.snapshot_path).toBeUndefined();
    expect(String(a.truncated_note)).toContain('historical version');
  });

  it('an unknown version lists what exists; the mode is Flow-only, one name only', async () => {
    const missing = await invokeCapability(deps, 'retrieve_metadata', {
      connection: 'ver-org',
      type: 'Flow',
      names: ['Order_Router'],
      flow_version: 7,
    });
    const text = textOf(missing);
    expect(text).toContain('no version 7');
    expect(text).toContain('12 (Obsolete)');
    expect(text).toContain('13 (Active)');

    const wrongType = await invokeCapability(deps, 'retrieve_metadata', {
      connection: 'ver-org',
      type: 'ApexClass',
      names: ['Foo'],
      flow_version: 2,
    });
    expect(wrongType.isError).toBe(true);
    expect(textOf(wrongType)).toContain('only to type Flow');

    const twoNames = await invokeCapability(deps, 'retrieve_metadata', {
      connection: 'ver-org',
      type: 'Flow',
      names: ['A', 'B'],
      flow_version: 2,
    });
    expect(twoNames.isError).toBe(true);
    expect(textOf(twoNames)).toContain('exactly one name');
  });
});
