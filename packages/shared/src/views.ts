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
