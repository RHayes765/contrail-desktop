import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ContrailDb } from '../core/db.js';

/**
 * Schema v6 — the desktop additions — and the v5 freeze contract: the shared
 * DB must stay readable and writable by the frozen v5 plugin.
 */

let tmp: string;
let dbPath: string;
let db: ContrailDb;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-v6-'));
  dbPath = path.join(tmp, 'test.db');
  db = new ContrailDb(dbPath);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('schema v6', () => {
  it('fresh databases land on user_version 11', () => {
    expect(db.schemaVersion()).toBe(11);
  });

  it('creates every desktop table', () => {
    const raw = new Database(dbPath, { readonly: true });
    const names = (
      raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    raw.close();
    for (const t of [
      'projects',
      'project_bindings',
      'project_docs',
      'project_notes',
      'sessions',
      'metadata_snapshots',
      'mcp_server_toggles',
      'custom_mcp_servers',
      'connector_configs',
      'app_locks',
    ]) {
      expect(names, `${t} must exist`).toContain(t);
    }
  });

  it('adds only nullable columns to deploy_requests (v5 freeze contract)', () => {
    const raw = new Database(dbPath, { readonly: true });
    const cols = raw.prepare(`PRAGMA table_info(deploy_requests)`).all() as Array<{
      name: string;
      notnull: number;
      dflt_value: unknown;
    }>;
    raw.close();
    const v6Cols = [
      'session_id',
      'source_connection_id',
      'approved_at',
      'approved_comment',
      'desktop_state',
      'origin',
    ];
    for (const name of v6Cols) {
      const col = cols.find((c) => c.name === name);
      expect(col, `${name} must exist`).toBeTruthy();
      // Nullable (or defaulted) so v5 INSERTs that don't know the column succeed.
      expect(
        col!.notnull === 0 || col!.dflt_value !== null,
        `${name} must be nullable or defaulted`,
      ).toBe(true);
    }
  });

  it('a v5-style writer still inserts into deploy_requests without the new columns', () => {
    // Simulate the frozen plugin: a raw INSERT naming only v5 columns.
    const raw = new Database(dbPath);
    raw
      .prepare(
        `INSERT INTO deploy_requests
           (id, workspace_id, connection_id, kind, confirmation_code, status,
            created_at, expires_at, summary_json, failed_attempts)
         VALUES (?, 'default', ?, 'deploy', ?, 'validated', ?, ?, '{}', 0)`,
      )
      .run(
        'req-v5-writer',
        'conn-1',
        'ABCD-EFGH',
        '2026-08-14T00:00:00.000Z',
        '2099-01-01T00:00:00.000Z',
      );
    const row = raw
      .prepare(`SELECT desktop_state, origin FROM deploy_requests WHERE id = 'req-v5-writer'`)
      .get() as { desktop_state: string | null; origin: string | null };
    raw.close();
    expect(row.desktop_state).toBeNull();
    expect(row.origin).toBeNull();
  });

  it('reopening an already-v6 database is a no-op migration', () => {
    db.close();
    const again = new ContrailDb(dbPath);
    expect(again.schemaVersion()).toBe(11);
    again.close();
    db = new ContrailDb(dbPath); // for afterEach
  });
});

/**
 * The v10 → v11 UPGRADE step, not just the end state. Fresh databases run
 * every migration at once, which is exactly the path a teammate's existing
 * install will NOT take: theirs holds real data at an older version. This
 * rewinds a live database to the v10 shape and steps it forward.
 */
describe('v10 → v11 upgrade on an existing database', () => {
  it('replaces the hash-keyed cache with addressable summaries, data intact', () => {
    const conn = db.insertConnection({
      alias: 'keep-me',
      instanceUrl: 'https://example.my.salesforce.com',
      loginUrl: 'https://test.salesforce.com',
      orgId: '00Dxx',
      orgName: 'Keep',
      orgType: 'sandbox',
      isSandbox: true,
      username: 'u@example.com',
      userId: '005xx',
      grants: {
        metadata_read: true,
        metadata_write: false,
        diagnostics_read: false,
        data_read: false,
        data_write: false,
      },
    });
    db.close();

    // Rewind: put the v10 table back, take v11's away, drop the version.
    const raw = new Database(dbPath);
    raw.exec(`
      DROP TABLE IF EXISTS artifact_summaries;
      CREATE TABLE summary_cache (
        cache_key  TEXT PRIMARY KEY,
        summary    TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO summary_cache VALUES ('Flow:Old:hash', 'stale cached text', '2026-01-01T00:00:00Z');
    `);
    raw.pragma('user_version = 10');
    raw.close();

    db = new ContrailDb(dbPath);
    expect(db.schemaVersion()).toBe(11);

    const check = new Database(dbPath, { readonly: true });
    const tables = (
      check.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    check.close();
    expect(tables).toContain('artifact_summaries');
    expect(tables).not.toContain('summary_cache');

    // Migration must not disturb anything else in the file.
    expect(db.resolveConnection('keep-me')?.id).toBe(conn.id);

    // And the new table works immediately after the upgrade.
    const key = {
      kind: 'artifact' as const,
      connectionId: conn.id,
      type: 'Flow',
      apiName: 'Old',
    };
    db.putSavedSummary({
      ...key,
      connectionBId: '',
      contentHash: 'hash',
      contentHashB: null,
      summary: 'new text',
      model: 'claude-haiku-4-5',
    });
    expect(db.getSavedSummary(key)?.summary).toBe('new text');
  });
});
