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
  maxTurns: number;
  maxBudgetUsd: number;
  /** Per-session scratch working directory (never the user's real folders). */
  cwd: string;
  /** BYO Anthropic API key — lives in the runtime env only, never in views or transcripts. */
  apiKey: string;
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
  | { type: 'done'; result: string | null };

// ── bridge protocol (utilityProcess parentPort messages) ─────────────────

/** main → child */
export type ToChild =
  | { kind: 'init'; ctx: SessionContext }
  | { kind: 'send'; text: string }
  | { kind: 'capability:result'; id: number; result: BridgeToolResult }
  | { kind: 'interrupt' };

/** child → main */
export type ToMain =
  | { kind: 'ready' }
  | { kind: 'capability:invoke'; id: number; name: string; args: unknown }
  | { kind: 'event'; event: AgentEvent };

/** Matches the engine's ToolResult shape (content parts + isError). */
export interface BridgeToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}
