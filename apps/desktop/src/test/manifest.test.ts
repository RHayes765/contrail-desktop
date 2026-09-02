import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import {
  ContrailDb,
  SnapshotStore,
  type DeployRequestRecord,
  type EngineDeps,
} from '@contrail/engine';
import { ManifestService } from '../main/services/manifest.js';

/**
 * S28 manifest capture + backfill. Capture is tested DIRECTLY against real
 * db/store state and a real frozen zip — the observer plumbing that invokes
 * it is pinned by the engine's deploy-observer suite; what this file pins is
 * the content extraction (zip entry naming incl. percent-encoding, child
 * blocks on both sides), attribution rules, degradation (never a throw), and
 * backfill idempotency.
 */

let tmp: string;
let db: ContrailDb;
let store: SnapshotStore;
let service: ManifestService;
let pushes: Array<{ channel: string; payload: unknown }>;
let audits: string[];
let projectId: string;
let sessionId: string;
let connId: string;

const OLD_CLASS = 'public class InvoiceService { /* old */ }';
const NEW_CLASS = 'public class InvoiceService { /* new */ }';
const OLD_OBJECT =
  '<?xml version="1.0"?>\n<CustomObject>\n    <fields>\n        <fullName>Existing__c</fullName>\n' +
  '        <type>Text</type>\n    </fields>\n</CustomObject>';
const NEW_OBJECT =
  '<?xml version="1.0"?>\n<CustomObject>\n    <fields>\n        <fullName>Existing__c</fullName>\n' +
  '        <type>Text</type>\n    </fields>\n    <fields>\n        <fullName>Fresh__c</fullName>\n' +
  '        <type>Number</type>\n    </fields>\n</CustomObject>';
const OLD_FLOW = '<?xml version="1.0"?>\n<Flow><label>Doomed</label></Flow>';
const LAYOUT_XML = '<?xml version="1.0"?>\n<Layout><layoutSections/></Layout>';

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-manifest-'));
  db = new ContrailDb(path.join(tmp, 'test.db'));
  store = new SnapshotStore(path.join(tmp, 'snapshots'));
  pushes = [];
  audits = [];

  connId = db.insertConnection({
    alias: 'mani-org',
    instanceUrl: 'https://mani.stub.salesforce.com',
    loginUrl: 'https://login.salesforce.com',
    orgId: '00DM',
    orgName: 'Manifest Org',
    orgType: 'developer',
    isSandbox: false,
    username: null,
    userId: null,
    grants: {
      metadata_read: true,
      metadata_write: true,
      diagnostics_read: false,
      data_read: true,
      data_write: true,
    },
  }).id;
  projectId = db.createProject({ name: 'Manifest Project' }).id;
  sessionId = db.createAgentSession({ projectId, title: null, model: 'claude-haiku-4-5' });

  // Pre-deploy snapshot state (the BEFORE side) + its index rows.
  store.writeCurrent(
    connId,
    new Map([
      ['classes/InvoiceService.cls', strToU8(OLD_CLASS)],
      ['objects/Account.object', strToU8(OLD_OBJECT)],
      ['flows/Doomed_Flow.flow', strToU8(OLD_FLOW)],
    ]),
  );
  db.replaceArtifactsForTypes(connId, ['ApexClass', 'CustomObject', 'CustomField', 'Flow'], [
    row('ApexClass', 'InvoiceService', 'classes/InvoiceService.cls'),
    row('CustomObject', 'Account', 'objects/Account.object'),
    row('CustomField', 'Account.Fresh__c', 'objects/Account.object'),
    row('Flow', 'Doomed_Flow', 'flows/Doomed_Flow.flow'),
  ]);

  const deps = {
    db,
    store,
    audit: {
      record: (eventType: string) => {
        audits.push(eventType);
      },
    },
  } as unknown as EngineDeps;
  // metadata service only used for the current-snapshot fallback — a minimal fake.
  const metadata = {
    artifact: (cid: string, type: string, apiName: string) => {
      const rec = db.getArtifact(cid, type, apiName);
      if (!rec?.filePath) throw new Error('not in snapshot');
      return {
        type,
        apiName,
        content: store.readCurrentFile(cid, rec.filePath),
        lastModifiedDate: null,
        lastModifiedBy: null,
        uses: [],
        usedBy: [],
        usesTruncated: false,
        usedByTruncated: false,
        permissionSet: null,
        flowGraph: null,
        savedSummary: null,
      };
    },
  };
  service = new ManifestService(
    deps,
    (channel, payload) => pushes.push({ channel, payload }),
    metadata as never,
  );
});

afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function row(type: string, apiName: string, filePath: string) {
  return {
    connectionId: connId,
    type,
    apiName,
    filePath,
    contentHash: 'h',
    lastModifiedDate: null,
    lastModifiedBy: null,
    retrievedAt: '2026-09-01T00:00:00.000Z',
    content: '',
  };
}

