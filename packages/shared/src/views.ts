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
  dataDir: string;
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
  enabled: boolean;
  createdAt: string;
}

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
    note: 'Slack’s official remote MCP server. OAuth-native — v1 supports header tokens only, so this needs a token your org can issue for header auth; browser OAuth is not supported yet.',
  },
  {
    kind: 'jira',
    label: 'Jira (Atlassian)',
    transport: 'http',
    urlSuggestion: 'https://mcp.atlassian.com/v1/mcp',
    note: 'Atlassian Rovo MCP Server — works with v1 header auth if your org admin enables API tokens: Authorization=Basic base64(email:api_token), or Authorization=Bearer <service-account key>.',
  },
  {
    kind: 'gmail',
    label: 'Gmail',
    transport: 'http',
    urlSuggestion: 'https://gmailmcp.googleapis.com/mcp/v1',
    note: 'Google’s official Gmail MCP server. OAuth 2.0 only per Google’s docs — not usable with v1 header auth until Contrail supports OAuth flows.',
  },
  {
    kind: 'gdrive',
    label: 'Google Drive',
    transport: 'http',
    urlSuggestion: 'https://drivemcp.googleapis.com/mcp/v1',
    note: 'Google’s official Drive MCP server. OAuth 2.0 only per Google’s docs — not usable with v1 header auth until Contrail supports OAuth flows.',
  },
  {
    kind: 'gcalendar',
    label: 'Google Calendar',
    transport: 'http',
    urlSuggestion: 'https://calendarmcp.googleapis.com/mcp/v1',
    note: 'Google’s official Calendar MCP server. OAuth 2.0 only per Google’s docs — not usable with v1 header auth until Contrail supports OAuth flows.',
  },
];

/** Result of a registration-time MCP connection test (mcp:servers:test). */
export interface McpServerTestView {
  status: 'connected' | 'needs_auth' | 'failed';
  detail: string | null;
  tools: string[];
}
