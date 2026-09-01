/**
 * Renderer-facing view models. Token-free by construction: nothing in this
 * file may ever carry OAuth material, confirmation codes, or session-bearing
 * URLs — the renderer is a human surface, but views also flow through logs
 * and diagnostics.
 */

export type OrgType = 'production' | 'sandbox' | 'developer' | 'scratch' | string;

export type EnvRole = 'dev' | 'qa' | 'uat' | 'prod' | 'other';

/** Reasoning-effort levels (mirrors the Agent SDK; models without effort support ignore it). */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** The chat model catalog: id → display label + per-session budget cap. */
export const CHAT_MODELS = {
  'claude-haiku-4-5': { label: 'Haiku 4.5', maxBudgetUsd: 0.5 },
  'claude-sonnet-5': { label: 'Sonnet 5', maxBudgetUsd: 2 },
  'claude-opus-5': { label: 'Opus 5', maxBudgetUsd: 5 },
  'claude-fable-5': { label: 'Fable 5', maxBudgetUsd: 5 },
} as const;

export type ChatModelId = keyof typeof CHAT_MODELS;

export interface GrantSetView {
  metadata_read: boolean;
  metadata_write: boolean;
  diagnostics_read: boolean;
  data_read: boolean;
  data_write: boolean;
}

export interface ConnectionView {
  id: string;
  alias: string;
  orgId: string;
  orgName: string | null;
  orgType: OrgType;
  isSandbox: boolean;
  instanceUrl: string;
  username: string | null;
  grants: GrantSetView;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

export interface HealthView {
  ok: boolean;
  appVersion: string;
  /** Newest released version when it exceeds appVersion (cached daily check); absent otherwise. */
  latestVersion?: string;
  dataDir: string;
  /** The database file the engine ACTUALLY opened (better-sqlite3 db.name). */
  dbFile: string;
  /** Is an Anthropic API key stored? Presence only — the key never crosses IPC. */
  apiKeyPresent: boolean;
  schemaVersion: number;
  nativeModules: {
    betterSqlite3: { ok: boolean; detail: string };
    keyring: { ok: boolean; detail: string };
  };
  connectionCount: number;
}

// ── connect flow ─────────────────────────────────────────────────────────

/**
 * Outcome of starting an in-app OAuth connect. Deliberately message-only:
 * the authorize URL never reaches the renderer — main opens the system
 * browser itself.
 */
export interface ConnectOutcomeView {
  status: 'connected' | 'pending' | 'timeout' | 'superseded' | 'error';
  message: string;
  connection: ConnectionView | null;
}

export interface PingResultView {
  status: 'ok' | 'expired' | 'unreachable';
  detail: string | null;
}

// ── projects (context silos) ─────────────────────────────────────────────

export interface BindingView {
  connectionId: string;
  alias: string;
  orgName: string | null;
  orgType: OrgType;
  envRole: EnvRole;
  grants: GrantSetView;
}

export interface ProjectView {
  id: string;
  name: string;
  description: string | null;
  instructions: string | null;
  createdAt: string;
  updatedAt: string;
  bindings: BindingView[];
}

export interface ProjectDocView {
  id: string;
  filename: string;
  mime: string | null;
  sizeBytes: number | null;
  addedAt: string;
}

export interface ProjectNoteView {
  id: string;
  sessionId: string | null;
  author: 'user' | 'agent';
  body: string;
  createdAt: string;
}

/** A linked local folder — a live view of the user's own files, never a copy. */
export interface ProjectFolderView {
  id: string;
  /** Folder basename — the handle sessions use to name files inside it. */
  name: string;
  /** Absolute path of the linked folder. */
  path: string;
  addedAt: string;
}

// ── metadata snapshots ───────────────────────────────────────────────────

export interface SnapshotStatusView {
  connectionId: string;
  artifactCount: number;
  edgeCount: number;
  /** Newest indexed artifact's retrieval time — null when never synced. */
  lastIndexedAt: string | null;
  /** A sync is running right now (this app instance). */
  syncing: boolean;
  /** Live progress line while syncing. */
  progress: string | null;
  /** Milliseconds since this sync started (present only while syncing). */
  syncElapsedMs: number | null;
  /** Median duration of recent syncs — "typically ~Xm"; null before the first. */
  typicalDurationMs: number | null;
  /** Synced, but past the freshness threshold. */
  stale: boolean;
}

// ── metadata browsing ────────────────────────────────────────────────────

export interface MetadataTypeCountView {
  type: string;
  count: number;
}

export interface ArtifactRowView {
  type: string;
  apiName: string;
  lastModifiedDate: string | null;
  lastModifiedBy: string | null;
}

export interface DependencyRefView {
  type: string;
  name: string;
}

/**
 * A stored AI summary. `stale` means the thing it describes has changed since
 * it was written — the summary is still shown (it is usually still mostly
 * right), but labelled, because silently showing a stale explanation of code
 * is worse than showing none.
 */
export interface SavedSummaryView {
  summary: string;
  createdAt: string;
  model: string | null;
  stale: boolean;
}

export interface ArtifactDetailView {
  type: string;
  apiName: string;
  /** Source from the local snapshot (XML or Apex); null when not on disk. */
  content: string | null;
  lastModifiedDate: string | null;
  lastModifiedBy: string | null;
  /** What this artifact references. */
  uses: DependencyRefView[];
  /** What references this artifact. */
  usedBy: DependencyRefView[];
  usesTruncated: boolean;
  usedByTruncated: boolean;
  /** Parsed permissions — present only for PermissionSet artifacts. */
  permissionSet: unknown | null;
  /** Parsed node/edge graph — present only for Flow artifacts. */
  flowGraph: FlowGraphView | null;
  /** A previously generated summary, if one was saved. Survives restarts. */
  savedSummary: SavedSummaryView | null;
}

/** Structural mirror of the engine's parsed flow graph (shared stays engine-free). */
export interface FlowGraphView {
  label: string | null;
  processType: string | null;
  status: string | null;
  trigger: string | null;
  nodes: Array<{
    name: string;
    label: string;
    kind: string;
    detail: string | null;
    props: Array<{ name: string; value: string }>;
    xml: string;
  }>;
  edges: Array<{ from: string; to: string; kind: string; label: string | null }>;
  unresolved: string[];
}

/** Structural mirror of the engine's parsed PermissionSet (shared stays engine-free). */
export interface PermissionSetView {
  label: string | null;
  license: string | null;
  description: string | null;
  objectPermissions: Array<{
    object: string;
    read: boolean;
    create: boolean;
    edit: boolean;
    delete: boolean;
    viewAll: boolean;
    modifyAll: boolean;
  }>;
  fieldPermissions: Array<{ field: string; readable: boolean; editable: boolean }>;
  userPermissions: Array<{ name: string; enabled: boolean }>;
  classAccesses: Array<{ name: string; enabled: boolean }>;
  pageAccesses: Array<{ name: string; enabled: boolean }>;
  tabSettings: Array<{ tab: string; visibility: string }>;
  recordTypeVisibilities: Array<{ name: string; enabled: boolean }>;
  applicationVisibilities: Array<{ name: string; enabled: boolean }>;
}

// ── cross-org diff ───────────────────────────────────────────────────────

export interface DiffEntryView {
  type: string;
  apiName: string;
  /** added = only in B; removed = only in A; changed = in both, different. */
  status: 'added' | 'removed' | 'changed';
  changeCount: number;
  unreadable: boolean;
}

export interface DiffScopeView {
  connectionA: string;
  connectionB: string;
  aliasA: string;
  aliasB: string;
  computedAt: string;
  /** True when served from cache (snapshots unchanged since last compute). */
  cached: boolean;
  totals: { added: number; removed: number; changed: number; unchanged: number };
  entries: DiffEntryView[];
  /** Entry list cap applied (totals remain exact). */
  truncated: boolean;
  /**
   * Types one org's snapshot simply does not cover — WITHOUT this, a
   * partial snapshot reads as thousands of fabricated deletions. Entries
   * for these types are omitted rather than lied about.
   */
  uncoveredTypes: Array<{ type: string; missingIn: 'A' | 'B'; countInOther: number }>;
}

/** Structural mirror of the engine's semantic diff (shared stays engine-free). */
export type SemanticChangeView =
  | { kind: 'scalar'; path: string; a: unknown; b: unknown }
  | { kind: 'added'; path: string; key: string }
  | { kind: 'removed'; path: string; key: string }
  | { kind: 'unkeyed'; path: string; note: string };

export interface TextHunkView {
  a_line: number;
  b_line: number;
  removed: string[];
  added: string[];
  removed_truncated?: boolean;
  added_truncated?: boolean;
}

export interface ArtifactDiffView {
  type: string;
  apiName: string;
  aliasA: string;
  aliasB: string;
  /**
   * INDEX presence — 'a-only'/'b-only' assert real org absence, never a
   * read failure (those set the unreadable flags instead).
   */
  presence: 'both' | 'a-only' | 'b-only';
  /** Indexed on that side, but its snapshot file could not be read. */
  unreadableA: boolean;
  unreadableB: boolean;
  identical: boolean;
  format: 'xml' | 'text' | null;
  /** XML semantic changes (present when format is xml and both sides exist). */
  changes: SemanticChangeView[] | null;
  changesTruncated: boolean;
  /** Text hunks (present when format is text and both sides exist). */
  hunks: TextHunkView[] | null;
  hunksTruncated: boolean;
  /** Text diff too large for hunk extraction — line counts only. */
  countsOnly: boolean;
  linesAdded: number;
  linesRemoved: number;
  contentA: string | null;
  contentB: string | null;
  /** Parsed flow graphs — present for Flow artifacts (per readable side). */
  flowGraphA: FlowGraphView | null;
  flowGraphB: FlowGraphView | null;
  /** Node-level flow comparison for diagram highlighting (both sides present). */
  flowNodeChanges: { changed: string[]; addedInB: string[]; removedInB: string[] } | null;
  /** A previously generated diff summary for this org pair, if one was saved. */
  savedSummary: SavedSummaryView | null;
}

// ── agent sessions ───────────────────────────────────────────────────────

export interface SessionView {
  id: string;
  projectId: string;
  title: string | null;
  status: 'active' | 'ended' | 'error' | string;
  model: string | null;
  effort: EffortLevel | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  createdAt: string;
  endedAt: string | null;
}

/**
 * One line of a persisted session transcript, shaped for read-only replay.
 * Parsed main-side from the session's JSONL file (which is already
 * redaction-scrubbed at write time — nothing here can carry codes/tokens).
 */
export type TranscriptEntryView =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool_start'; toolUseId: string; name: string; input: string }
  | { kind: 'tool_end'; toolUseId: string; ok: boolean }
  | { kind: 'error'; message: string };

export interface TranscriptView {
  session: SessionView;
  entries: TranscriptEntryView[];
  /** True when the transcript was cut off at the parse cap (very long sessions). */
  truncated: boolean;
  /** Set when no transcript file exists (pre-transcript rows, cleaned disk). */
  missing: boolean;
}

/**
 * One streamed chat event, forwarded from the agent runtime. `tool_start` is
 * annotated by main with the resolved target connection + env role so the
 * renderer can color tool cards without ever resolving connections itself.
 */
export type ChatEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'text'; text: string }
  | {
      type: 'tool_start';
      toolUseId: string;
      name: string;
      input: unknown;
      connection: string | null;
      envRole: EnvRole | null;
    }
  | { type: 'tool_end'; toolUseId: string; ok: boolean }
  | {
      type: 'usage';
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      costUsd: number;
    }
  | { type: 'error'; message: string }
  | { type: 'done'; result: string | null }
  /** External MCP server OAuth: browser opened / auth completed / declined. */
  | {
      type: 'external_auth';
      server: string;
      status: 'browser_opened' | 'completed' | 'declined';
    }
  /** A write awaits the human's decision in Deploy Review. Never carries a code. */
  | {
      type: 'approval_required';
      requestId: string;
      kind: 'deploy' | 'dml' | 'apex' | 'bulk';
      connection: string;
      orgType: string;
    }
  /** The human decided; the agent's held call resolved with the outcome. */
  | {
      type: 'approval_resolved';
      requestId: string;
      outcome: 'executed' | 'execution_failed' | 'rejected' | 'timeout';
    }
  /** Connection state of external MCP servers (surfaced so failures are never silent). */
  | {
      type: 'mcp_status';
      servers: Array<{
        name: string;
        status: string;
        error: string | null;
        toolCount: number;
      }>;
    }
  /**
   * Synthesized by main when the session is over for good (budget/turn cap
   * tripped, fatal error, runtime died) — the renderer must stop treating it
   * as live. Never emitted for a user-initiated end (the user already knows).
   */
  | { type: 'session_ended'; reason: string };