function makeRequest(over: {
  kind: 'deploy' | 'dml' | 'apex' | 'bulk';
  summaryJson: string;
  payloadJson?: string;
  withSession?: boolean;
  executed?: boolean;
}): DeployRequestRecord {
  const rec = db.insertDeployRequest({
    connectionId: connId,
    kind: over.kind,
    confirmationCode: `${Math.random().toString(36).slice(2, 6).toUpperCase()}-TEST`,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    summaryJson: over.summaryJson,
    ...(over.payloadJson ? { payloadJson: over.payloadJson } : {}),
  });
  if (over.withSession !== false) {
    db.setDeployRequestDesktopFields(rec.id, { sessionId });
  }
  if (over.executed) {
    db.claimRequestForExecution(rec.id);
    db.finishDeployRequest(rec.id, 'executed', '{}');
  }
  return db.getDeployRequest(rec.id)!;
}

const DEPLOY_SUMMARY = JSON.stringify({
  changes: [
    { type: 'ApexClass', api_name: 'InvoiceService', change: 'modify', warnings: [] },
    { type: 'CustomField', api_name: 'Account.Fresh__c', change: 'add', warnings: ['new field'] },
    {
      type: 'Layout',
      api_name: 'Account-Account (Marketing) Layout',
      change: 'modify',
      warnings: [],
    },
    { type: 'ApexClass', api_name: 'Untouched', change: 'unchanged_content', warnings: [] },
  ],
  destructive: [{ type: 'Flow', api_name: 'Doomed_Flow', change: 'delete', warnings: ['bye'] }],
  blast: [],
});

function makeDeployZip(): string {
  const zipPath = path.join(tmp, 'frozen.zip');
  fs.writeFileSync(
    zipPath,
    zipSync({
      'classes/InvoiceService.cls': strToU8(NEW_CLASS),
      'objects/Account.object': strToU8(NEW_OBJECT),
      // The percent-encoding contract: parens are encoded, spaces are not.
      'layouts/Account-Account %28Marketing%29 Layout.layout': strToU8(LAYOUT_XML),
      'package.xml': strToU8('<Package/>'),
    }),
  );
  return zipPath;
}

describe('capture (the execution observer body)', () => {
  it('captures per-component before/after from the snapshot and the frozen zip', () => {
    const request = makeRequest({ kind: 'deploy', summaryJson: DEPLOY_SUMMARY });
    service.capture({ request, payload: { deployed: true }, payloadPath: makeDeployZip() });

    const entries = db.listManifestEntries(projectId);
    // unchanged_content is not a change — 4 rows, not 5.
    expect(entries).toHaveLength(4);
    const byName = new Map(entries.map((e) => [`${e.type}:${e.apiName}`, e]));

    const cls = byName.get('ApexClass:InvoiceService')!;
    expect(cls.change).toBe('modify');
    expect(cls.beforeContent).toBe(OLD_CLASS);
    expect(cls.afterContent).toBe(NEW_CLASS);

    // Child component: the child's OWN block extracted on BOTH sides.
    const field = byName.get('CustomField:Account.Fresh__c')!;
    expect(field.change).toBe('add');
    expect(field.beforeContent).toBeNull(); // an add has no before
    expect(field.afterContent).toContain('<fullName>Fresh__c</fullName>');
    expect(field.afterContent).not.toContain('Existing__c');

    // Percent-encoded zip entry resolved through the builder's own naming.
    const layout = byName.get('Layout:Account-Account (Marketing) Layout')!;
    expect(layout.afterContent).toBe(LAYOUT_XML);

    // A delete keeps the before (what was destroyed), no after.
    const flow = byName.get('Flow:Doomed_Flow')!;
    expect(flow.change).toBe('delete');
    expect(flow.beforeContent).toBe(OLD_FLOW);
    expect(flow.afterContent).toBeNull();

    expect(pushes).toEqual([{ channel: 'manifest:changed', payload: { projectId } }]);
  });

  it('captures anonymous Apex as a data row carrying the script', () => {
    const request = makeRequest({
      kind: 'apex',
      summaryJson: JSON.stringify({ lines: 2, chars: 30 }),
      payloadJson: JSON.stringify({ apex: true, code: 'System.debug(1);\ndelete a;' }),
    });
    service.capture({ request, payload: { executed: true }, payloadPath: null });
    const [entry] = db.listManifestEntries(projectId);
    expect(entry!.entryKind).toBe('data');
    expect(entry!.label).toBe('Anonymous Apex (2 lines)');
    expect(entry!.afterContent).toContain('System.debug(1);');
  });

  it('skips rows with no session attribution (plugin-proposed), silently', () => {
    const request = makeRequest({
      kind: 'deploy',
      summaryJson: DEPLOY_SUMMARY,
      withSession: false,
    });
    service.capture({ request, payload: { deployed: true }, payloadPath: makeDeployZip() });
    expect(db.listManifestEntries(projectId)).toHaveLength(0);
    expect(pushes).toHaveLength(0);
    expect(audits).toHaveLength(0); // a skip is not a failure
  });

  it('degrades on a corrupt zip — rows land without after-content, nothing throws', () => {
    const badZip = path.join(tmp, 'corrupt.zip');
    fs.writeFileSync(badZip, 'this is not a zip');
    const request = makeRequest({ kind: 'deploy', summaryJson: DEPLOY_SUMMARY });
    expect(() =>
      service.capture({ request, payload: { deployed: true }, payloadPath: badZip }),
    ).not.toThrow();
    const entries = db.listManifestEntries(projectId);
    expect(entries).toHaveLength(4);
    expect(entries.every((e) => e.afterContent === null)).toBe(true);
    // BEFORE still captured from the intact snapshot.
    expect(entries.find((e) => e.apiName === 'InvoiceService')?.beforeContent).toBe(OLD_CLASS);
  });

  it('an unparseable summary yields zero rows and never a throw', () => {
    const request = makeRequest({ kind: 'deploy', summaryJson: '{not json' });
    expect(() =>
      service.capture({ request, payload: { deployed: true }, payloadPath: null }),
    ).not.toThrow();
    expect(db.listManifestEntries(projectId)).toHaveLength(0);
  });
});

