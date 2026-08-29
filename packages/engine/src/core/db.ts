import Database from 'better-sqlite3';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ContrailError } from './errors.js';
import { dbPath } from './paths.js';
import { normalizeGrants, type GrantSet } from './grants.js';
import type {
  AgentSessionRecord,
  ArtifactRecord,
  AuditEvent,
  ConnectionRecord,
  CustomMcpServerExtras,
  CustomMcpServerRecord,
  CustomSkillRecord,
  DependencyEdge,
  DeployRequestKind,
  DeployRequestRecord,
  OrgType,
  ProjectDocRecord,
  ProjectNoteRecord,
  ProjectRecord,
  SavedSummaryRecord,
  ServerToggleRecord,
  SkillToggleRecord,
} from './types.js';

// ── split-brain guard ────────────────────────────────────────────────────
//
// On this machine class (MSIX-packaged hosts), two processes can open "the
// same" database path through DIFFERENT filesystem views: a containerized
// process gets a copy-on-write overlay clone while an outside process keeps
// the real file. Both are self-consistent, SQLite's locking never meets, and
// interleaved checkpoints from the two lineages corrupt the shared pages —
// this destroyed a real database on 2026-08-26.
//
// The guard: stamp a 31-bit hash of the file's OS identity (volume + NTFS
// file id) into PRAGMA application_id — a header slot, so it needs no table
// and works at every schema version either engine can open. A COW clone is a
// physically different file with a different id, so a forked view fails the
// check on its next open, BEFORE any pragma or migration writes. A deliberate
// replacement (restore, copied-in backup) re-stamps by dropping a marker file
// `<db>.adopt` next to the database.