// ── MCP catalog, toggles & external servers (S8) ─────────────────────────

/** One standard capability family with its per-project effective state. */
export interface CatalogFamilyView {
  key: string;
  label: string;
  description: string;
  capabilities: string[];
  enabled: boolean;
}

/** An external server as seen from one project's toggle panel. */
export interface ExternalServerProjectView {
  id: string;
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  /** Registered AND switched on globally — a project toggle only matters then. */
  globallyEnabled: boolean;
  enabledForProject: boolean;
}

export interface ProjectMcpView {
  families: CatalogFamilyView[];
  externalServers: ExternalServerProjectView[];
}

/** One skill in the universal library (S18). */
export interface SkillView {
  /** Toggle key: bundled = the skill name, custom = 'ext:<id>'. */
  key: string;
  name: string;
  description: string;
  source: 'bundled' | 'custom';
  /** Joins projects with no explicit toggle row. Bundled skills are always true. */
  defaultOn: boolean;
  /** Custom skills only; null for bundled (they cannot be removed). */
  id: string | null;
}

/** The per-project skill selection panel. */
export interface ProjectSkillsView {
  projectId: string;
  skills: Array<{
    key: string;
    name: string;
    description: string;
    source: 'bundled' | 'custom';
    enabled: boolean;
  }>;
}

