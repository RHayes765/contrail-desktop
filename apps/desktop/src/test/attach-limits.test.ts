import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ContrailDb, type EngineDeps } from '@contrail/engine';
import { ProjectService } from '../main/services/projects.js';
import { ConnectionService } from '../main/services/connections.js';

/**
 * S12: chat file-drop (docs:addFromPath) and org limits — the two features
 * where the renderer names things (paths, connections) that main must treat
 * as claims, not facts.
 */

let tmp: string;
/** Source files live OUTSIDE the data dir — inside it, the containment guard
 * (correctly) refuses them, which is its own test below. */
let src: string;
let db: ContrailDb;
let deps: EngineDeps;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-attach-'));
  src = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-src-'));
  process.env.CONTRAIL_DATA_DIR = tmp; // project docs live under the data dir
  db = new ContrailDb(path.join(tmp, 'test.db'));
  deps = {
    db,
    audit: { record: () => undefined },
    tokenMgr: { getAccessToken: async () => 'AT' },
    config: { salesforce: { apiVersion: 'v61.0' } },
  } as unknown as EngineDeps;
});

afterEach(() => {
  vi.unstubAllGlobals();
  db.close();
  delete process.env.CONTRAIL_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(src, { recursive: true, force: true });
});

describe('chat file-drop lands in the project silo', () => {
  it('copies the dropped file into THIS project docs and the agent path can read it', () => {
    const projects = new ProjectService(deps);
    const p = projects.create('Drop Target');
    const dropped = path.join(src, 'notes about the client.md');
    fs.writeFileSync(dropped, '# renewal plan\ndetails here', 'utf8');

    const doc = projects.addDocFromPath(p.id, dropped);
    expect(doc.filename).toBe('notes about the client.md');

    // The copy is real and silo-scoped — listed for this project only.
    expect(projects.listDocs(p.id).map((d) => d.filename)).toContain('notes about the client.md');
    const other = projects.create('Other Project');
    expect(projects.listDocs(other.id)).toHaveLength(0);

    // Editing the ORIGINAL after the drop cannot change what the agent reads.
    fs.writeFileSync(dropped, 'ALTERED AFTER ATTACH', 'utf8');
    const read = projects.readDocText(p.id, 'notes about the client.md');
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.text).toContain('renewal plan');
  });

  it('refuses directories, missing files, and oversized files', () => {
    const projects = new ProjectService(deps);
    const p = projects.create('P');
    // A dropped FOLDER points the human at the linked-folders feature (S23).
    expect(() => projects.addDocFromPath(p.id, src)).toThrow(/is a folder — .*link/);
    expect(() => projects.addDocFromPath(p.id, path.join(src, 'nope.pdf'))).toThrow();
    const big = path.join(src, 'big.bin');
    fs.writeFileSync(big, Buffer.alloc(26 * 1024 * 1024));
    expect(() => projects.addDocFromPath(p.id, big)).toThrow(/25MB/);
  });

  it('refuses a drop into a project that does not exist', () => {
    const projects = new ProjectService(deps);
    const f = path.join(src, 'x.txt');
    fs.writeFileSync(f, 'x', 'utf8');
    expect(() => projects.addDocFromPath('no-such-project', f)).toThrow();
  });
});

describe('org limits', () => {
  function stubLimits(payload: Record<string, unknown>, status = 200): void {
    vi.stubGlobal('fetch', async () => ({
      ok: status === 200,
      status,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    }));
  }

  function seedConn(): string {
    return db.insertConnection({
      alias: 'limits-org',
      instanceUrl: 'https://limits.my.salesforce.com',
      loginUrl: 'https://login.salesforce.com',
      orgId: '00DL',
      orgName: 'Limits',
      orgType: 'sandbox',
      isSandbox: true,
      username: null,
      userId: null,
      grants: {
        metadata_read: true,
        metadata_write: false,
        diagnostics_read: false,
        data_read: false,
        data_write: false,
      },
    }).id;
  }

  it('returns the watched limits with used derived, skipping malformed entries', async () => {
    const id = seedConn();
    stubLimits({
      DailyApiRequests: { Max: 100_000, Remaining: 87_650 },
      DataStorageMB: { Max: 200, Remaining: 12 },
      // Malformed / irrelevant entries must be skipped, not crash the view.
      DailyBulkV2QueryJobs: { Max: 'not-a-number', Remaining: 5 },
      SomethingIrrelevant: { Max: 1, Remaining: 1 },
    });
    const svc = new ConnectionService(deps, () => undefined as never);
    const view = await svc.limits(id);
    const byKey = Object.fromEntries(view.limits.map((l) => [l.key, l]));
    expect(byKey.DailyApiRequests!.used).toBe(12_350);
    expect(byKey.DailyApiRequests!.remaining).toBe(87_650);
    expect(byKey.DataStorageMB!.used).toBe(188);
    expect(byKey.DailyBulkV2QueryJobs).toBeUndefined(); // malformed → skipped
    expect(byKey.SomethingIrrelevant).toBeUndefined(); // unwatched → skipped
    expect(view.alias).toBe('limits-org');
  });

  it('an unknown connection is refused before any API call', async () => {
    let called = false;
    vi.stubGlobal('fetch', async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({}) };
    });
    const svc = new ConnectionService(deps, () => undefined as never);
    await expect(svc.limits('ghost')).rejects.toThrow(/not found/);
    expect(called).toBe(false);
  });
});

describe('containment: the data dir is off limits to drops (review finding)', () => {
  it('refuses a source inside another project silo or the DB itself', () => {
    const projects = new ProjectService(deps);
    const a = projects.create('A');
    const b = projects.create('B');
    // Plant a doc in B the legitimate way.
    const legit = path.join(src, 'b-notes.md');
    fs.writeFileSync(legit, 'B secrets', 'utf8');
    projects.addDocFromPath(b.id, legit);
    const bDocPath = path.join(tmp, 'projects', b.id, 'docs', 'b-notes.md');
    expect(fs.existsSync(bDocPath)).toBe(true);

    // The attack: A names B's stored doc, and the database file, as sources.
    expect(() => projects.addDocFromPath(a.id, bDocPath)).toThrow(/data directory/);
    expect(() => projects.addDocFromPath(a.id, path.join(tmp, 'test.db'))).toThrow(
      /data directory/,
    );
    expect(projects.listDocs(a.id)).toHaveLength(0);
  });
});
