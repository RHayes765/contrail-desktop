import type { GrantSet } from '@contrail/engine';

/** One org binding visible to a session, with its connection's grants. */
export interface BindingWithGrants {
  connectionId: string;
  alias: string;
  orgName: string | null;
  orgType: string;
  envRole: 'dev' | 'qa' | 'uat' | 'prod' | 'other';
  grants: GrantSet;
}

/**
 * An external (auth_mode: independent) MCP server resolved for this session.
 * Main resolves per-project enablement before any of this crosses the bridge;
 * headers/env may carry user-provided auth material, so these specs must never
 * appear in events, transcripts, or views — they live in the child's SDK
 * options only.
 */
export interface ExternalMcpServerSpec {
  /** Sanitized server key — becomes the mcp__{key}__* tool namespace. */
  key: string;
  transport: 'stdio' | 'http' | 'sse';
  /** stdio: the command; http/sse: the URL. */
  urlOrCommand: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

/** Everything a session needs, assembled by main. The ONLY credential here is the BYO API key. */
export interface SessionContext {
  sessionId: string;
  project: {
    id: string;
    name: string;
    description: string | null;
    /** Per-project custom instructions — injected verbatim into the system prompt. */
    instructions: string | null;
  };
  bindings: BindingWithGrants[];
  model: string;
  /** Reasoning effort; models without effort support silently ignore it. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxTurns: number;
  maxBudgetUsd: number;
  /**
   * Per-session working directory (never the user's real folders). STABLE
   * across runs of the same session — the SDK keys its persisted history by
   * cwd, so resume only finds the conversation if the cwd matches.
   */
  cwd: string;
  /**
   * The Contrail-owned CLAUDE_CONFIG_DIR. The SDK persists session history
   * here (that is what makes resume possible); the user's real ~/.claude is
   * never read or written.
   */
  claudeConfigDir: string;
  /** Set on resume: the SDK session id whose history this run continues. */
  resumeSdkSessionId?: string;
  /** BYO Anthropic API key — lives in the runtime env only, never in views or transcripts. */
  apiKey: string;
  /**
   * Catalog families toggled OFF for this project. Minting is the UX layer;
   * the main-side executor re-checks the toggle per call against live DB
   * state, same two-layer posture as grants.
   */
  disabledCatalogKeys?: string[];
  /** External MCP servers enabled for this project (see ExternalMcpServerSpec). */
  externalServers?: ExternalMcpServerSpec[];
}

/** Events the runtime streams back to main (and main forwards to the renderer). */
export type AgentEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'text'; text: string }
  | { type: 'tool_start'; toolUseId: string; name: string; input: unknown }
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
  /** The SDK announced its session id (init) — main stores it as the resume handle. */
  | { type: 'sdk_session'; sdkSessionId: string };

// ── bridge protocol (utilityProcess parentPort messages) ─────────────────

/** main → child */
export type ToChild =
  | { kind: 'init'; ctx: SessionContext }
  | { kind: 'send'; text: string }
  | { kind: 'capability:result'; id: number; result: BridgeToolResult }
  | { kind: 'interrupt' }
  /**
   * Graceful teardown: close the input stream so the live query (and its CLI
   * subprocess) exits on its own, then reply 'closed'. Main must wait for
   * 'closed' (with a timeout fallback) before killing this process — killing
   * a utilityProcess does NOT reap the SDK's claude.exe grandchild on
   * Windows, so an abrupt kill would orphan it.
   */
  | { kind: 'shutdown' };

/** child → main */
export type ToMain =
  | { kind: 'ready' }
  | { kind: 'capability:invoke'; id: number; name: string; args: unknown }
  | { kind: 'event'; event: AgentEvent }
  /** The live query has fully ended (input closed or fatal error); safe to kill this process. */
  | { kind: 'closed' };

/** Matches the engine's ToolResult shape (content parts + isError). */
export interface BridgeToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}