/**
 * Registry view of a custom MCP server. Header and env VALUES are auth
 * material and never leave the main process — views carry names only.
 */
export interface CustomMcpServerView {
  id: string;
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  urlOrCommand: string;
  args: string[];
  headerNames: string[];
  envNames: string[];
  /** A user-supplied OAuth client is configured (values never leave main). */
  hasOauthClient: boolean;
  /** Scopes the provider GRANTED at the last consent — null when no token/unknown. */
  authorizedScopes: string[] | null;
  enabled: boolean;
  /** Joins projects with no explicit toggle row (per-connector project default). */
  defaultOn: boolean;
  createdAt: string;
}

/**
 * One org limit as Salesforce reports it. `used` is derived (max - remaining)
 * because that is the number a human thinks in.
 */
export interface OrgLimitView {
  key: string;
  label: string;
  max: number;
  remaining: number;
  used: number;
}

/** On-demand org limits snapshot for one connection (costs one API call). */
export interface OrgLimitsView {
  connectionId: string;
  alias: string;
  fetchedAt: string;
  limits: OrgLimitView[];
}

/**
 * The fixed loopback redirect for user-supplied OAuth clients — providers
 * that refuse dynamic registration require the exact URI in their app
 * config, so it must be stable and documented.
 */
export const OAUTH_LOOPBACK_REDIRECT = 'http://127.0.0.1:33418/callback';

