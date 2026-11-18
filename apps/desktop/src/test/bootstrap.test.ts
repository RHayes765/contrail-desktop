import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { invokeCapability } from '@contrail/engine';
import { bootstrap, type Bootstrap } from '../main/bootstrap.js';

/**
 * S46 (B): the host's version reaches the engine. bootstrap() is the only
 * production createEngineDeps call, and the change-evidence dossier prints
 * EngineDeps.appVersion ("Generated … by Contrail <version> (desktop)") —
 * without it every dossier the app writes says "version unknown".
 *
 * The real bootstrap against a temporary data directory. Two engine exports
 * are replaced so the test touches neither the network nor the OS keychain:
 * the update notice (its stale-cache refresh would call GitHub) and the
 * stored API key read behind the first-run banner.
 */

vi.mock('@contrail/engine', async (importOriginal) => {
  const real = await importOriginal<typeof import('@contrail/engine')>();
  return {
    ...real,
    getUpdateNotice: () => null,
    readSecretResult: () => ({ ok: true as const, value: null }),
  };
});

const VERSION = '9.8.7';

let tmp: string;
let boot: Bootstrap | null;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-bootstrap-'));
  process.env.CONTRAIL_DATA_DIR = tmp;
  boot = null;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  if (boot) {
    await boot.deps.localDiag.shutdown();
    boot.deps.db.close();
  }
  vi.restoreAllMocks();
  delete process.env.CONTRAIL_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('bootstrap', () => {
  it("hands the host's version to the engine, and the change-evidence dossier prints it", async () => {
    boot = bootstrap(VERSION);
    expect(boot.deps.db.file).toBe(path.join(tmp, 'contrail.db'));
    expect(boot.deps.appVersion).toBe(VERSION);
    expect(boot.health.appVersion).toBe(VERSION);
    // S46 (B): the engine reads its presenter's mode at every mint — native
    // keeps the code off the phone push, records governance.surface 'native'
    // and words the freeze notes for Deploy Review, never the approval page.
    expect(boot.approvals.mode).toBe('native');
    expect((boot.deps.deploys as unknown as { approvals: unknown }).approvals).toBe(boot.approvals);

    const db = boot.deps.db;
    const conn = db.insertConnection({
      alias: 'acme-dev',
      instanceUrl: 'https://acme.example.invalid',
      loginUrl: 'https://login.salesforce.com',
      orgId: '00D000000000001AAA',
      orgName: 'Acme',
      orgType: 'developer',
      isSandbox: false,
      username: 'admin@acme.example.invalid',
      userId: '005000000000001AAA',
      grants: {
        metadata_read: true,
        metadata_write: false,
        diagnostics_read: false,
        data_read: false,
        data_write: false,
      },
    });
    db.insertDeployRequest({
      connectionId: conn.id,
      kind: 'deploy',
      confirmationCode: 'ABCD-EFGH',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      summaryJson: JSON.stringify({
        changes: [{ type: 'ApexClass', api_name: 'InvoiceService', change: 'modify', warnings: [] }],
        destructive: [],
        blast: [],
      }),
    });

    const res = await invokeCapability(boot.deps, 'export_change_evidence', {
      connection: 'acme-dev',
    });
    const text = (res.content as Array<{ type: string; text?: string }>)
      .map((c) => c.text ?? '')
      .join('\n');
    expect(res.isError ?? false, text).toBe(false);
    const body = JSON.parse(text.slice(text.indexOf('\n{') + 1)) as { path: string };
    expect(path.dirname(body.path)).toBe(path.join(tmp, 'evidence'));

    const md = fs.readFileSync(path.join(body.path, 'evidence.md'), 'utf8');
    expect(md).toMatch(/^Generated .+ by Contrail 9\.8\.7 \(desktop\)\. Filters: /m);
    expect(md).not.toContain('version unknown');
    const json = JSON.parse(fs.readFileSync(path.join(body.path, 'evidence.json'), 'utf8')) as {
      engine_version: string;
      surface: string;
    };
    expect(json.engine_version).toBe(VERSION);
    expect(json.surface).toBe('desktop');
  });
});