/** FNV-1a over the identity string, folded to a positive 31-bit non-zero int. */
function fileIdentityStamp(file: string): number | null {
  let stat: fs.BigIntStats;
  try {
    stat = fs.statSync(file, { bigint: true });
  } catch {
    return null;
  }
  if (stat.ino === 0n) return null; // non-NTFS / unsupported: guard degrades off
  const identity = `${stat.dev}:${stat.ino}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < identity.length; i++) {
    h ^= identity.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h = h & 0x7fffffff;
  return h === 0 ? 1 : h;
}

/** Throws before ANY write when the opened file is not the stamped lineage. */
function assertDbLineage(db: Database.Database): void {
  const expected = fileIdentityStamp(db.name);
  if (expected === null) return;
  const stored = db.pragma('application_id', { simple: true }) as number;
  if (stored === expected) return;
  const adoptMarker = `${db.name}.adopt`;
  if (stored === 0 || fs.existsSync(adoptMarker)) {
    // Never stamped (pre-guard database or fresh file), or a deliberate
    // replacement announced via the marker: adopt this file as the lineage.
    db.pragma(`application_id = ${expected}`);
    try {
      fs.rmSync(adoptMarker, { force: true });
    } catch {
      /* marker cleanup is best-effort */
    }
    return;
  }
  throw new ContrailError(
    `This database file is not the one this data directory last used — it is a copy ` +
      `(restored backup, or an MSIX-virtualized overlay view of ${db.name}). Writes are ` +
      `refused to prevent a split-brain fork. If this replacement was deliberate, create ` +
      `an empty file named "${adoptMarker}" and reopen.`,
    'db_lineage_mismatch',
  );
}

const SCHEMA_VERSION = 13;

/**
 * Local SQLite store: connection metadata and the audit log (P0.1); the
 * artifact index, dependency graph, and deploy requests join it in later
 * milestones. Stable UUIDs and workspace_id columns from day one so the data
 * survives into the desktop app (spec §6).
 *
 * ── v5 FREEZE CONTRACT (shared database) ─────────────────────────────────
 * This database is SHARED with the Contrail plugin, whose engine is frozen
 * at schema v5 logic and whose migrate() no-ops for user_version >= 5. While
 * that sharing lasts, migrations here (v6+) must be ADDITIVE ONLY:
 *   - never rename, repurpose, or drop anything a v5 reader touches
 *     (connections, artifacts, dependency_edges, artifact_fts,
 *     deploy_requests' existing columns, audit_events);
 *   - new columns on those tables must be nullable (no NOT NULL without
 *     default — v5 INSERTs don't know them);
 *   - deploy_requests.status keeps its v5 vocabulary (validated/executing/
 *     executed/execution_failed/expired/superseded/locked) because the v5
 *     claimCode path queries it; the desktop's richer state machine lives in
 *     the separate desktop_state column.
 * Desktop-only state goes in NEW tables.
 */
export class ContrailDb {
  private readonly db: Database.Database;

  constructor(filePath: string = dbPath()) {
    this.db = new Database(filePath);
    try {
      // The lineage check runs FIRST — before WAL mode, before migrations —
      // so a mismatched view is refused without writing to the database.
      assertDbLineage(this.db);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      // Shared-DB politeness: the plugin may hold short write transactions on
      // the same file; wait instead of surfacing SQLITE_BUSY immediately.
      this.db.pragma('busy_timeout = 5000');
      this.migrate();
    } catch (err) {
      // A refused open must not leak the handle — a locked file with no
      // owner object is its own incident.
      this.db.close();
      throw err;
    }
  }

  /**
   * The file better-sqlite3 ACTUALLY opened — ground truth, not a computed
   * path. Diagnostics must show this, never re-derive dataDir().
   */
  get file(): string {
    return this.db.name;
  }

  /** The stored schema version (SQLite user_version). */
  schemaVersion(): number {
    return this.db.pragma('user_version', { simple: true }) as number;
  }

  private migrate(): void {
    const current = this.db.pragma('user_version', { simple: true }) as number;
    if (current >= SCHEMA_VERSION) return;
    const tx = this.db.transaction(() => {
      if (current < 1) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS connections (
            id            TEXT PRIMARY KEY,
            workspace_id  TEXT NOT NULL DEFAULT 'default',
            alias         TEXT NOT NULL UNIQUE COLLATE NOCASE,
            instance_url  TEXT NOT NULL,
            login_url     TEXT NOT NULL,
            org_id        TEXT NOT NULL,
            org_name      TEXT,
            org_type      TEXT NOT NULL,
            is_sandbox    INTEGER NOT NULL,
            username      TEXT,
            user_id       TEXT,
            grants_json   TEXT NOT NULL,
            created_at    TEXT NOT NULL,
            updated_at    TEXT NOT NULL,
            last_used_at  TEXT
          );
          CREATE TABLE IF NOT EXISTS audit_events (
            id            TEXT PRIMARY KEY,
            workspace_id  TEXT NOT NULL DEFAULT 'default',
            ts            TEXT NOT NULL,
            event_type    TEXT NOT NULL,
            connection_id TEXT,
            tool          TEXT,
            outcome       TEXT NOT NULL,
            detail_json   TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_events (ts);
          CREATE INDEX IF NOT EXISTS idx_audit_connection ON audit_events (connection_id);
        `);
      }
      if (current < 2) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS artifacts (
            id                 TEXT PRIMARY KEY,
            workspace_id       TEXT NOT NULL DEFAULT 'default',
            connection_id      TEXT NOT NULL,
            type               TEXT NOT NULL,
            api_name           TEXT NOT NULL,
            file_path          TEXT,
            content_hash       TEXT,
            last_modified_date TEXT,
            last_modified_by   TEXT,
            retrieved_at       TEXT NOT NULL,
            UNIQUE (connection_id, type, api_name)
          );
          CREATE INDEX IF NOT EXISTS idx_artifacts_conn_type ON artifacts (connection_id, type);
          CREATE TABLE IF NOT EXISTS dependency_edges (
            id            TEXT PRIMARY KEY,
            workspace_id  TEXT NOT NULL DEFAULT 'default',
            connection_id TEXT NOT NULL,
            from_type     TEXT NOT NULL,
            from_name     TEXT NOT NULL,
            to_type       TEXT NOT NULL,
            to_name       TEXT NOT NULL,
            source        TEXT NOT NULL,
            UNIQUE (connection_id, from_type, from_name, to_type, to_name, source)
          );
          CREATE INDEX IF NOT EXISTS idx_edges_from ON dependency_edges (connection_id, from_type, from_name);
          CREATE INDEX IF NOT EXISTS idx_edges_to ON dependency_edges (connection_id, to_type, to_name);
          CREATE VIRTUAL TABLE IF NOT EXISTS artifact_fts USING fts5(
            api_name, type, content, connection_id UNINDEXED, artifact_id UNINDEXED
          );
        `);
      }
      if (current < 3) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS deploy_requests (
            id                TEXT PRIMARY KEY,
            workspace_id      TEXT NOT NULL DEFAULT 'default',
            connection_id     TEXT NOT NULL,
            kind              TEXT NOT NULL,
            confirmation_code TEXT NOT NULL,
            status            TEXT NOT NULL,
            created_at        TEXT NOT NULL,
            expires_at        TEXT NOT NULL,
            executed_at       TEXT,
            payload_path      TEXT,
            payload_json      TEXT,
            summary_json      TEXT NOT NULL,
            validation_id     TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_deploy_requests_conn
            ON deploy_requests (connection_id, kind, status);
        `);
      }
      if (current < 4) {
        // Stores the execution outcome so a late poll after a long deploy
        // still retrieves the result instead of a spurious error.
        this.db.exec(`ALTER TABLE deploy_requests ADD COLUMN result_json TEXT;`);
      }
      if (current < 5) {
        // Brute-force guard: wrong-code guesses against a pending request are
        // counted here and invalidate the code after a threshold.
        this.db.exec(
          `ALTER TABLE deploy_requests ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0;`,
        );
      }
      if (current < 6) {
        // Desktop app (v1): projects as context silos, agent sessions,
        // capability-layer registries, and cross-process advisory locks.
        // ADDITIVE ONLY per the v5 freeze contract above.
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS projects (
            id            TEXT PRIMARY KEY,
            workspace_id  TEXT NOT NULL DEFAULT 'default',
            name          TEXT NOT NULL,
            description   TEXT,
            instructions  TEXT,
            ruleset_ref   TEXT,
            settings_json TEXT,
            created_at    TEXT NOT NULL,
            updated_at    TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS project_bindings (
            id            TEXT PRIMARY KEY,
            workspace_id  TEXT NOT NULL DEFAULT 'default',
            project_id    TEXT NOT NULL,
            connection_id TEXT NOT NULL,
            env_role      TEXT NOT NULL CHECK (env_role IN ('dev','qa','uat','prod','other')),
            created_at    TEXT NOT NULL,
            UNIQUE (project_id, connection_id)
          );
          CREATE TABLE IF NOT EXISTS project_docs (
            id            TEXT PRIMARY KEY,
            workspace_id  TEXT NOT NULL DEFAULT 'default',
            project_id    TEXT NOT NULL,
            filename      TEXT NOT NULL,
            mime          TEXT,
            size_bytes    INTEGER,
            added_at      TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS project_notes (
            id            TEXT PRIMARY KEY,
            workspace_id  TEXT NOT NULL DEFAULT 'default',
            project_id    TEXT NOT NULL,
            session_id    TEXT,
            author        TEXT NOT NULL CHECK (author IN ('user','agent')),
            body          TEXT NOT NULL,
            created_at    TEXT NOT NULL,
            updated_at    TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS sessions (
            id                TEXT PRIMARY KEY,
            workspace_id      TEXT NOT NULL DEFAULT 'default',
            project_id        TEXT NOT NULL,
            title             TEXT,
            status            TEXT NOT NULL,
            transcript_path   TEXT,
            model             TEXT,
            input_tokens      INTEGER NOT NULL DEFAULT 0,
            output_tokens     INTEGER NOT NULL DEFAULT 0,
            cache_read_tokens INTEGER NOT NULL DEFAULT 0,
            cost_usd          REAL NOT NULL DEFAULT 0,
            created_at        TEXT NOT NULL,
            ended_at          TEXT
          );
          CREATE TABLE IF NOT EXISTS metadata_snapshots (
            id             TEXT PRIMARY KEY,
            workspace_id   TEXT NOT NULL DEFAULT 'default',
            connection_id  TEXT NOT NULL,
            taken_at       TEXT NOT NULL,
            kind           TEXT NOT NULL,
            types_json     TEXT,
            archive_path   TEXT,
            artifact_count INTEGER
          );
          CREATE TABLE IF NOT EXISTS mcp_server_toggles (
            id           TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL DEFAULT 'default',
            project_id   TEXT,
            server_key   TEXT NOT NULL,
            enabled      INTEGER NOT NULL DEFAULT 1,
            UNIQUE (project_id, server_key)
          );
          CREATE TABLE IF NOT EXISTS custom_mcp_servers (
            id             TEXT PRIMARY KEY,
            workspace_id   TEXT NOT NULL DEFAULT 'default',
            name           TEXT NOT NULL,
            transport      TEXT NOT NULL,
            url_or_command TEXT NOT NULL,
            auth_mode      TEXT NOT NULL DEFAULT 'independent'
                           CHECK (auth_mode IN ('independent','org_bound')),
            config_json    TEXT,
            enabled        INTEGER NOT NULL DEFAULT 0,
            created_at     TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS connector_configs (
            id           TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL DEFAULT 'default',
            kind         TEXT NOT NULL CHECK (kind IN ('slack','jira','google','custom')),
            name         TEXT NOT NULL,
            config_json  TEXT,
            enabled      INTEGER NOT NULL DEFAULT 0,
            created_at   TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS app_locks (
            name        TEXT PRIMARY KEY,
            holder      TEXT NOT NULL,
            pid         INTEGER NOT NULL,
            acquired_at TEXT NOT NULL,
            expires_at  TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_bindings_project ON project_bindings (project_id);
          CREATE INDEX IF NOT EXISTS idx_docs_project ON project_docs (project_id);
          CREATE INDEX IF NOT EXISTS idx_notes_project ON project_notes (project_id);
          CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions (project_id);
          ALTER TABLE deploy_requests ADD COLUMN session_id TEXT;
          ALTER TABLE deploy_requests ADD COLUMN source_connection_id TEXT;
          ALTER TABLE deploy_requests ADD COLUMN approved_at TEXT;
          ALTER TABLE deploy_requests ADD COLUMN approved_comment TEXT;
          ALTER TABLE deploy_requests ADD COLUMN desktop_state TEXT;
          ALTER TABLE deploy_requests ADD COLUMN origin TEXT;
        `);
      }
      if (current < 7) {
        // v7 (desktop-owned; sessions is a v6 table, so the freeze contract
        // permits altering it): SDK session identity for resume + the
        // reasoning-effort the session ran with. Fresh databases arrive here
        // too — the v6 CREATE above builds sessions without these columns.
        this.db.exec(`
          ALTER TABLE sessions ADD COLUMN sdk_session_id TEXT;
          ALTER TABLE sessions ADD COLUMN effort TEXT;
        `);
      }
      if (current < 8) {
        // v8 (desktop-owned): per-run sync duration — the basis for the
        // "typically takes ~Xm" estimate on the Connections screen.
        this.db.exec(`ALTER TABLE metadata_snapshots ADD COLUMN duration_ms INTEGER;`);
      }
      if (current < 9) {
        // v9 (nullable column on the shared table — freeze-contract legal,
        // same as the v6 additions): the CODE-FREE review model the native
        // approval presenter persists for the Deploy Review screen. The
        // confirmation code NEVER appears in this JSON.
        this.db.exec(`ALTER TABLE deploy_requests ADD COLUMN review_json TEXT;`);
      }
      if (current < 10) {
        // v10 (desktop-owned, all NEW tables — freeze-contract safe):
        //   spend_events  — THE model-spend ledger. Every paid call lands here,
        //                   so a rolling window can be enforced. Session rows
        //                   keep their own totals for the sessions list; this
        //                   table is what the budget guard reads.
        //   app_settings  — small kv for user-editable app policy (the cap).
        //   summary_cache — AI summaries survive a restart. Without this, the
        //                   in-memory cache died with the process and browsing
        //                   the same artifact again re-billed the user.
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS spend_events (
            id           TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL DEFAULT 'default',
            ts           TEXT NOT NULL,
            kind         TEXT NOT NULL,
            model        TEXT,
            cost_usd     REAL NOT NULL,
            session_id   TEXT,
            detail       TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_spend_ts ON spend_events (ts);
          CREATE TABLE IF NOT EXISTS app_settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS summary_cache (
            cache_key  TEXT PRIMARY KEY,
            summary    TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
        `);
      }
      if (current < 11) {
        // v11 (desktop-owned): saved AI summaries, ADDRESSABLE by what they
        // describe rather than by a content hash. v10's summary_cache keyed on
        // the hash, which made it a pure cache: a changed artifact simply
        // missed, so a saved summary could never be shown OR reported as
        // outdated. Storing the hash as DATA instead of identity lets the app
        // load the summary it has and tell the user it is stale.
        //
        // Dropping summary_cache is safe: it shipped hours earlier, is
        // desktop-owned, and nothing else reads it.
        this.db.exec(`
          DROP TABLE IF EXISTS summary_cache;
          CREATE TABLE IF NOT EXISTS artifact_summaries (
            id              TEXT PRIMARY KEY,
            workspace_id    TEXT NOT NULL DEFAULT 'default',
            kind            TEXT NOT NULL,
            connection_id   TEXT NOT NULL,
            -- '' rather than NULL: SQLite treats NULLs as distinct in UNIQUE,
            -- which would let duplicate rows accumulate (the same trap
            -- mcp_server_toggles has with a nullable project_id).
            connection_b_id TEXT NOT NULL DEFAULT '',
            type            TEXT NOT NULL,
            api_name        TEXT NOT NULL,
            content_hash    TEXT,
            content_hash_b  TEXT,
            summary         TEXT NOT NULL,
            model           TEXT,
            created_at      TEXT NOT NULL,
            UNIQUE (kind, connection_id, connection_b_id, type, api_name)
          );
        `);
      }
      if (current < 12) {
        // v12 (desktop-owned): per-connector project default. Whether a
        // connector joins a NEW project is a property of the connector, not
        // something re-decided per project: Slack/Gmail are "always mine" and
        // belong everywhere, a Jira connector may be the client's and does
        // not. Absent toggle rows fall back to this flag (see catalog.ts
        // serverEnabled); explicit per-project toggles still win.
        // 0 preserves the pre-v12 behaviour (external = opt-in per project).
        this.db.exec(
          `ALTER TABLE custom_mcp_servers ADD COLUMN default_on INTEGER NOT NULL DEFAULT 0;`,
        );
      }
      if (current < 13) {
        // v13 (desktop-owned, additive — freeze-contract legal): the skill
        // library. Bundled skills live in @contrail/skills and are NOT
        // persisted (like STANDARD_CATALOG); custom_skills holds uploads,
        // skill_toggles the per-project selection. Same key scheme as MCP:
        // bundled = '<name>', custom = 'ext:<id>' (see catalog.ts
        // skillEnabled — bundled default ON, custom default = default_on,
        // explicit toggles always win). Toggle writes require a project id
        // — same NULL-distinct-UNIQUE trap as mcp_server_toggles.
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS custom_skills (
            id           TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL DEFAULT 'default',
            name         TEXT NOT NULL UNIQUE COLLATE NOCASE,
            description  TEXT NOT NULL,
            dir_name     TEXT NOT NULL,
            default_on   INTEGER NOT NULL DEFAULT 0,
            created_at   TEXT NOT NULL,
            updated_at   TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS skill_toggles (
            id           TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL DEFAULT 'default',
            project_id   TEXT,
            skill_key    TEXT NOT NULL,
            enabled      INTEGER NOT NULL DEFAULT 1,
            UNIQUE (project_id, skill_key)
          );
        `);
      }
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    });
    tx();
  }

  // ── projects & agent sessions (v6, desktop-owned) ──────────────────────

  private projectFromRow(row: {
    id: string;
    name: string;
    description: string | null;
    instructions: string | null;
    ruleset_ref: string | null;
    created_at: string;
    updated_at: string;
  }): ProjectRecord {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      instructions: row.instructions,
      rulesetRef: row.ruleset_ref,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private static readonly PROJECT_COLS =
    'id, name, description, instructions, ruleset_ref, created_at, updated_at';

  createProject(input: {
    name: string;
    description?: string | null;
    instructions?: string | null;
  }): ProjectRecord {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO projects (id, workspace_id, name, description, instructions, created_at, updated_at)
         VALUES (?, 'default', ?, ?, ?, ?, ?)`,
      )
      .run(id, input.name, input.description ?? null, input.instructions ?? null, now, now);
    const created = this.getProject(id);
    if (!created) throw new Error('project insert did not persist');
    return created;
  }

  listProjects(): ProjectRecord[] {
    return (
      this.db
        .prepare(`SELECT ${ContrailDb.PROJECT_COLS} FROM projects ORDER BY created_at`)
        .all() as Parameters<ContrailDb['projectFromRow']>[0][]
    ).map((r) => this.projectFromRow(r));
  }

  getProject(id: string): ProjectRecord | null {
    const row = this.db
      .prepare(`SELECT ${ContrailDb.PROJECT_COLS} FROM projects WHERE id = ?`)
      .get(id) as Parameters<ContrailDb['projectFromRow']>[0] | undefined;
    return row ? this.projectFromRow(row) : null;
  }

  findProjectByName(name: string): ProjectRecord | null {
    const row = this.db
      .prepare(`SELECT ${ContrailDb.PROJECT_COLS} FROM projects WHERE name = ?`)
      .get(name) as Parameters<ContrailDb['projectFromRow']>[0] | undefined;
    return row ? this.projectFromRow(row) : null;
  }

  updateProject(
    id: string,
    patch: { name?: string; description?: string | null; instructions?: string | null },
  ): ProjectRecord | null {
    const current = this.getProject(id);
    if (!current) return null;
    this.db
      .prepare(
        `UPDATE projects SET name = ?, description = ?, instructions = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        patch.name ?? current.name,
        patch.description !== undefined ? patch.description : current.description,
        patch.instructions !== undefined ? patch.instructions : current.instructions,
        new Date().toISOString(),
        id,
      );
    return this.getProject(id);
  }

  /** Removes the project and its silo rows. Session rows stay (audit history). */
  deleteProject(id: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM project_bindings WHERE project_id = ?`).run(id);
      this.db.prepare(`DELETE FROM project_docs WHERE project_id = ?`).run(id);
      this.db.prepare(`DELETE FROM project_notes WHERE project_id = ?`).run(id);
      this.db.prepare(`DELETE FROM mcp_server_toggles WHERE project_id = ?`).run(id);
      this.db.prepare(`DELETE FROM skill_toggles WHERE project_id = ?`).run(id);
      this.db.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
    });
    tx();
  }

  addProjectBinding(projectId: string, connectionId: string, envRole: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO project_bindings (id, workspace_id, project_id, connection_id, env_role, created_at)
         VALUES (?, 'default', ?, ?, ?, ?)`,
      )
      .run(randomUUID(), projectId, connectionId, envRole, new Date().toISOString());
  }

  removeProjectBinding(projectId: string, connectionId: string): void {
    this.db
      .prepare(`DELETE FROM project_bindings WHERE project_id = ? AND connection_id = ?`)
      .run(projectId, connectionId);
  }

  listProjectBindings(projectId: string): Array<{ connectionId: string; envRole: string }> {
    return (
      this.db
        .prepare(`SELECT connection_id, env_role FROM project_bindings WHERE project_id = ?`)
        .all(projectId) as Array<{ connection_id: string; env_role: string }>
    ).map((r) => ({ connectionId: r.connection_id, envRole: r.env_role }));
  }

  // ── spend ledger, app settings, summary cache (v10) ────────────────────

  /**
   * Record money actually spent on a model call. Everything paid goes here —
   * agent turns AND AI summaries — because a budget that only counts one of
   * them is not a budget.
   */
  recordSpend(input: {
    kind: 'session' | 'summary';
    model: string | null;
    costUsd: number;
    sessionId?: string | null;
    detail?: string | null;
  }): void {
    if (!(input.costUsd > 0)) return; // free/cached calls are not ledger events
    this.db
      .prepare(
        `INSERT INTO spend_events (id, workspace_id, ts, kind, model, cost_usd, session_id, detail)
         VALUES (?, 'default', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        new Date().toISOString(),
        input.kind,
        input.model,
        input.costUsd,
        input.sessionId ?? null,
        input.detail ?? null,
      );
  }

  /** Spend in a rolling window, total and split by kind. */
  spendSince(sinceIso: string): {
    totalUsd: number;
    byKind: Array<{ kind: string; usd: number; calls: number }>;
  } {
    const rows = this.db
      .prepare(
        `SELECT kind, SUM(cost_usd) AS usd, COUNT(*) AS calls
         FROM spend_events WHERE ts >= ? GROUP BY kind`,
      )
      .all(sinceIso) as Array<{ kind: string; usd: number | null; calls: number }>;
    const byKind = rows.map((r) => ({ kind: r.kind, usd: r.usd ?? 0, calls: r.calls }));
    return { totalUsd: byKind.reduce((n, r) => n + r.usd, 0), byKind };
  }

  getAppSetting(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setAppSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  /**
   * The saved summary for one artifact (or one org-pair diff), addressed by
   * what it describes. The hashes it was generated from come back with it so
   * the caller can decide whether it is still current.
   */
  getSavedSummary(key: {
    kind: 'artifact' | 'diff';
    connectionId: string;
    connectionBId?: string;
    type: string;
    apiName: string;
  }): SavedSummaryRecord | null {
    const row = this.db
      .prepare(
        `SELECT kind, connection_id, connection_b_id, type, api_name, content_hash,
                content_hash_b, summary, model, created_at
         FROM artifact_summaries
         WHERE kind = ? AND connection_id = ? AND connection_b_id = ? AND type = ? AND api_name = ?`,
      )
      .get(
        key.kind,
        key.connectionId,
        key.connectionBId ?? '',
        key.type,
        key.apiName,
      ) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      kind: row.kind as SavedSummaryRecord['kind'],
      connectionId: row.connection_id as string,
      connectionBId: row.connection_b_id as string,
      type: row.type as string,
      apiName: row.api_name as string,
      contentHash: (row.content_hash as string | null) ?? null,
      contentHashB: (row.content_hash_b as string | null) ?? null,
      summary: row.summary as string,
      model: (row.model as string | null) ?? null,
      createdAt: row.created_at as string,
    };
  }

  /** Upsert — one saved summary per thing summarized; regenerating replaces it. */
  putSavedSummary(rec: Omit<SavedSummaryRecord, 'createdAt'>): void {
    this.db
      .prepare(
        `INSERT INTO artifact_summaries
           (id, workspace_id, kind, connection_id, connection_b_id, type, api_name,
            content_hash, content_hash_b, summary, model, created_at)
         VALUES (?, 'default', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (kind, connection_id, connection_b_id, type, api_name) DO UPDATE SET
           content_hash = excluded.content_hash,
           content_hash_b = excluded.content_hash_b,
           summary = excluded.summary,
           model = excluded.model,
           created_at = excluded.created_at`,
      )
      .run(
        randomUUID(),
        rec.kind,
        rec.connectionId,
        rec.connectionBId ?? '',
        rec.type,
        rec.apiName,
        rec.contentHash,
        rec.contentHashB,
        rec.summary,
        rec.model,
        new Date().toISOString(),
      );
  }

  // ── MCP server toggles & custom servers (S8) ───────────────────────────
  // The v6 tables were forward declarations; this is their first wiring.
  // Toggle rows are strictly per-project: project_id is nullable in the DDL
  // but a NULL row would be dead weight under SQLite's NULL-distinct UNIQUE,
  // so writes require a project id and reads filter on it.

  getServerToggles(projectId: string): ServerToggleRecord[] {
    return (
      this.db
        .prepare(`SELECT server_key, enabled FROM mcp_server_toggles WHERE project_id = ?`)
        .all(projectId) as Array<{ server_key: string; enabled: number }>
    ).map((r) => ({ serverKey: r.server_key, enabled: r.enabled === 1 }));
  }

  setServerToggle(projectId: string, serverKey: string, enabled: boolean): void {
    if (!projectId) throw new Error('setServerToggle requires a project id.');
    if (!serverKey) throw new Error('setServerToggle requires a server key.');
    this.db
      .prepare(
        `INSERT INTO mcp_server_toggles (id, workspace_id, project_id, server_key, enabled)
         VALUES (?, 'default', ?, ?, ?)
         ON CONFLICT (project_id, server_key) DO UPDATE SET enabled = excluded.enabled`,
      )
      .run(randomUUID(), projectId, serverKey, enabled ? 1 : 0);
  }

  listCustomMcpServers(): CustomMcpServerRecord[] {
    return (
      this.db
        .prepare(
          `SELECT id, name, transport, url_or_command, auth_mode, config_json, enabled,
                  default_on, created_at
           FROM custom_mcp_servers ORDER BY created_at`,
        )
        .all() as Array<Record<string, unknown>>
    ).map((r) => this.customServerFromRow(r));
  }

  getCustomMcpServer(id: string): CustomMcpServerRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, name, transport, url_or_command, auth_mode, config_json, enabled,
                default_on, created_at
         FROM custom_mcp_servers WHERE id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.customServerFromRow(row) : null;
  }

  /**
   * v1 registers auth_mode 'independent' only — org_bound is design-doc
   * scope (docs/org-bound-contract.md), so this method cannot even express
   * it. The CHECK constraint stays as the schema-level seam.
   */
  addCustomMcpServer(input: {
    name: string;
    transport: 'stdio' | 'http' | 'sse';
    urlOrCommand: string;
    config?: CustomMcpServerExtras;
  }): CustomMcpServerRecord {
    if (!input.name.trim()) throw new Error('Server name is required.');
    if (!input.urlOrCommand.trim()) throw new Error('URL or command is required.');
    if (!['stdio', 'http', 'sse'].includes(input.transport)) {
      throw new Error(`Unknown transport "${input.transport}".`);
    }
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO custom_mcp_servers
           (id, workspace_id, name, transport, url_or_command, auth_mode, config_json, enabled, created_at)
         VALUES (?, 'default', ?, ?, ?, 'independent', ?, 1, ?)`,
      )
      .run(
        id,
        input.name.trim(),
        input.transport,
        input.urlOrCommand.trim(),
        JSON.stringify(input.config ?? {}),
        new Date().toISOString(),
      );
    const created = this.getCustomMcpServer(id);
    if (!created) throw new Error('custom MCP server insert did not persist');
    return created;
  }

  updateCustomMcpServer(
    id: string,
    patch: {
      name?: string;
      urlOrCommand?: string;
      enabled?: boolean;
      defaultOn?: boolean;
      config?: CustomMcpServerExtras;
    },
  ): CustomMcpServerRecord | null {
    const current = this.getCustomMcpServer(id);
    if (!current) return null;
    this.db
      .prepare(
        `UPDATE custom_mcp_servers SET name = ?, url_or_command = ?, enabled = ?, default_on = ?, config_json = ? WHERE id = ?`,
      )
      .run(
        patch.name?.trim() || current.name,
        patch.urlOrCommand?.trim() || current.urlOrCommand,
        (patch.enabled ?? current.enabled) ? 1 : 0,
        (patch.defaultOn ?? current.defaultOn) ? 1 : 0,
        JSON.stringify(patch.config ?? current.config),
        id,
      );
    return this.getCustomMcpServer(id);
  }

  /** Removes the server and every project's toggle rows for it. */
  removeCustomMcpServer(id: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM mcp_server_toggles WHERE server_key = ?`).run(`ext:${id}`);
      this.db.prepare(`DELETE FROM custom_mcp_servers WHERE id = ?`).run(id);
    });
    tx();
  }

  // ── Skill library (v13) ────────────────────────────────────────────────
  // Same discipline as the MCP toggles above: toggle writes require a
  // project id, reads filter on it. Bundled skills never touch these tables.

  getSkillToggles(projectId: string): SkillToggleRecord[] {
    return (
      this.db
        .prepare(`SELECT skill_key, enabled FROM skill_toggles WHERE project_id = ?`)
        .all(projectId) as Array<{ skill_key: string; enabled: number }>
    ).map((r) => ({ skillKey: r.skill_key, enabled: r.enabled === 1 }));
  }

  setSkillToggle(projectId: string, skillKey: string, enabled: boolean): void {
    if (!projectId) throw new Error('setSkillToggle requires a project id.');
    if (!skillKey) throw new Error('setSkillToggle requires a skill key.');
    this.db
      .prepare(
        `INSERT INTO skill_toggles (id, workspace_id, project_id, skill_key, enabled)
         VALUES (?, 'default', ?, ?, ?)
         ON CONFLICT (project_id, skill_key) DO UPDATE SET enabled = excluded.enabled`,
      )
      .run(randomUUID(), projectId, skillKey, enabled ? 1 : 0);
  }

  listCustomSkills(): CustomSkillRecord[] {
    return (
      this.db
        .prepare(
          `SELECT id, name, description, dir_name, default_on, created_at, updated_at
           FROM custom_skills ORDER BY name COLLATE NOCASE`,
        )
        .all() as Array<Record<string, unknown>>
    ).map((r) => this.customSkillFromRow(r));
  }

  getCustomSkill(id: string): CustomSkillRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, name, description, dir_name, default_on, created_at, updated_at
         FROM custom_skills WHERE id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.customSkillFromRow(row) : null;
  }

  addCustomSkill(input: { name: string; description: string; dirName: string }): CustomSkillRecord {
    if (!input.name.trim()) throw new Error('Skill name is required.');
    if (!input.description.trim()) throw new Error('Skill description is required.');
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO custom_skills (id, workspace_id, name, description, dir_name, default_on, created_at, updated_at)
         VALUES (?, 'default', ?, ?, ?, 0, ?, ?)`,
      )
      .run(id, input.name.trim(), input.description.trim(), input.dirName, now, now);
    const created = this.getCustomSkill(id);
    if (!created) throw new Error('custom skill insert did not persist');
    return created;
  }

  setCustomSkillDefaultOn(id: string, defaultOn: boolean): CustomSkillRecord | null {
    const current = this.getCustomSkill(id);
    if (!current) return null;
    this.db
      .prepare(`UPDATE custom_skills SET default_on = ?, updated_at = ? WHERE id = ?`)
      .run(defaultOn ? 1 : 0, new Date().toISOString(), id);
    return this.getCustomSkill(id);
  }

  /** Removes the skill and every project's toggle rows for it. */
  removeCustomSkill(id: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM skill_toggles WHERE skill_key = ?`).run(`ext:${id}`);
      this.db.prepare(`DELETE FROM custom_skills WHERE id = ?`).run(id);
    });
    tx();
  }

  private customSkillFromRow(r: Record<string, unknown>): CustomSkillRecord {
    return {
      id: r.id as string,
      name: r.name as string,
      description: r.description as string,
      dirName: r.dir_name as string,
      defaultOn: (r.default_on as number) === 1,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    };
  }

  private customServerFromRow(r: Record<string, unknown>): CustomMcpServerRecord {
    let config: CustomMcpServerExtras = {};
    try {
      const parsed: unknown = JSON.parse((r.config_json as string) ?? '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        config = parsed as CustomMcpServerExtras;
      }
    } catch {
      // unreadable config degrades to {} — the server just has no extras
    }
    return {
      id: r.id as string,
      name: r.name as string,
      transport: r.transport as CustomMcpServerRecord['transport'],
      urlOrCommand: r.url_or_command as string,
      authMode: r.auth_mode as CustomMcpServerRecord['authMode'],
      config,
      enabled: (r.enabled as number) === 1,
      defaultOn: (r.default_on as number) === 1,
      createdAt: r.created_at as string,
    };
  }

  // ── project docs & notes ───────────────────────────────────────────────

  private docFromRow(row: {
    id: string;
    project_id: string;
    filename: string;
    mime: string | null;
    size_bytes: number | null;
    added_at: string;
  }): ProjectDocRecord {
    return {
      id: row.id,
      projectId: row.project_id,
      filename: row.filename,
      mime: row.mime,
      sizeBytes: row.size_bytes,
      addedAt: row.added_at,
    };
  }

  listProjectDocs(projectId: string): ProjectDocRecord[] {
    return (
      this.db
        .prepare(
          `SELECT id, project_id, filename, mime, size_bytes, added_at
           FROM project_docs WHERE project_id = ? ORDER BY filename`,
        )
        .all(projectId) as Parameters<ContrailDb['docFromRow']>[0][]
    ).map((r) => this.docFromRow(r));
  }

  getProjectDoc(projectId: string, filename: string): ProjectDocRecord | null {
    // NOCASE: doc files live on case-insensitive filesystems (Windows/macOS) —
    // 'Notes.md' and 'notes.md' are one file on disk, so they must be one row.
    const row = this.db
      .prepare(
        `SELECT id, project_id, filename, mime, size_bytes, added_at
         FROM project_docs WHERE project_id = ? AND filename = ? COLLATE NOCASE`,
      )
      .get(projectId, filename) as Parameters<ContrailDb['docFromRow']>[0] | undefined;
    return row ? this.docFromRow(row) : null;
  }

  getProjectDocById(id: string): ProjectDocRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, project_id, filename, mime, size_bytes, added_at FROM project_docs WHERE id = ?`,
      )
      .get(id) as Parameters<ContrailDb['docFromRow']>[0] | undefined;
    return row ? this.docFromRow(row) : null;
  }

  /** Re-uploading the same filename (case-insensitive) replaces the row, like the disk does. */
  upsertProjectDoc(input: {
    projectId: string;
    filename: string;
    mime: string | null;
    sizeBytes: number | null;
  }): ProjectDocRecord {
    const tx = this.db.transaction((): ProjectDocRecord => {
      const existing = this.getProjectDoc(input.projectId, input.filename);
      const now = new Date().toISOString();
      if (existing) {
        this.db
          .prepare(
            `UPDATE project_docs SET filename = ?, mime = ?, size_bytes = ?, added_at = ? WHERE id = ?`,
          )
          .run(input.filename, input.mime, input.sizeBytes, now, existing.id);
        return {
          ...existing,
          filename: input.filename,
          mime: input.mime,
          sizeBytes: input.sizeBytes,
          addedAt: now,
        };
      }
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO project_docs (id, workspace_id, project_id, filename, mime, size_bytes, added_at)
           VALUES (?, 'default', ?, ?, ?, ?, ?)`,
        )
        .run(id, input.projectId, input.filename, input.mime, input.sizeBytes, now);
      return {
        id,
        projectId: input.projectId,
        filename: input.filename,
        mime: input.mime,
        sizeBytes: input.sizeBytes,
        addedAt: now,
      };
    });
    return tx();
  }

  removeProjectDoc(id: string): void {
    this.db.prepare(`DELETE FROM project_docs WHERE id = ?`).run(id);
  }

  listProjectNotes(projectId: string): ProjectNoteRecord[] {
    return (
      this.db
        .prepare(
          `SELECT id, project_id, session_id, author, body, created_at
           FROM project_notes WHERE project_id = ? ORDER BY created_at, rowid`,
        )
        .all(projectId) as Array<{
        id: string;
        project_id: string;
        session_id: string | null;
        author: 'user' | 'agent';
        body: string;
        created_at: string;
      }>
    ).map((r) => ({
      id: r.id,
      projectId: r.project_id,
      sessionId: r.session_id,
      author: r.author,
      body: r.body,
      createdAt: r.created_at,
    }));
  }

  addProjectNote(input: {
    projectId: string;
    sessionId?: string | null;
    author: 'user' | 'agent';
    body: string;
  }): ProjectNoteRecord {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO project_notes (id, workspace_id, project_id, session_id, author, body, created_at, updated_at)
         VALUES (?, 'default', ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.projectId, input.sessionId ?? null, input.author, input.body, now, now);
    return {
      id,
      projectId: input.projectId,
      sessionId: input.sessionId ?? null,
      author: input.author,
      body: input.body,
      createdAt: now,
    };
  }

  // ── agent session rows ─────────────────────────────────────────────────

  private sessionFromRow(row: {
    id: string;
    project_id: string;
    title: string | null;
    status: string;
    transcript_path: string | null;
    model: string | null;
    sdk_session_id: string | null;
    effort: string | null;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cost_usd: number;
    created_at: string;
    ended_at: string | null;
  }): AgentSessionRecord {
    return {
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      status: row.status,
      transcriptPath: row.transcript_path,
      model: row.model,
      sdkSessionId: row.sdk_session_id,
      effort: row.effort,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_tokens,
      costUsd: row.cost_usd,
      createdAt: row.created_at,
      endedAt: row.ended_at,
    };
  }

  private static readonly SESSION_COLS =
    'id, project_id, title, status, transcript_path, model, sdk_session_id, effort, input_tokens, output_tokens, cache_read_tokens, cost_usd, created_at, ended_at';

  createAgentSession(input: {
    projectId: string;
    title: string | null;
    model: string;
    effort?: string | null;
    transcriptPath?: string | null;
  }): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO sessions (id, workspace_id, project_id, title, status, model, effort, transcript_path, created_at)
         VALUES (?, 'default', ?, ?, 'active', ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.projectId,
        input.title,
        input.model,
        input.effort ?? null,
        input.transcriptPath ?? null,
        new Date().toISOString(),
      );
    return id;
  }

  setAgentSessionSdkId(id: string, sdkSessionId: string): void {
    this.db.prepare(`UPDATE sessions SET sdk_session_id = ? WHERE id = ?`).run(sdkSessionId, id);
  }

  /** Resume support: an ended session goes live again on the same row. */
  reopenAgentSession(id: string): void {
    this.db
      .prepare(`UPDATE sessions SET status = 'active', ended_at = NULL WHERE id = ?`)
      .run(id);
  }

  listAgentSessions(projectId: string): AgentSessionRecord[] {
    return (
      this.db
        .prepare(
          `SELECT ${ContrailDb.SESSION_COLS} FROM sessions WHERE project_id = ? ORDER BY created_at DESC`,
        )
        .all(projectId) as Parameters<ContrailDb['sessionFromRow']>[0][]
    ).map((r) => this.sessionFromRow(r));
  }

  getAgentSession(id: string): AgentSessionRecord | null {
    const row = this.db
      .prepare(`SELECT ${ContrailDb.SESSION_COLS} FROM sessions WHERE id = ?`)
      .get(id) as Parameters<ContrailDb['sessionFromRow']>[0] | undefined;
    return row ? this.sessionFromRow(row) : null;
  }

  setAgentSessionTitle(id: string, title: string): void {
    this.db.prepare(`UPDATE sessions SET title = ? WHERE id = ?`).run(title, id);
  }

  setAgentSessionTranscriptPath(id: string, transcriptPath: string): void {
    this.db.prepare(`UPDATE sessions SET transcript_path = ? WHERE id = ?`).run(transcriptPath, id);
  }

  /**
   * Remove a session row, returning what it was so the caller can delete the
   * files it owned (transcript, cwd). Returns null when the row is already
   * gone — deleting twice is not an error.
   */
  deleteAgentSession(id: string): AgentSessionRecord | null {
    const rec = this.getAgentSession(id);
    if (!rec) return null;
    this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
    return rec;
  }

  /**
   * Sessions where nothing was ever said: no title (set from the first user
   * message), no tokens, no cost. These are the residue of opening a chat and
   * walking away — they carry no history worth resuming and only clutter the
   * list, so the app discards rather than keeps them.
   *
   * A RENAMED session has a title and therefore survives, which is the right
   * call: naming something is a statement that you want it.
   */
  listEmptyAgentSessions(): AgentSessionRecord[] {
    return (
      this.db
        .prepare(
          `SELECT ${ContrailDb.SESSION_COLS} FROM sessions
           WHERE title IS NULL AND input_tokens = 0 AND output_tokens = 0 AND cost_usd = 0`,
        )
        .all() as Parameters<ContrailDb['sessionFromRow']>[0][]
    ).map((r) => this.sessionFromRow(r));
  }

  // ── app locks & snapshot runs (v6, desktop-owned) ──────────────────────

  /**
   * Advisory cross-process lease (e.g. 'snapshot:{connectionId}') so the
   * desktop and the plugin do not run the same long job concurrently against
   * the shared database. Best-effort: expired or self-held locks are taken
   * over; a live lock held by someone else refuses.
   */
  acquireAppLock(name: string, holder: string, ttlMs: number): boolean {
    const now = Date.now();
    const tx = this.db.transaction((): boolean => {
      const row = this.db
        .prepare(`SELECT holder, expires_at FROM app_locks WHERE name = ?`)
        .get(name) as { holder: string; expires_at: string } | undefined;
      if (row && row.holder !== holder && new Date(row.expires_at).getTime() > now) {
        return false;
      }
      this.db
        .prepare(
          `INSERT OR REPLACE INTO app_locks (name, holder, pid, acquired_at, expires_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          name,
          holder,
          process.pid,
          new Date(now).toISOString(),
          new Date(now + ttlMs).toISOString(),
        );
      return true;
    });
    return tx();
  }

  releaseAppLock(name: string, holder: string): void {
    this.db.prepare(`DELETE FROM app_locks WHERE name = ? AND holder = ?`).run(name, holder);
  }

  insertMetadataSnapshot(input: {
    connectionId: string;
    kind: 'baseline' | 'refresh';
    types: string[];
    artifactCount: number;
    durationMs?: number | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO metadata_snapshots (id, workspace_id, connection_id, taken_at, kind, types_json, artifact_count, duration_ms)
         VALUES (?, 'default', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.connectionId,
        new Date().toISOString(),
        input.kind,
        JSON.stringify(input.types),
        input.artifactCount,
        input.durationMs ?? null,
      );
  }

  /**
   * Snapshot posture for a connection: what the index holds now, and when the
   * last recorded run happened. artifact-table facts work even for snapshots
   * taken by the plugin (which never writes metadata_snapshots rows).
   */
  getSnapshotStatus(connectionId: string): {
    artifactCount: number;
    edgeCount: number;
    lastIndexedAt: string | null;
    lastRun: { takenAt: string; kind: string; artifactCount: number | null } | null;
    /** Median duration of the last three recorded runs — the "typically ~Xm" basis. */
    typicalDurationMs: number | null;
  } {
    const artifacts = this.db
      .prepare(
        `SELECT COUNT(*) AS n, MAX(retrieved_at) AS latest FROM artifacts WHERE connection_id = ?`,
      )
      .get(connectionId) as { n: number; latest: string | null };
    const edges = this.db
      .prepare(`SELECT COUNT(*) AS n FROM dependency_edges WHERE connection_id = ?`)
      .get(connectionId) as { n: number };
    const lastRun = this.db
      .prepare(
        `SELECT taken_at, kind, artifact_count FROM metadata_snapshots
         WHERE connection_id = ? ORDER BY taken_at DESC LIMIT 1`,
      )
      .get(connectionId) as
      | { taken_at: string; kind: string; artifact_count: number | null }
      | undefined;
    const durations = (
      this.db
        .prepare(
          `SELECT duration_ms FROM metadata_snapshots
           WHERE connection_id = ? AND duration_ms IS NOT NULL
           ORDER BY taken_at DESC LIMIT 3`,
        )
        .all(connectionId) as Array<{ duration_ms: number }>
    )
      .map((r) => r.duration_ms)
      .sort((a, b) => a - b);
    const typicalDurationMs =
      durations.length > 0 ? (durations[Math.floor(durations.length / 2)] ?? null) : null;
    return {
      artifactCount: artifacts.n,
      edgeCount: edges.n,
      lastIndexedAt: artifacts.latest,
      lastRun: lastRun
        ? { takenAt: lastRun.taken_at, kind: lastRun.kind, artifactCount: lastRun.artifact_count }
        : null,
      typicalDurationMs,
    };
  }

  /**
   * Startup reconciliation: no session can genuinely be active when the app
   * boots, so any 'active' row is the residue of a crash or force-kill.
   * Returns how many rows were closed.
   */
  reconcileOrphanedAgentSessions(): number {
    const result = this.db
      .prepare(`UPDATE sessions SET status = 'error', ended_at = ? WHERE status = 'active'`)
      .run(new Date().toISOString());
    return result.changes;
  }

  /** Live running totals, written after every completed turn. */
  updateAgentSessionUsage(
    id: string,
    usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number },
  ): void {
    this.db
      .prepare(
        `UPDATE sessions SET input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cost_usd = ? WHERE id = ?`,
      )
      .run(usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.costUsd, id);
  }

  finishAgentSession(
    id: string,
    usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number },
    status: 'ended' | 'error' = 'ended',
  ): void {
    this.db
      .prepare(
        `UPDATE sessions SET status = ?, input_tokens = ?, output_tokens = ?,
           cache_read_tokens = ?, cost_usd = ?, ended_at = ? WHERE id = ?`,
      )
      .run(
        status,
        usage.inputTokens,
        usage.outputTokens,
        usage.cacheReadTokens,
        usage.costUsd,
        new Date().toISOString(),
        id,
      );
  }

  // ── connections ────────────────────────────────────────────────────────

  insertConnection(input: {
    alias: string;
    instanceUrl: string;
    loginUrl: string;
    orgId: string;
    orgName: string | null;
    orgType: OrgType;
    isSandbox: boolean;
    username: string | null;
    userId: string | null;
    grants: GrantSet;
  }): ConnectionRecord {
    const now = new Date().toISOString();
    const rec: ConnectionRecord = {
      id: randomUUID(),
      workspaceId: 'default',
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
      ...input,
    };
    this.db
      .prepare(
        `INSERT INTO connections
           (id, workspace_id, alias, instance_url, login_url, org_id, org_name, org_type,
            is_sandbox, username, user_id, grants_json, created_at, updated_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.id,
        rec.workspaceId,
        rec.alias,
        rec.instanceUrl,
        rec.loginUrl,
        rec.orgId,
        rec.orgName,
        rec.orgType,
        rec.isSandbox ? 1 : 0,
        rec.username,
        rec.userId,
        JSON.stringify(rec.grants),
        rec.createdAt,
        rec.updatedAt,
        rec.lastUsedAt,
      );
    return rec;
  }

  /** Re-auth on an existing alias (e.g. after a sandbox refresh): new tokens/org identity, grants preserved unless changed on the page. */
  updateConnectionAuth(
    id: string,
    input: {
      instanceUrl: string;
      loginUrl: string;
      orgId: string;
      orgName: string | null;
      orgType: OrgType;
      isSandbox: boolean;
      username: string | null;
      userId: string | null;
      grants: GrantSet;
    },
  ): ConnectionRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE connections SET instance_url = ?, login_url = ?, org_id = ?, org_name = ?,
           org_type = ?, is_sandbox = ?, username = ?, user_id = ?, grants_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.instanceUrl,
        input.loginUrl,
        input.orgId,
        input.orgName,
        input.orgType,
        input.isSandbox ? 1 : 0,
        input.username,
        input.userId,
        JSON.stringify(input.grants),
        now,
        id,
      );
    const rec = this.getConnection(id);
    if (!rec) throw new Error(`connection ${id} vanished during update`);
    return rec;
  }

  updateGrants(id: string, grants: GrantSet): void {
    this.db
      .prepare(`UPDATE connections SET grants_json = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(grants), new Date().toISOString(), id);
  }

  /** A token refresh can reveal a migrated/renamed My Domain; keep the stored instance current. */
  updateInstanceUrl(id: string, instanceUrl: string): void {
    this.db
      .prepare(`UPDATE connections SET instance_url = ?, updated_at = ? WHERE id = ?`)
      .run(instanceUrl, new Date().toISOString(), id);
  }

  touchLastUsed(id: string): void {
    this.db
      .prepare(`UPDATE connections SET last_used_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), id);
  }

  deleteConnection(id: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM connections WHERE id = ?`).run(id);
      this.db.prepare(`DELETE FROM artifacts WHERE connection_id = ?`).run(id);
      this.db.prepare(`DELETE FROM dependency_edges WHERE connection_id = ?`).run(id);
      this.db.prepare(`DELETE FROM artifact_fts WHERE connection_id = ?`).run(id);
    });
    tx();
  }

  getConnection(id: string): ConnectionRecord | null {
    const row = this.db.prepare(`SELECT * FROM connections WHERE id = ?`).get(id);
    return row ? rowToConnection(row as ConnectionRow) : null;
  }

  getConnectionByAlias(alias: string): ConnectionRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM connections WHERE alias = ? COLLATE NOCASE`)
      .get(alias);
    return row ? rowToConnection(row as ConnectionRow) : null;
  }

  /** Resolve a user/agent-supplied reference: alias first, then id. */
  resolveConnection(ref: string): ConnectionRecord | null {
    return this.getConnectionByAlias(ref) ?? this.getConnection(ref);
  }

  listConnections(): ConnectionRecord[] {
    const rows = this.db.prepare(`SELECT * FROM connections ORDER BY alias`).all();
    return (rows as ConnectionRow[]).map(rowToConnection);
  }

  // ── artifacts / search / dependency graph ──────────────────────────────

  /**
   * Replace all artifacts of the given types for a connection in one
   * transaction (a snapshot refresh is authoritative for what it retrieved).
   * `content` feeds the FTS index only; artifact bodies live on disk.
   */
  replaceArtifactsForTypes(
    connectionId: string,
    types: string[],
    artifacts: Array<Omit<ArtifactRecord, 'id' | 'workspaceId'> & { content?: string }>,
  ): void {
    const del = this.db.prepare(
      `DELETE FROM artifacts WHERE connection_id = ? AND type = ?`,
    );
    const delFts = this.db.prepare(
      `DELETE FROM artifact_fts WHERE connection_id = ? AND type = ?`,
    );
    const ins = this.db.prepare(
      `INSERT INTO artifacts
         (id, workspace_id, connection_id, type, api_name, file_path, content_hash,
          last_modified_date, last_modified_by, retrieved_at)
       VALUES (?, 'default', ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insFts = this.db.prepare(
      `INSERT INTO artifact_fts (api_name, type, content, connection_id, artifact_id)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction(() => {
      for (const t of types) {
        del.run(connectionId, t);
        delFts.run(connectionId, t);
      }
      for (const a of artifacts) {
        const id = randomUUID();
        ins.run(
          id,
          connectionId,
          a.type,
          a.apiName,
          a.filePath,
          a.contentHash,
          a.lastModifiedDate,
          a.lastModifiedBy,
          a.retrievedAt,
        );
        insFts.run(a.apiName, a.type, a.content ?? '', connectionId, id);
      }
    });
    tx();
  }

  listArtifacts(connectionId: string, type?: string): ArtifactRecord[] {
    const rows = type
      ? this.db
          .prepare(
            `SELECT * FROM artifacts WHERE connection_id = ? AND type = ? ORDER BY api_name`,
          )
          .all(connectionId, type)
      : this.db
          .prepare(`SELECT * FROM artifacts WHERE connection_id = ? ORDER BY type, api_name`)
          .all(connectionId);
    return (rows as ArtifactRow[]).map(rowToArtifact);
  }

  getArtifact(connectionId: string, type: string, apiName: string): ArtifactRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM artifacts WHERE connection_id = ? AND type = ? AND api_name = ? COLLATE NOCASE`,
      )
      .get(connectionId, type, apiName);
    return row ? rowToArtifact(row as ArtifactRow) : null;
  }

  countArtifactsByType(connectionId: string): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT type, COUNT(*) AS n FROM artifacts WHERE connection_id = ? GROUP BY type ORDER BY type`,
      )
      .all(connectionId) as Array<{ type: string; n: number }>;
    return Object.fromEntries(rows.map((r) => [r.type, r.n]));
  }

  /** Name (LIKE) matches ranked first, then FTS content matches with snippets. */
  searchArtifacts(
    connectionId: string,
    query: string,
    types: string[] | undefined,
    limit: number,
  ): Array<{ type: string; apiName: string; match: 'name' | 'content'; snippet: string | null }> {
    const results: Array<{
      type: string;
      apiName: string;
      match: 'name' | 'content';
      snippet: string | null;
    }> = [];
    const seen = new Set<string>();
    const typeFilter = types?.length ? ` AND type IN (${types.map(() => '?').join(',')})` : '';

    const likeQ = `%${query.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
    const nameRows = this.db
      .prepare(
        `SELECT type, api_name FROM artifacts
         WHERE connection_id = ? AND api_name LIKE ? ESCAPE '\\'${typeFilter}
         ORDER BY length(api_name) LIMIT ?`,
      )
      .all(connectionId, likeQ, ...(types?.length ? types : []), limit) as Array<{
      type: string;
      api_name: string;
    }>;
    for (const r of nameRows) {
      seen.add(`${r.type}:${r.api_name}`);
      results.push({ type: r.type, apiName: r.api_name, match: 'name', snippet: null });
    }

    const ftsQuery = buildFtsQuery(query);
    if (ftsQuery && results.length < limit) {
      let ftsRows: Array<{ type: string; api_name: string; snip: string }> = [];
      try {
        ftsRows = this.db
          .prepare(
            `SELECT type, api_name, snippet(artifact_fts, 2, '»', '«', ' … ', 12) AS snip
             FROM artifact_fts
             WHERE artifact_fts MATCH ? AND connection_id = ?${typeFilter}
             LIMIT ?`,
          )
          .all(
            ftsQuery,
            connectionId,
            ...(types?.length ? types : []),
            limit,
          ) as typeof ftsRows;
      } catch {
        // An FTS syntax edge case despite sanitization — name results still stand.
      }
      for (const r of ftsRows) {
        if (seen.has(`${r.type}:${r.api_name}`)) continue;
        results.push({ type: r.type, apiName: r.api_name, match: 'content', snippet: r.snip });
        if (results.length >= limit) break;
      }
    }
    return results.slice(0, limit);
  }

  /**
   * Replace edges from one source whose from_type is in the refreshed set —
   * a refresh is authoritative only for the types it actually re-read, so
   * edges originating from untouched types survive partial refreshes.
   */
  replaceEdges(
    connectionId: string,
    source: 'org' | 'extractor',
    fromTypes: string[],
    edges: DependencyEdge[],
  ): void {
    const del = this.db.prepare(
      `DELETE FROM dependency_edges WHERE connection_id = ? AND source = ? AND from_type = ?`,
    );
    const ins = this.db.prepare(
      `INSERT OR IGNORE INTO dependency_edges
         (id, workspace_id, connection_id, from_type, from_name, to_type, to_name, source)
       VALUES (?, 'default', ?, ?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction(() => {
      for (const t of fromTypes) del.run(connectionId, source, t);
      for (const e of edges) {
        ins.run(randomUUID(), connectionId, e.fromType, e.fromName, e.toType, e.toName, source);
      }
    });
    tx();
  }

  edgesFrom(connectionId: string, type: string, name: string): DependencyEdge[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM dependency_edges
         WHERE connection_id = ? AND from_type = ? AND from_name = ? COLLATE NOCASE`,
      )
      .all(connectionId, type, name);
    return (rows as EdgeRow[]).map(rowToEdge);
  }

  edgesTo(connectionId: string, type: string, name: string): DependencyEdge[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM dependency_edges
         WHERE connection_id = ? AND to_type = ? AND to_name = ? COLLATE NOCASE`,
      )
      .all(connectionId, type, name);
    return (rows as EdgeRow[]).map(rowToEdge);
  }

  // ── deploy / dml requests (write-safety two-step, spec §5) ─────────────

  insertDeployRequest(input: {
    connectionId: string;
    kind: DeployRequestKind;
    confirmationCode: string;
    expiresAt: string;
    payloadPath?: string | null;
    payloadJson?: string | null;
    summaryJson: string;
    validationId?: string | null;
  }): DeployRequestRecord {
    const rec: DeployRequestRecord = {
      id: randomUUID(),
      workspaceId: 'default',
      connectionId: input.connectionId,
      kind: input.kind,
      confirmationCode: input.confirmationCode,
      status: 'validated',
      createdAt: new Date().toISOString(),
      expiresAt: input.expiresAt,
      executedAt: null,
      payloadPath: input.payloadPath ?? null,
      payloadJson: input.payloadJson ?? null,
      summaryJson: input.summaryJson,
      validationId: input.validationId ?? null,
      resultJson: null,
      sessionId: null,
      sourceConnectionId: null,
      approvedAt: null,
      approvedComment: null,
      desktopState: null,
      origin: null,
      reviewJson: null,
    };
    this.db
      .prepare(
        `INSERT INTO deploy_requests
           (id, workspace_id, connection_id, kind, confirmation_code, status, created_at,
            expires_at, executed_at, payload_path, payload_json, summary_json, validation_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.id,
        rec.workspaceId,
        rec.connectionId,
        rec.kind,
        rec.confirmationCode,
        rec.status,
        rec.createdAt,
        rec.expiresAt,
        rec.executedAt,
        rec.payloadPath,
        rec.payloadJson,
        rec.summaryJson,
        rec.validationId,
      );
    return rec;
  }

  /** A new validation on the same target invalidates every earlier pending code (spec §5). */
  supersedePendingRequests(connectionId: string, kind: DeployRequestKind): number {
    const result = this.db
      .prepare(
        `UPDATE deploy_requests SET status = 'superseded'
         WHERE connection_id = ? AND kind = ? AND status = 'validated'`,
      )
      .run(connectionId, kind);
    return result.changes;
  }

  /** Lookup by code regardless of status; the caller branches on request.status. */
  findRequestByCode(
    connectionId: string,
    kind: DeployRequestKind,
    code: string,
  ): DeployRequestRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM deploy_requests
         WHERE connection_id = ? AND kind = ? AND confirmation_code = ? COLLATE NOCASE
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(connectionId, kind, code.trim());
    return row ? rowToDeployRequest(row as DeployRequestRow) : null;
  }

  /** Single request by id — the Deploy Review screen's loader. */
  getDeployRequest(id: string): DeployRequestRecord | null {
    const row = this.db.prepare(`SELECT * FROM deploy_requests WHERE id = ?`).get(id) as
      | DeployRequestRow
      | undefined;
    return row ? rowToDeployRequest(row) : null;
  }

  /** Newest-first request list for the Deploys screen. */
  listDeployRequests(opts?: { connectionId?: string; limit?: number }): DeployRequestRecord[] {
    const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
    const rows = (
      opts?.connectionId
        ? this.db
            .prepare(
              `SELECT * FROM deploy_requests WHERE connection_id = ? ORDER BY created_at DESC LIMIT ?`,
            )
            .all(opts.connectionId, limit)
        : this.db
            .prepare(`SELECT * FROM deploy_requests ORDER BY created_at DESC LIMIT ?`)
            .all(limit)
    ) as DeployRequestRow[];
    return rows.map(rowToDeployRequest);
  }

  /** Presenter-time stamps: who asked, from where, and the code-free review model. */
  setDeployRequestDesktopFields(
    id: string,
    fields: {
      sessionId?: string | null;
      origin?: string;
      desktopState?: string;
      reviewJson?: string;
    },
  ): void {
    const current = this.getDeployRequest(id);
    if (!current) return;
    this.db
      .prepare(
        `UPDATE deploy_requests SET session_id = ?, origin = ?, desktop_state = ?, review_json = ? WHERE id = ?`,
      )
      .run(
        fields.sessionId !== undefined ? fields.sessionId : current.sessionId,
        fields.origin ?? current.origin,
        fields.desktopState ?? current.desktopState,
        fields.reviewJson ?? current.reviewJson,
        id,
      );
  }

  /**
   * The human decision. Approval only marks the row — execution still goes
   * through claimRequestForExecution, so the single-use guarantee is intact.
   */
  recordDeployDecision(id: string, decision: 'approved' | 'rejected', comment: string | null): void {
    this.db
      .prepare(
        `UPDATE deploy_requests SET desktop_state = ?, approved_at = ?, approved_comment = ? WHERE id = ?`,
      )
      .run(decision, new Date().toISOString(), comment, id);
  }

  /**
   * Atomically claim a validated request for execution. Returns true only for
   * the single caller that flips 'validated'→'executing'; concurrent callers
   * and re-runs get false. This is the single-use guarantee (spec §5) — the
   * code is spent BEFORE the write dispatches, so a failed or duplicated
   * execute can never re-drive it.
   */
  claimRequestForExecution(id: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE deploy_requests SET status = 'executing' WHERE id = ? AND status = 'validated'`,
      )
      .run(id);
    return result.changes === 1;
  }

  finishDeployRequest(
    id: string,
    status: 'executed' | 'execution_failed',
    resultJson: string,
  ): void {
    this.db
      .prepare(
        `UPDATE deploy_requests SET status = ?, executed_at = ?, result_json = ? WHERE id = ?`,
      )
      .run(status, new Date().toISOString(), resultJson, id);
  }

  getDeployRequestStatus(id: string): string | null {
    const row = this.db
      .prepare(`SELECT status FROM deploy_requests WHERE id = ?`)
      .get(id) as { status: string } | undefined;
    return row?.status ?? null;
  }

  setDeployRequestPayloadPath(id: string, payloadPath: string): void {
    this.db
      .prepare(`UPDATE deploy_requests SET payload_path = ? WHERE id = ?`)
      .run(payloadPath, id);
  }

  updateDeployRequestStatus(
    id: string,
    status: 'executed' | 'executing' | 'expired' | 'superseded' | 'execution_failed' | 'locked',
  ): void {
    this.db
      .prepare(`UPDATE deploy_requests SET status = ?, executed_at = ? WHERE id = ?`)
      .run(status, status === 'executed' ? new Date().toISOString() : null, id);
  }

  /**
   * Record a wrong-code guess against the pending validated request for this
   * connection+kind (brute-force guard). Increments its counter; once the
   * threshold is reached the request is locked so even the correct code can no
   * longer execute it — the human must re-validate. Returns what happened so
   * the caller can shape the refusal message and audit.
   */
  registerFailedAttempt(
    connectionId: string,
    kind: DeployRequestKind,
    maxAttempts: number,
  ): { pendingExisted: boolean; locked: boolean; attemptsRemaining: number; requestId?: string; payloadPath?: string | null } {
    const row = this.db
      .prepare(
        `SELECT id, failed_attempts, payload_path FROM deploy_requests
         WHERE connection_id = ? AND kind = ? AND status = 'validated'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(connectionId, kind) as
      | { id: string; failed_attempts: number; payload_path: string | null }
      | undefined;
    if (!row) return { pendingExisted: false, locked: false, attemptsRemaining: 0 };

    const attempts = row.failed_attempts + 1;
    if (attempts >= maxAttempts) {
      this.db
        .prepare(`UPDATE deploy_requests SET status = 'locked', failed_attempts = ? WHERE id = ?`)
        .run(attempts, row.id);
      return {
        pendingExisted: true,
        locked: true,
        attemptsRemaining: 0,
        requestId: row.id,
        payloadPath: row.payload_path,
      };
    }
    this.db
      .prepare(`UPDATE deploy_requests SET failed_attempts = ? WHERE id = ?`)
      .run(attempts, row.id);
    return {
      pendingExisted: true,
      locked: false,
      attemptsRemaining: maxAttempts - attempts,
      requestId: row.id,
    };
  }

  /** Payload zips of superseded requests, so the caller can delete them. */
  takeSupersededPayloadPaths(connectionId: string, kind: DeployRequestKind): string[] {
    const rows = this.db
      .prepare(
        `SELECT payload_path FROM deploy_requests
         WHERE connection_id = ? AND kind = ? AND status = 'superseded' AND payload_path IS NOT NULL`,
      )
      .all(connectionId, kind) as Array<{ payload_path: string }>;
    return rows.map((r) => r.payload_path);
  }

  // ── audit ──────────────────────────────────────────────────────────────

  insertAuditEvent(input: {
    eventType: string;
    connectionId?: string | null;
    tool?: string | null;
    outcome: 'success' | 'refused' | 'error';
    detail?: Record<string, unknown> | null;
  }): AuditEvent {
    const evt: AuditEvent = {
      id: randomUUID(),
      workspaceId: 'default',
      ts: new Date().toISOString(),
      eventType: input.eventType,
      connectionId: input.connectionId ?? null,
      tool: input.tool ?? null,
      outcome: input.outcome,
      detail: input.detail ?? null,
    };
    this.db
      .prepare(
        `INSERT INTO audit_events (id, workspace_id, ts, event_type, connection_id, tool, outcome, detail_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        evt.id,
        evt.workspaceId,
        evt.ts,
        evt.eventType,
        evt.connectionId,
        evt.tool,
        evt.outcome,
        evt.detail ? JSON.stringify(evt.detail) : null,
      );
    return evt;
  }

  queryAuditEvents(filter: {
    connectionId?: string;
    since?: string;
    limit?: number;
  }): AuditEvent[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.connectionId) {
      clauses.push('connection_id = ?');
      params.push(filter.connectionId);
    }
    if (filter.since) {
      clauses.push('ts >= ?');
      params.push(filter.since);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 1000);
    const rows = this.db
      .prepare(`SELECT * FROM audit_events ${where} ORDER BY ts DESC LIMIT ?`)
      .all(...params, limit);
    return (rows as AuditRow[]).map(rowToAudit);
  }

  close(): void {
    this.db.close();
  }
}

