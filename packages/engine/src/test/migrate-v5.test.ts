import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ContrailDb } from '../core/db.js';

/**
 * The v5 → v12 upgrade — the ONE path every teammate's existing install takes,
 * and the one no other test exercised (they all start fresh, which runs every
 * migration at once rather than the real step-by-step upgrade).
 *
 * The fixture below is a database exactly as the FROZEN v5 plugin writes it:
 * the DDL is transcribed verbatim from the plugin's migrate() at user_version
 * 5, so this test also pins the freeze contract — if the desktop engine ever
 * stops reading a real v5 file, this fails.
 */

let tmp: string;
let dbPath: string;

/** Build a genuine v5 database (plugin schema, user_version = 5) with data. */
function writeV5Fixture(file: string): void {
  const raw = new Database(file);
  raw.exec(`
    CREATE TABLE connections (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL DEFAULT 'default',
      alias TEXT NOT NULL UNIQUE COLLATE NOCASE, instance_url TEXT NOT NULL,
      login_url TEXT NOT NULL, org_id TEXT NOT NULL, org_name TEXT,
      org_type TEXT NOT NULL, is_sandbox INTEGER NOT NULL, username TEXT,
      user_id TEXT, grants_json TEXT NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, last_used_at TEXT
    );
    CREATE TABLE audit_events (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL DEFAULT 'default',
      ts TEXT NOT NULL, event_type TEXT NOT NULL, connection_id TEXT,
      tool TEXT, outcome TEXT NOT NULL, detail_json TEXT
    );
    CREATE TABLE artifacts (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL DEFAULT 'default',
      connection_id TEXT NOT NULL, type TEXT NOT NULL, api_name TEXT NOT NULL,
      file_path TEXT, content_hash TEXT, last_modified_date TEXT,
      last_modified_by TEXT, retrieved_at TEXT NOT NULL,
      UNIQUE (connection_id, type, api_name)
    );
    CREATE TABLE dependency_edges (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL DEFAULT 'default',
      connection_id TEXT NOT NULL, from_type TEXT NOT NULL, from_name TEXT NOT NULL,
      to_type TEXT NOT NULL, to_name TEXT NOT NULL, source TEXT NOT NULL,
      UNIQUE (connection_id, from_type, from_name, to_type, to_name, source)
    );
    CREATE VIRTUAL TABLE artifact_fts USING fts5(
      api_name, type, content, connection_id UNINDEXED, artifact_id UNINDEXED
    );
    CREATE TABLE deploy_requests (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL DEFAULT 'default',
      connection_id TEXT NOT NULL, kind TEXT NOT NULL, confirmation_code TEXT NOT NULL,
      status TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      executed_at TEXT, payload_path TEXT, payload_json TEXT, summary_json TEXT NOT NULL,
      validation_id TEXT, result_json TEXT, failed_attempts INTEGER NOT NULL DEFAULT 0
    );
  `);

  const now = '2026-01-01T00:00:00.000Z';
  const grants = JSON.stringify({
    metadata_read: true,
    metadata_write: true,
    diagnostics_read: false,
    data_read: true,
    data_write: false,
  });
  raw
    .prepare(
      `INSERT INTO connections (id, alias, instance_url, login_url, org_id, org_name,
        org_type, is_sandbox, username, user_id, grants_json, created_at, updated_at, last_used_at)
       VALUES ('conn-v5', 'legacy-dev', 'https://legacy.my.salesforce.com',
        'https://test.salesforce.com', '00Dv5', 'Legacy Dev', 'sandbox', 1,
        'u@example.com', '005v5', ?, ?, ?, NULL)`,
    )
    .run(grants, now, now);
  raw
    .prepare(
      `INSERT INTO artifacts (id, connection_id, type, api_name, file_path, content_hash,
        last_modified_date, last_modified_by, retrieved_at)
       VALUES ('art-v5', 'conn-v5', 'ApexClass', 'LegacyThing', 'classes/LegacyThing.cls',
        'hashv5', ?, 'admin', ?)`,
    )
    .run(now, now);
  raw
    .prepare(
      `INSERT INTO dependency_edges (id, connection_id, from_type, from_name, to_type, to_name, source)
       VALUES ('edge-v5', 'conn-v5', 'ApexClass', 'LegacyThing', 'CustomObject', 'Account', 'extractor')`,
    )
    .run();
  // A v5 deploy request: it carries failed_attempts (the v5 addition) and NONE
  // of the desktop columns that v6+/v9 add.
  raw
    .prepare(
      `INSERT INTO deploy_requests (id, connection_id, kind, confirmation_code, status,
        created_at, expires_at, summary_json, failed_attempts)
       VALUES ('dep-v5', 'conn-v5', 'deploy', 'WXYZ-2345', 'executed', ?, ?,
        '{"changes":[],"destructive":[]}', 2)`,
    )
    .run(now, now);
  raw
    .prepare(
      `INSERT INTO audit_events (id, ts, event_type, connection_id, tool, outcome, detail_json)
       VALUES ('aud-v5', ?, 'connection.created', 'conn-v5', 'connect_org', 'success', '{}')`,
    )
    .run(now);

  raw.pragma('user_version = 5');
  raw.close();
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-v5-'));
  dbPath = path.join(tmp, 'contrail.db');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('a real v5 database upgrades to v12', () => {
  it('lands on v12 and every v5 row survives', () => {
    writeV5Fixture(dbPath);
    const raw = new Database(dbPath, { readonly: true });
    expect(raw.pragma('user_version', { simple: true })).toBe(5);
    raw.close();

    const db = new ContrailDb(dbPath);
    try {
      expect(db.schemaVersion()).toBe(13);

      // The connection is readable by alias (COLLATE NOCASE survives).
      const conn = db.resolveConnection('LEGACY-DEV');
      expect(conn?.id).toBe('conn-v5');
      expect(conn?.grants.metadata_write).toBe(true);
      expect(conn?.grants.data_write).toBe(false);

      // The artifact and its content hash survive.
      const art = db.getArtifact('conn-v5', 'ApexClass', 'LegacyThing');
      expect(art?.contentHash).toBe('hashv5');
    } finally {
      db.close();
    }
  });

  it('a v5 deploy_requests row reads back with the new desktop columns NULL', () => {
    writeV5Fixture(dbPath);
    const db = new ContrailDb(dbPath);
    try {
      const rec = db.getDeployRequest('dep-v5');
      expect(rec).not.toBeNull();
      // v5 data preserved verbatim...
      expect(rec!.confirmationCode).toBe('WXYZ-2345');
      expect(rec!.status).toBe('executed');
      // ...and the columns v6/v9 added are NULL on a row the v5 plugin wrote,
      // never a crash and never a fabricated value.
      expect(rec!.sessionId).toBeNull();
      expect(rec!.desktopState).toBeNull();
      expect(rec!.origin).toBeNull();
      expect(rec!.reviewJson).toBeNull();
    } finally {
      db.close();
    }
  });

  it('creates the whole desktop schema on top without touching v5 tables', () => {
    writeV5Fixture(dbPath);
    const db = new ContrailDb(dbPath);
    db.close();

    const raw = new Database(dbPath, { readonly: true });
    const tables = (
      raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    raw.close();
    // v6 additions
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
      expect(tables, `${t} must be created`).toContain(t);
    }
    // v10/v11 additions
    expect(tables).toContain('spend_events');
    expect(tables).toContain('app_settings');
    expect(tables).toContain('artifact_summaries');
    // v13 additions
    expect(tables).toContain('custom_skills');
    expect(tables).toContain('skill_toggles');
    // v5 tables still present
    for (const t of ['connections', 'artifacts', 'dependency_edges', 'deploy_requests', 'audit_events']) {
      expect(tables, `${t} must survive`).toContain(t);
    }
  });

  it('the upgraded database is fully usable — a saved summary round-trips', () => {
    writeV5Fixture(dbPath);
    const db = new ContrailDb(dbPath);
    try {
      const key = {
        kind: 'artifact' as const,
        connectionId: 'conn-v5',
        type: 'ApexClass',
        apiName: 'LegacyThing',
      };
      db.putSavedSummary({
        ...key,
        connectionBId: '',
        contentHash: 'hashv5',
        contentHashB: null,
        summary: 'A legacy Apex class.',
        model: 'claude-haiku-4-5',
      });
      const saved = db.getSavedSummary(key);
      expect(saved?.summary).toBe('A legacy Apex class.');
      // The hash rode along as data, so staleness is decidable post-upgrade.
      expect(saved?.contentHash).toBe('hashv5');
    } finally {
      db.close();
    }
  });

  it('reopening the upgraded database is a no-op (idempotent)', () => {
    writeV5Fixture(dbPath);
    new ContrailDb(dbPath).close();
    const again = new ContrailDb(dbPath);
    expect(again.schemaVersion()).toBe(13);
    // Data still there after a second open.
    expect(again.resolveConnection('legacy-dev')?.id).toBe('conn-v5');
    again.close();
  });
});