export interface ConnectorPresetView {
  kind: 'slack' | 'jira' | 'gmail' | 'gdrive' | 'gcalendar';
  label: string;
  transport: 'http' | 'sse';
  /** Official endpoint where one exists; the form stays editable. */
  urlSuggestion: string | null;
  note: string;
}

/**
 * Presets prefill the custom-server form with the vendors' OFFICIAL remote
 * MCP endpoints. v1 external auth is header-based (paste a token); browser
 * OAuth flows are not supported, and each note says honestly whether the
 * endpoint works that way. Google is one preset per product — mirroring how
 * Claude's own connectors split Gmail / Drive / Calendar.
 */
export const CONNECTOR_PRESETS: ConnectorPresetView[] = [
  {
    kind: 'slack',
    label: 'Slack',
    transport: 'http',
    urlSuggestion: 'https://mcp.slack.com/mcp',
    note: 'Slack’s official remote MCP server — verified working recipe: create a Slack app (api.slack.com/apps); OAuth & Permissions → opt into PKCE, add the redirect URL shown in “OAuth client…”, add USER Token Scopes (the server advertises its list); enable “Slack Model Context Protocol (MCP) Server” under the app’s Agents section; INSTALL the app to your workspace; then paste client ID + secret here and Authorize.',
  },
  {
    kind: 'jira',
    label: 'Jira (Atlassian)',
    transport: 'http',
    urlSuggestion: 'https://mcp.atlassian.com/v1/mcp',
    note: 'Atlassian Rovo MCP Server. Just click Authorize — Atlassian supports automatic registration, so the browser login is the whole setup. API-token headers work too (Basic base64(email:api_token)).',
  },
  {
    kind: 'gmail',
    label: 'Gmail',
    transport: 'http',
    urlSuggestion: 'https://gmailmcp.googleapis.com/mcp/v1',
    note: 'Google’s official Gmail MCP server. In the Google Cloud project that owns your OAuth client, enable BOTH the “Gmail API” and the “Gmail MCP API” (gmailmcp.googleapis.com) — the second one is the step everyone misses and causes 403s after login. Consent screen: add the gmail.readonly and gmail.compose scopes and yourself as a test user. Then paste the client ID + secret under “OAuth client…” and Authorize.',
  },
  {
    kind: 'gdrive',
    label: 'Google Drive',
    transport: 'http',
    urlSuggestion: 'https://drivemcp.googleapis.com/mcp/v1',
    note: 'Google’s official Drive MCP server. Enable BOTH the “Google Drive API” and the “Drive MCP API” (drivemcp.googleapis.com) on your OAuth client’s project — the MCP API is the step everyone misses. Add Drive scopes + yourself as a test user on the consent screen, paste the client ID + secret under “OAuth client…”, then Authorize.',
  },
  {
    kind: 'gcalendar',
    label: 'Google Calendar',
    transport: 'http',
    urlSuggestion: 'https://calendarmcp.googleapis.com/mcp/v1',
    note: 'Google’s official Calendar MCP server. Enable BOTH the “Google Calendar API” and the “Calendar MCP API” (calendarmcp.googleapis.com) on your OAuth client’s project — the MCP API is the step everyone misses. Add Calendar scopes + yourself as a test user on the consent screen, paste the client ID + secret under “OAuth client…”, then Authorize.',
  },
];