interface ConnectionRow {
  id: string;
  workspace_id: string;
  alias: string;
  instance_url: string;
  login_url: string;
  org_id: string;
  org_name: string | null;
  org_type: string;
  is_sandbox: number;
  username: string | null;
  user_id: string | null;
  grants_json: string;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

interface AuditRow {
  id: string;
  workspace_id: string;
  ts: string;
  event_type: string;
  connection_id: string | null;
  tool: string | null;
  outcome: string;
  detail_json: string | null;
}

function rowToConnection(row: ConnectionRow): ConnectionRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    alias: row.alias,
    instanceUrl: row.instance_url,
    loginUrl: row.login_url,
    orgId: row.org_id,
    orgName: row.org_name,
    orgType: row.org_type as OrgType,
    isSandbox: row.is_sandbox === 1,
    username: row.username,
    userId: row.user_id,
    grants: normalizeGrants(safeParse(row.grants_json)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
  };
}

function rowToAudit(row: AuditRow): AuditEvent {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    ts: row.ts,
    eventType: row.event_type,
    connectionId: row.connection_id,
    tool: row.tool,
    outcome: row.outcome as AuditEvent['outcome'],
    detail: row.detail_json ? (safeParse(row.detail_json) as Record<string, unknown>) : null,
  };
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

