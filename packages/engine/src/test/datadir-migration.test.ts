import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migrateLegacyWindowsDataDir } from '../core/paths.js';
import { ContrailDb } from '../core/db.js';

/**
 * The data-dir escape from the MSIX-virtualized zone. The migration copies a
 * legacy %LOCALAPPDATA%\Contrail install into the new profile-root home,
 * pre-authorizes the copy with the lineage guard, and fixes the absolute
 * paths stored inside the database. It must be idempotent, refuse to
 * masquerade a failure as a fresh install, and never delete the original.
 */

let base: string;
let legacy: string;
let fresh: string;

function seedLegacy(dir: string): void {
  fs.mkdirSync(path.join(dir, 'snapshots', 'conn-1', 'current'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  const db = new ContrailDb(path.join(dir, 'contrail.db'));
  db.close();
  const raw = new Database(path.join(dir, 'contrail.db'));
  raw
    .prepare(
      `INSERT INTO sessions (id, workspace_id, project_id, title, status, model, transcript_path, created_at)
       VALUES ('s1', 'default', 'p1', 't', 'ended', 'm', ?, '2026-01-01T00:00:00Z')`,
    )
    .run(path.join(dir, 'sessions', 's1.jsonl'));
  raw.close();
  fs.writeFileSync(path.join(dir, 'sessions', 's1.jsonl'), '{"kind":"session"}\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'snapshots', 'conn-1', 'current', 'x.cls'), 'class X {}', 'utf8');
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-migrate-'));
  legacy = path.join(base, 'legacy');
  fresh = path.join(base, 'fresh');
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('legacy data-dir migration', () => {
  it('copies everything, pre-adopts the database, fixes stored paths, keeps the original', () => {
    seedLegacy(legacy);
    migrateLegacyWindowsDataDir(fresh, legacy);

    // Whole tree came over.
    expect(fs.existsSync(path.join(fresh, 'contrail.db'))).toBe(true);
    expect(fs.existsSync(path.join(fresh, 'snapshots', 'conn-1', 'current', 'x.cls'))).toBe(true);
    expect(fs.existsSync(path.join(fresh, 'sessions', 's1.jsonl'))).toBe(true);

    // The lineage guard is pre-authorized: the engine's first open ADOPTS.
    expect(fs.existsSync(path.join(fresh, 'contrail.db.adopt'))).toBe(true);
    const db = new ContrailDb(path.join(fresh, 'contrail.db')); // must not throw
    // Stored absolute paths now point at the new home.
    const rec = db.getAgentSession('s1');
    expect(rec?.transcriptPath).toBe(path.join(fresh, 'sessions', 's1.jsonl'));
    db.close();
    expect(fs.existsSync(path.join(fresh, 'contrail.db.adopt'))).toBe(false); // consumed

    // The original survives, with a breadcrumb.
    expect(fs.existsSync(path.join(legacy, 'contrail.db'))).toBe(true);
    expect(fs.readFileSync(path.join(legacy, 'MIGRATED-TO.txt'), 'utf8')).toContain(fresh);
  });

  it('is a no-op when the target already has a database, and re-running never re-copies', () => {
    seedLegacy(legacy);
    fs.mkdirSync(fresh, { recursive: true });
    fs.writeFileSync(path.join(fresh, 'contrail.db'), 'existing', 'utf8');
    migrateLegacyWindowsDataDir(fresh, legacy); // target populated: untouched
    expect(fs.readFileSync(path.join(fresh, 'contrail.db'), 'utf8')).toBe('existing');
    expect(fs.existsSync(path.join(fresh, 'contrail.db.adopt'))).toBe(false);
  });

  it('is a no-op on a fresh machine (no legacy dir) and when both paths are the same', () => {
    migrateLegacyWindowsDataDir(fresh, legacy); // neither exists
    expect(fs.existsSync(path.join(fresh, 'contrail.db'))).toBe(false);
    seedLegacy(legacy);
    migrateLegacyWindowsDataDir(legacy, legacy); // same dir: never self-copy
    expect(fs.existsSync(path.join(legacy, 'MIGRATED-TO.txt'))).toBe(false);
  });
});