/** Result of a registration-time MCP connection test (mcp:servers:test). */
export interface McpServerTestView {
  status: 'connected' | 'needs_auth' | 'failed';
  detail: string | null;
  tools: string[];
}

// ── deploys & native approval (S9) ───────────────────────────────────────

/** One component in a deploy, structured (from the validation summary). */
export interface DeployChangeView {
  type: string;
  apiName: string;
  change: 'add' | 'modify' | 'unchanged_content' | 'delete';
  warnings: string[];
  /**
   * Where the source came from, when it was read from a file rather than
   * typed as a tool argument. The approver did not author these bytes, so the
   * review has to name the file and fingerprint it.
   */
  sourcePath?: string;
  sourceSha256?: string;
}

/**
 * A deploy/DML request as the Deploy Review screen sees it. CODE-FREE BY
 * CONSTRUCTION: the confirmation code never appears in any view — approval
 * happens by renderer decision, and main alone reads the code from the row.
 */
export interface DeployRequestView {
  id: string;
  kind: 'deploy' | 'dml' | 'apex' | 'bulk';
  connectionId: string;
  alias: string;
  orgName: string | null;
  orgType: string;
  instanceUrl: string;
  /** Legacy engine state machine (shared with the v5 plugin). */
  status:
    | 'validated'
    | 'executing'
    | 'executed'
    | 'expired'
    | 'superseded'
    | 'execution_failed'
    | 'locked';
  /** Native-approval lifecycle: awaiting_approval | approved | rejected | null (plugin rows). */
  desktopState: string | null;
  origin: string | null;
  sessionId: string | null;
  createdAt: string;
  expiresAt: string;
  executedAt: string | null;
  approvedAt: string | null;
  approvedComment: string | null;
  /** Structured components (parsed from the stored validation summary). */
  changes: DeployChangeView[];
  destructive: DeployChangeView[];
  /** Flattened display rows from the approval view (DML previews use these). */
  changeRows: Array<{ label: string; warnings: string[]; detail?: string }>;
  destructiveRows: Array<{ label: string; warnings: string[]; detail?: string }>;
  /** Validation/test result lines (label/value, bad = red). */
  results: Array<{ label: string; value: string; bad?: boolean }>;
  blast: string[];
  warnings: string[];
  /** Human summary of the terminal outcome; null while pending. */
  resultSummary: string | null;
}

/**
 * API-key status for the Settings screen. Presence and problems only — the
 * key itself is never returned to the renderer, by construction.
 */
export interface ApiKeyStatusView {
  present: boolean;
  /** Set when the credential store itself failed (locked / policy-blocked). */
  storeError: string | null;
  /** Masked hint for recognition, e.g. "sk-ant-…7f2a". Null when absent. */
  hint: string | null;
}

/**
 * The result of a LIVE check against Anthropic — the onboarding safety net so
 * a teammate learns a bad key immediately, not at their first session.
 * `ok` = Anthropic accepted the key. `reachable` distinguishes "rejected" from
 * "couldn't even ask" (offline/blocked), which are very different fixes.
 */
export interface ApiKeyValidationView {
  ok: boolean;
  reachable: boolean;
  /** HTTP status Anthropic returned, when we got that far. */
  status: number | null;
  /** Human-readable outcome — never contains the key. */
  message: string;
}

/** Rolling-window AI spend against the user's daily cap. */
export interface BudgetStatusView {
  capUsd: number;
  spentUsd: number;
  remainingUsd: number;
  byKind: Array<{ kind: string; usd: number; calls: number }>;
  windowHours: number;
}
