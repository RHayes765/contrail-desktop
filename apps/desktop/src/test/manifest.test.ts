import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import {
  AccessTokenManager,
  AuditLog,
  ContrailDb,
  DEFAULT_CONFIG,
  DeployEngine,
  MemoryTokenStore,
  SnapshotStore,
  type ApprovalPresenter,
  type ContrailConfig,
  type DeployRequestRecord,
  type EngineDeps,
} from '@contrail/engine';
import { ManifestService } from '../main/services/manifest.js';
import {
  identicalLine,
  manifestBaseline,
  noDiffLine,
  whatChangedHeading,
} from '../renderer/src/lib/manifestBaseline.js';

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
  vi.unstubAllGlobals();
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
  kind: 'deploy' | 'dml' | 'apex' | 'bulk' | 'activation';
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

  it('S29: captures folder-qualified reports and folder components from the frozen zip', () => {
    // Seed the pre-deploy snapshot with the nested report (the BEFORE side).
    store.writeCurrent(
      connId,
      new Map([['reports/Ops/Weekly.report', strToU8('<Report>old</Report>')]]),
    );
    db.replaceArtifactsForTypes(connId, ['Report'], [
      row('Report', 'Ops/Weekly', 'reports/Ops/Weekly.report'),
    ]);
    const summary = JSON.stringify({
      changes: [
        { type: 'Report', api_name: 'Ops/Weekly', change: 'modify', warnings: [] },
        { type: 'ReportFolder', api_name: 'Ops', change: 'add', warnings: [] },
      ],
      destructive: [],
      blast: [],
    });
    const zipPath = path.join(tmp, 'frozen-report.zip');
    fs.writeFileSync(
      zipPath,
      zipSync({
        'reports/Ops/Weekly.report': strToU8('<Report>new</Report>'),
        'reports/Ops-meta.xml': strToU8('<ReportFolder><name>Ops</name></ReportFolder>'),
        'package.xml': strToU8('<Package/>'),
      }),
    );
    const request = makeRequest({ kind: 'deploy', summaryJson: summary });
    service.capture({ request, payload: { deployed: true }, payloadPath: zipPath });

    const entries = db.listManifestEntries(projectId);
    const byName = new Map(entries.map((e) => [`${e.type}:${e.apiName}`, e]));
    const report = byName.get('Report:Ops/Weekly')!;
    // Before from the nested snapshot path, after from the '/'-preserving zip
    // entry — the pre-S29 failure mode was BOTH sides silently null.
    expect(report.beforeContent).toBe('<Report>old</Report>');
    expect(report.afterContent).toBe('<Report>new</Report>');
    const folder = byName.get('ReportFolder:Ops')!;
    expect(folder.afterContent).toContain('<name>Ops</name>');
  });

  it('S30: captures bundle components as framed multi-file text, both sides', () => {
    // Pre-deploy snapshot: the bundle with an OLD output schema.
    store.writeCurrent(
      connId,
      new Map([
        [
          'genAiFunctions/Dog_Facts/Dog_Facts.genAiFunction-meta.xml',
          strToU8('<GenAiFunction>old</GenAiFunction>'),
        ],
        ['genAiFunctions/Dog_Facts/output/schema.json', strToU8('{"old":true}')],
      ]),
    );
    db.replaceArtifactsForTypes(connId, ['GenAiFunction'], [
      row('GenAiFunction', 'Dog_Facts', 'genAiFunctions/Dog_Facts/Dog_Facts.genAiFunction-meta.xml'),
    ]);
    const summary = JSON.stringify({
      changes: [{ type: 'GenAiFunction', api_name: 'Dog_Facts', change: 'modify', warnings: [] }],
      destructive: [],
      blast: [],
    });
    const zipPath = path.join(tmp, 'frozen-bundle.zip');
    fs.writeFileSync(
      zipPath,
      zipSync({
        'genAiFunctions/Dog_Facts/Dog_Facts.genAiFunction-meta.xml': strToU8(
          '<GenAiFunction>new</GenAiFunction>',
        ),
        'genAiFunctions/Dog_Facts/output/schema.json': strToU8('{"new":true}'),
        'package.xml': strToU8('<Package/>'),
      }),
    );
    const request = makeRequest({ kind: 'deploy', summaryJson: summary });
    service.capture({ request, payload: { deployed: true }, payloadPath: zipPath });

    const entries = db.listManifestEntries(projectId);
    const fn = entries.find((e) => e.apiName === 'Dog_Facts')!;
    // Both sides carry EVERY bundle file under contrail:file framing — a
    // sibling-only schema change is visible, never silently dropped.
    expect(fn.beforeContent).toContain('<GenAiFunction>old</GenAiFunction>');
    expect(fn.beforeContent).toContain('{"old":true}');
    expect(fn.afterContent).toContain('<GenAiFunction>new</GenAiFunction>');
    expect(fn.afterContent).toContain('{"new":true}');
    expect(fn.afterContent).toContain(
      'contrail:file genAiFunctions/Dog_Facts/output/schema.json',
    );
  });

  it('captures an agent activation flip as a labeled data row with the from→to detail', () => {
    const request = makeRequest({
      kind: 'activation',
      summaryJson: JSON.stringify({ rows: [{ label: 'DEACTIVATE Support_Agent v2', warnings: [] }] }),
      payloadJson: JSON.stringify({
        activation: true,
        bot_developer_name: 'Support_Agent',
        bot_version_developer_name: 'v2',
        bot_version_id: '0X9000000000002AAA',
        from_status: 'Active',
        to_status: 'Inactive',
      }),
    });
    service.capture({ request, payload: { executed: true }, payloadPath: null });
    const [entry] = db.listManifestEntries(projectId);
    // A data-kind entry, so the Manifest tab renders label + detail — a
    // 'metadata' entry with null content would show as bogus "no capture".
    expect(entry!.entryKind).toBe('data');
    expect(entry!.label).toBe('Deactivated agent Support_Agent v2');
    expect(JSON.parse(entry!.detailJson ?? '{}')).toMatchObject({ from: 'Active', to: 'Inactive' });
    expect(entry!.afterContent).toBeNull();
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

describe('S46 C: the re-baseline after execute leaves the captured before-side alone', () => {
  const MD = 'xmlns="http://soap.sforce.com/2006/04/metadata"';

  function soapEnvelope(inner: string): string {
    return (
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">' +
      `<soapenv:Body>${inner}</soapenv:Body></soapenv:Envelope>`
    );
  }

  /**
   * The org a real execute_deploy talks to: a token, the real deploy and its
   * status. Every other read (the execute-time target check's) answers 404,
   * so that guard fails open with disclosure and the deploy proceeds.
   */
  function stubOrg(): void {
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/services/oauth2/token')) {
        return new Response(
          JSON.stringify({
            access_token: 'AT-stub',
            instance_url: 'https://mani.stub.salesforce.com',
            id: 'https://login.example.invalid/id/00DM/005M',
            token_type: 'Bearer',
          }),
        );
      }
      const body = String(init?.body ?? '');
      if (url.includes('/services/Soap/m/') && body.includes('<met:deploy>')) {
        return new Response(
          soapEnvelope(`<deployResponse ${MD}><result><id>0Af-real-1</id></result></deployResponse>`),
        );
      }
      if (url.includes('/services/Soap/m/') && body.includes('<met:checkDeployStatus>')) {
        return new Response(
          soapEnvelope(
            `<checkDeployStatusResponse ${MD}><result>` +
              '<done>true</done><status>Succeeded</status><success>true</success>' +
              '<checkOnly>false</checkOnly><createdDate>2026-11-18T09:00:01.000Z</createdDate>' +
              '<completedDate>2026-11-18T09:00:09.000Z</completedDate>' +
              '<numberComponentsTotal>1</numberComponentsTotal>' +
              '<numberComponentsDeployed>1</numberComponentsDeployed>' +
              '<numberComponentErrors>0</numberComponentErrors><numberTestsTotal>0</numberTestsTotal>' +
              '<numberTestsCompleted>0</numberTestsCompleted><numberTestErrors>0</numberTestErrors>' +
              '<details><runTestResult><numTestsRun>0</numTestsRun><numFailures>0</numFailures>' +
              '</runTestResult></details></result></checkDeployStatusResponse>',
          ),
        );
      }
      return new Response('not found', { status: 404 });
    });
  }

  /** A presenter that never presents — this case executes a seeded request. */
  const noPresenter: ApprovalPresenter = {
    mode: 'native',
    present: () => Promise.resolve({ url: null, opened: false, mode: 'native' }),
    close: () => {},
  };

  it("capture's before-side is the pre-deploy snapshot: the observer runs before the re-baseline rewrites it, and the snapshot holds the new bytes once execute resolves", async () => {
    const tokens = new MemoryTokenStore();
    tokens.setRefreshToken(connId, 'RT-stub');
    const config: ContrailConfig = {
      ...DEFAULT_CONFIG,
      salesforce: { ...DEFAULT_CONFIG.salesforce },
      oauth: { ...DEFAULT_CONFIG.oauth },
      deploy: { ...DEFAULT_CONFIG.deploy, pollIntervalMs: 5, toolWaitMs: 10_000 },
    };
    // The re-baseline is on by default — the hook this case orders capture against.
    expect(config.snapshot.rebaselineAfterDeploy).toBe(true);
    const engine = new DeployEngine(
      db,
      store,
      new AccessTokenManager(db, tokens, config),
      config,
      new AuditLog(db),
      noPresenter,
      { deploysDir: path.join(tmp, 'deploys') },
    );
    const order: string[] = [];
    // Wired exactly as main/index.ts wires it.
    engine.setExecutionObserver((info) => {
      order.push('capture');
      service.capture(info);
    });
    // Stands in for the snapshot engine's member re-read (the engine twin
    // rebaseline.test.ts pins that one): it rewrites the deployed class in
    // the snapshot through the same store call, the moment it is called — so
    // a capture that read the snapshot any later would read the new bytes.
    engine.setSnapshotRebaseliner(async ({ members }) => {
      order.push('rebaseline');
      store.replaceCurrentUnits(connId, {
        removeFiles: [],
        removeDirs: [],
        bundleTypeDirs: [],
        files: new Map([['classes/InvoiceService.cls', strToU8(NEW_CLASS)]]),
      });
      return {
        status: 'ran',
        summary: {
          connection: 'mani-org',
          members: members.map((m) => ({
            type: m.type,
            api_name: m.api_name,
            outcome: 'refreshed' as const,
            unit: `${m.type}:${m.api_name}`,
          })),
          counts: { refreshed: members.length, removed: 0, skipped: 0 },
          units: members.map((m) => `${m.type}:${m.api_name}`),
          artifact_counts: { ApexClass: 1 },
          edge_counts: { extractor: 0 },
          retrieved_at: new Date().toISOString(),
          notes: [],
          duration_ms: 1,
        },
      };
    });
    stubOrg();

    const payloadPath = path.join(tmp, 'deploys', 'frozen-execute.zip');
    fs.mkdirSync(path.dirname(payloadPath), { recursive: true });
    fs.writeFileSync(
      payloadPath,
      zipSync({
        'classes/InvoiceService.cls': strToU8(NEW_CLASS),
        'package.xml': strToU8('<Package/>'),
      }),
    );
    const rec = db.insertDeployRequest({
      connectionId: connId,
      kind: 'deploy',
      confirmationCode: 'MANI-FEST',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      payloadPath,
      payloadJson: JSON.stringify({ testLevel: 'NoTestRun' }),
      summaryJson: JSON.stringify({
        changes: [{ type: 'ApexClass', api_name: 'InvoiceService', change: 'modify', warnings: [] }],
        destructive: [],
        blast: [],
      }),
    });
    db.setDeployRequestDesktopFields(rec.id, { sessionId });

    const outcome = await engine.executeDeploy(db.getConnection(connId)!, 'MANI-FEST');
    expect(outcome.status).toBe('complete');
    const result = (outcome as { result: Record<string, unknown> }).result;
    expect(result.deployed).toBe(true);
    expect((result.snapshot as { status: string }).status).toBe('complete');
    expect(order).toEqual(['capture', 'rebaseline']);

    // The manifest's before is what the snapshot held before the deploy.
    const [entry] = db.listManifestEntries(projectId);
    expect(entry!.apiName).toBe('InvoiceService');
    expect(entry!.beforeContent).toBe(OLD_CLASS);
    expect(entry!.afterContent).toBe(NEW_CLASS);
    expect(JSON.parse(entry!.detailJson!).baseline).toBe('snapshot');
    // …and the snapshot itself holds the deployed bytes once the call resolves.
    expect(store.readCurrentFile(connId, 'classes/InvoiceService.cls')).toBe(NEW_CLASS);
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

describe('S45: the Manifest names the "before" of its diff', () => {
  const CHANGED =
    'CHANGED IN TARGET SINCE YOUR SNAPSHOT — the diff below is against the LIVE version ' +
    '(retrieved 10:02); your snapshot is from 2026-09-01 00:00.';
  const LIVE_CLASS = 'public class InvoiceService { /* a colleague edit */ }';

  function summaryFor(type: string, apiName: string, warnings: string[]): string {
    return JSON.stringify({
      changes: [{ type, api_name: apiName, change: 'modify', warnings }],
      destructive: [],
      blast: [],
    });
  }

  function zipOf(files: Record<string, string>): string {
    const zipPath = path.join(tmp, `frozen-${Object.keys(files).length}-${Math.random()}.zip`);
    const entries: Record<string, Uint8Array> = { 'package.xml': strToU8('<Package/>') };
    for (const [rel, text] of Object.entries(files)) entries[rel] = strToU8(text);
    fs.writeFileSync(zipPath, zipSync(entries));
    return zipPath;
  }

  /** A revert package as finalizeRevert puts it on the payload, files on disk. */
  function revertPackage(files: Array<{ type: string; apiName: string; rel: string; text: string }>) {
    const dir = path.join(tmp, 'staging', '_reverts', 'req-1');
    const restores = files.map((f) => {
      const file = path.join(dir, f.rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, f.text);
      return { type: f.type, api_name: f.apiName, content_file: file };
    });
    return { dir, restores, deletes: [], not_restorable: [] };
  }

  it("the live pre-image is the before when one was frozen: a snapshot-identical deploy still diffs against the colleague's edit", () => {
    // The plan's livediff case: the snapshot equals the deployed bytes, the org did not.
    const request = makeRequest({
      kind: 'deploy',
      summaryJson: summaryFor('ApexClass', 'InvoiceService', [CHANGED]),
    });
    service.capture({
      request,
      payload: {
        deployed: true,
        revert_package: revertPackage([
          { type: 'ApexClass', apiName: 'InvoiceService', rel: 'classes/InvoiceService.cls', text: LIVE_CLASS },
        ]),
      },
      payloadPath: zipOf({ 'classes/InvoiceService.cls': OLD_CLASS }),
    });
    const [entry] = db.listManifestEntries(projectId);
    expect(entry!.beforeContent).toBe(LIVE_CLASS);
    expect(entry!.afterContent).toBe(OLD_CLASS);
    expect(JSON.parse(entry!.detailJson!)).toMatchObject({ warnings: [CHANGED], baseline: 'live_preimage' });
    const detail = service.entryDetail(entry!.id);
    expect(detail.identical).toBe(false);
    expect(detail.hunks?.length).toBeGreaterThan(0);
    expect(manifestBaseline(detail)).toBe('live_preimage');
    expect(whatChangedHeading(manifestBaseline(detail))).toBe(
      'What changed (vs the live org at validate)',
    );
  });

  it('without a pre-image the snapshot is the before, labelled — never "byte-identical" under a live warning', () => {
    const request = makeRequest({
      kind: 'deploy',
      summaryJson: summaryFor('ApexClass', 'InvoiceService', [CHANGED]),
    });
    service.capture({
      request,
      payload: { deployed: true },
      payloadPath: zipOf({ 'classes/InvoiceService.cls': OLD_CLASS }),
    });
    const [entry] = db.listManifestEntries(projectId);
    expect(entry!.beforeContent).toBe(OLD_CLASS);
    expect(JSON.parse(entry!.detailJson!).baseline).toBe('snapshot');
    const detail = service.entryDetail(entry!.id);
    expect(detail.identical).toBe(true);
    const baseline = manifestBaseline(detail);
    expect(baseline).toBe('snapshot');
    expect(whatChangedHeading(baseline)).toBe(
      'What changed (vs your local snapshot — not the live org)',
    );
    const line = identicalLine(baseline, detail.entry.warnings);
    expect(line).not.toContain('byte-identical');
    expect(line).toBe(
      "Identical to your local snapshot; the org's live copy differed (see the warning above) " +
        'and is not shown here.',
    );
    // No live warning: the original line stands; a pre-S45 entry has no key → snapshot.
    expect(identicalLine(baseline, [])).toBe(
      'The deployed content was byte-identical to the previous version.',
    );
    expect(manifestBaseline({ detail: { warnings: [] } })).toBe('snapshot');
  });

  it('an EXISTS IN TARGET row: the pre-image fills the before; without one the tab says the live copy is not shown', () => {
    const EXISTS =
      'EXISTS IN TARGET — this deploy OVERWRITES a live ApexClass Brand_New that your snapshot ' +
      'does not have (retrieved 10:02); the diff below is against the live version.';
    const withImage = makeRequest({
      kind: 'deploy',
      summaryJson: summaryFor('ApexClass', 'Brand_New', [EXISTS]),
    });
    service.capture({
      request: withImage,
      payload: {
        deployed: true,
        revert_package: revertPackage([
          { type: 'ApexClass', apiName: 'Brand_New', rel: 'classes/Brand_New.cls', text: 'live' },
        ]),
      },
      payloadPath: zipOf({ 'classes/Brand_New.cls': 'mine' }),
    });
    const withoutImage = makeRequest({
      kind: 'deploy',
      summaryJson: summaryFor('ApexClass', 'Brand_New', [EXISTS]),
    });
    service.capture({
      request: withoutImage,
      payload: { deployed: true },
      payloadPath: zipOf({ 'classes/Brand_New.cls': 'mine' }),
    });
    const byRequest = new Map(db.listManifestEntries(projectId).map((e) => [e.requestId, e]));
    const live = byRequest.get(withImage.id)!;
    expect(live.beforeContent).toBe('live');
    expect(service.entryDetail(live.id).identical).toBe(false);

    const bare = byRequest.get(withoutImage.id)!;
    expect(bare.beforeContent).toBeNull();
    const detail = service.entryDetail(bare.id);
    expect(detail.contentSource).toBe('captured');
    expect(detail.identical).toBeNull();
    expect(noDiffLine(manifestBaseline(detail), detail.entry.warnings, false)).toBe(
      "The org's live copy (see the warning above) is not shown here, and your local snapshot " +
        'held no copy to diff against.',
    );
    // A row whose before exists, or with no live warning, keeps the old silence.
    expect(noDiffLine('snapshot', detail.entry.warnings, true)).toBeNull();
    expect(noDiffLine('snapshot', [], false)).toBeNull();
  });

  it('child and bundle pre-images are read at the after side altitude; a file outside the package is ignored', () => {
    const summary = JSON.stringify({
      changes: [
        { type: 'CustomField', api_name: 'Account.Fresh__c', change: 'modify', warnings: [] },
        { type: 'GenAiFunction', api_name: 'Dog_Facts', change: 'modify', warnings: [] },
        { type: 'ApexClass', api_name: 'InvoiceService', change: 'modify', warnings: [] },
      ],
      destructive: [],
      blast: [],
    });
    const liveField = '<fields>\n        <fullName>Fresh__c</fullName>\n        <type>Text</type>\n    </fields>';
    const pkg = revertPackage([
      { type: 'CustomField', apiName: 'Account.Fresh__c', rel: 'children/CustomField/Account.Fresh__c.xml', text: liveField },
      {
        type: 'GenAiFunction',
        apiName: 'Dog_Facts',
        rel: 'bundles/GenAiFunction/Dog_Facts.contrail-bundle.json',
        text: JSON.stringify({
          contrail_bundle: 1,
          files: {
            'Dog_Facts.genAiFunction-meta.xml': '<GenAiFunction>live</GenAiFunction>',
            'output/schema.json': '{"live":true}',
          },
        }),
      },
    ]);
    // A planted path outside the package dir never becomes a "before".
    const outside = path.join(tmp, 'elsewhere.cls');
    fs.writeFileSync(outside, 'not a pre-image');
    pkg.restores.push({ type: 'ApexClass', api_name: 'InvoiceService', content_file: outside });
    service.capture({
      request: makeRequest({ kind: 'deploy', summaryJson: summary }),
      payload: { deployed: true, revert_package: pkg },
      payloadPath: zipOf({
        'objects/Account.object': NEW_OBJECT,
        'genAiFunctions/Dog_Facts/Dog_Facts.genAiFunction-meta.xml': '<GenAiFunction>new</GenAiFunction>',
        'genAiFunctions/Dog_Facts/output/schema.json': '{"new":true}',
        'classes/InvoiceService.cls': NEW_CLASS,
      }),
    });
    const byName = new Map(db.listManifestEntries(projectId).map((e) => [e.apiName, e]));
    const field = byName.get('Account.Fresh__c')!;
    expect(field.beforeContent).toBe(liveField);
    expect(field.afterContent).toContain('<type>Number</type>');
    expect(JSON.parse(field.detailJson!).baseline).toBe('live_preimage');
    const fn = byName.get('Dog_Facts')!;
    expect(fn.beforeContent).toContain('contrail:file genAiFunctions/Dog_Facts/output/schema.json');
    expect(fn.beforeContent).toContain('{"live":true}');
    expect(fn.beforeContent).toContain('<GenAiFunction>live</GenAiFunction>');
    expect(fn.afterContent).toContain('{"new":true}');
    expect(JSON.parse(fn.detailJson!).baseline).toBe('live_preimage');
    const cls = byName.get('InvoiceService')!;
    expect(cls.beforeContent).toBe(OLD_CLASS);
    expect(JSON.parse(cls.detailJson!).baseline).toBe('snapshot');
  });

  it('a junction planted inside the package dir cannot pull a file from outside it', () => {
    const pkg = revertPackage([]);
    const outsideDir = path.join(tmp, 'outside-dir');
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, 'InvoiceService.cls'), 'not a pre-image');
    fs.mkdirSync(pkg.dir, { recursive: true });
    // 'junction' on Windows (no privilege needed); a plain directory symlink elsewhere.
    fs.symlinkSync(outsideDir, path.join(pkg.dir, 'linked'), 'junction');
    const planted = path.join(pkg.dir, 'linked', 'InvoiceService.cls');
    // The lexical check alone would accept it; the real path is outside.
    expect(path.resolve(planted).startsWith(path.resolve(pkg.dir) + path.sep)).toBe(true);
    pkg.restores.push({ type: 'ApexClass', api_name: 'InvoiceService', content_file: planted });
    service.capture({
      request: makeRequest({
        kind: 'deploy',
        summaryJson: summaryFor('ApexClass', 'InvoiceService', []),
      }),
      payload: { deployed: true, revert_package: pkg },
      payloadPath: zipOf({ 'classes/InvoiceService.cls': NEW_CLASS }),
    });
    const [entry] = db.listManifestEntries(projectId);
    expect(entry!.beforeContent).toBe(OLD_CLASS);
    expect(entry!.beforeContent).not.toContain('not a pre-image');
    expect(JSON.parse(entry!.detailJson!).baseline).toBe('snapshot');
  });
});