describe('entry detail + views', () => {
  it('serves the captured content with a what-changed diff, and the data section separately', () => {
    service.capture({
      request: makeRequest({ kind: 'deploy', summaryJson: DEPLOY_SUMMARY }),
      payload: { deployed: true },
      payloadPath: makeDeployZip(),
    });
    service.capture({
      request: makeRequest({
        kind: 'dml',
        summaryJson: JSON.stringify({ operation: 'update', object: 'Account', row_count: 3 }),
        payloadJson: '{}',
      }),
      payload: { executed: true },
      payloadPath: null,
    });

    const view = service.list(projectId);
    expect(view.metadata).toHaveLength(4);
    expect(view.data).toHaveLength(1);
    expect(view.data[0]!.label).toBe('UPDATE 3 row(s) on Account');
    expect(view.metadata.every((e) => e.alias === 'mani-org')).toBe(true);

    const cls = view.metadata.find((e) => e.apiName === 'InvoiceService')!;
    const detail = service.entryDetail(cls.id);
    expect(detail.contentSource).toBe('captured');
    expect(detail.artifact?.content).toBe(NEW_CLASS);
    expect(detail.beforeContent).toBe(OLD_CLASS);
    expect(detail.identical).toBe(false);
    expect(detail.format).toBe('text');
    expect(detail.hunks?.length).toBeGreaterThan(0);
  });

  it('backfilled rows fall back to the current snapshot, labeled as such', () => {
    // A historic executed request — backfill synthesizes rows with no content.
    makeRequest({ kind: 'deploy', summaryJson: DEPLOY_SUMMARY, executed: true });
    service.ensureBackfill();
    const view = service.list(projectId);
    const cls = view.metadata.find((e) => e.apiName === 'InvoiceService')!;
    expect(cls.hasCapturedContent).toBe(false);
    const detail = service.entryDetail(cls.id);
    expect(detail.contentSource).toBe('current_snapshot');
    expect(detail.artifact?.content).toBe(OLD_CLASS); // the org's current version
    expect(detail.changes).toBeNull();
  });
});

describe('backfill idempotency and attribution', () => {
  it('backfills executed session-attributed requests exactly once; unattributed are excluded', () => {
    makeRequest({ kind: 'deploy', summaryJson: DEPLOY_SUMMARY, executed: true });
    makeRequest({
      kind: 'apex',
      summaryJson: JSON.stringify({ lines: 1, chars: 10 }),
      payloadJson: JSON.stringify({ apex: true, code: 'x();' }),
      executed: true,
    });
    makeRequest({
      kind: 'deploy',
      summaryJson: DEPLOY_SUMMARY,
      withSession: false,
      executed: true,
    }); // plugin-style row — excluded
    makeRequest({ kind: 'deploy', summaryJson: DEPLOY_SUMMARY }); // not executed — excluded

    service.ensureBackfill();
    const first = db.listManifestEntries(projectId);
    expect(first).toHaveLength(5); // 4 deploy components + 1 apex

    service.ensureBackfill();
    expect(db.listManifestEntries(projectId)).toHaveLength(5); // no duplicates

    // The apex script survives backfill (payload_json outlives execution).
    expect(first.find((e) => e.kind === 'apex')?.afterContent).toBe('x();');
  });

  it('deleting the project removes its manifest rows', () => {
    makeRequest({ kind: 'deploy', summaryJson: DEPLOY_SUMMARY, executed: true });
    service.ensureBackfill();
    expect(db.listManifestEntries(projectId).length).toBeGreaterThan(0);
    db.deleteProject(projectId);
    expect(db.listManifestEntries(projectId)).toEqual([]);
  });
});