interface ArtifactRow {
  id: string;
  workspace_id: string;
  connection_id: string;
  type: string;
  api_name: string;
  file_path: string | null;
  content_hash: string | null;
  last_modified_date: string | null;
  last_modified_by: string | null;
  retrieved_at: string;
}

function rowToArtifact(row: ArtifactRow): ArtifactRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    connectionId: row.connection_id,
    type: row.type,
    apiName: row.api_name,
    filePath: row.file_path,
    contentHash: row.content_hash,
    lastModifiedDate: row.last_modified_date,
    lastModifiedBy: row.last_modified_by,
    retrievedAt: row.retrieved_at,
  };
}

interface EdgeRow {
  connection_id: string;
  from_type: string;
  from_name: string;
  to_type: string;
  to_name: string;
  source: string;
}

function rowToEdge(row: EdgeRow): DependencyEdge {
  return {
    connectionId: row.connection_id,
    fromType: row.from_type,
    fromName: row.from_name,
    toType: row.to_type,
    toName: row.to_name,
    source: row.source as DependencyEdge['source'],
  };
}

interface DeployRequestRow {
  id: string;
  workspace_id: string;
  connection_id: string;
  kind: string;
  confirmation_code: string;
  status: string;
  created_at: string;
  expires_at: string;
  executed_at: string | null;
  payload_path: string | null;
  payload_json: string | null;
  summary_json: string;
  validation_id: string | null;
  result_json: string | null;
  session_id?: string | null;
  source_connection_id?: string | null;
  approved_at?: string | null;
  approved_comment?: string | null;
  desktop_state?: string | null;
  origin?: string | null;
  review_json?: string | null;
}

function rowToDeployRequest(row: DeployRequestRow): DeployRequestRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    connectionId: row.connection_id,
    kind: row.kind as DeployRequestRecord['kind'],
    confirmationCode: row.confirmation_code,
    status: row.status as DeployRequestRecord['status'],
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    executedAt: row.executed_at,
    payloadPath: row.payload_path,
    payloadJson: row.payload_json,
    summaryJson: row.summary_json,
    validationId: row.validation_id,
    resultJson: row.result_json,
    sessionId: row.session_id ?? null,
    sourceConnectionId: row.source_connection_id ?? null,
    approvedAt: row.approved_at ?? null,
    approvedComment: row.approved_comment ?? null,
    desktopState: row.desktop_state ?? null,
    origin: row.origin ?? null,
    reviewJson: row.review_json ?? null,
  };
}

/** Sanitize a user query into FTS5 MATCH syntax: quoted prefix tokens, AND-joined. */
function buildFtsQuery(query: string): string | null {
  const tokens = query
    .split(/\s+/)
    .map((t) => t.replaceAll('"', '').trim())
    .filter((t) => t.length > 1);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"*`).join(' ');
}
