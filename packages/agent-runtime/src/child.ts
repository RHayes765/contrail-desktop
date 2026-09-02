import {
  query,
  type ElicitationRequest,
  type ElicitationResult,
  type Query,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentEvent,
  BridgeToolResult,
  SessionContext,
  ToChild,
  ToMain,
} from './types.js';
import { buildSessionOptions } from './options.js';

/**
 * Utility-process entry point. Protocol with main (over parentPort):
 *   main → 'init' {ctx}    → start ONE live streaming-input query, reply 'ready'
 *   main → 'send' {text}   → push a user message into the live query;
 *                            events stream back, 'done' marks the turn's end
 *   main → 'capability:result' → resolves a pending tool invocation
 *   main → 'interrupt'     → soft-stop the in-flight turn (session survives)
 *   main → 'shutdown'      → close the input stream; the query (and the SDK's
 *                            CLI subprocess) winds down, then we reply 'closed'
 *
 * One query lives for the whole session — that is what makes this a chat:
 * conversation history and the prompt cache belong to the query, so every
 * turn after the first rides the cached prefix.
 *
 * This process holds exactly one credential: the BYO API key (in the child
 * env for the SDK subprocess). No Salesforce tokens, no DB, no keychain —
 * every capability executes in main via the bridge.
 */

interface ParentPort {
  on(event: 'message', listener: (e: { data: ToChild }) => void): void;
  postMessage(message: ToMain): void;
}

const parentPort = (process as unknown as { parentPort: ParentPort }).parentPort;

function send(message: ToMain): void {
  parentPort.postMessage(message);
}

function emit(event: AgentEvent): void {
  send({ kind: 'event', event });
}

// ── capability bridge ────────────────────────────────────────────────────

let nextInvokeId = 1;
const pendingInvokes = new Map<number, (result: BridgeToolResult) => void>();

/** Capability calls hop to main and await the result. */
function invokeViaBridge(name: string, args: unknown): Promise<BridgeToolResult> {
  return new Promise((resolve) => {
    const id = nextInvokeId++;
    pendingInvokes.set(id, resolve);
    send({ kind: 'capability:invoke', id, name, args });
  });
}

// ── MCP elicitation bridge (external-server OAuth) ───────────────────────

let nextElicitationId = 1;
const pendingElicitations = new Map<number, (accept: boolean) => void>();

/**
 * url-mode only: main validates the URL and opens the system browser; this
 * process never opens anything. Per the SDK contract, accept is returned
 * immediately after the browser opens — the CLI detects auth completion
 * itself and emits an elicitation_complete system message. form-mode is
 * declined outright (no v1 surface for arbitrary structured input).
 */
async function handleElicitation(request: ElicitationRequest): Promise<ElicitationResult | null> {
  if (request.mode !== 'url' || !request.url) return null;
  const accepted = await new Promise<boolean>((resolve) => {
    const id = nextElicitationId++;
    pendingElicitations.set(id, resolve);
    send({
      kind: 'elicitation',
      id,
      serverName: request.serverName,
      message: request.message,
      url: request.url as string,
    });
  });
  return accepted ? ({ action: 'accept' } as ElicitationResult) : null;
}

// ── the session's input stream ───────────────────────────────────────────

/** Minimal async queue: push user messages in, the SDK iterates them out. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly items: SDKUserMessage[] = [];
  private waiter: ((next: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  push(msg: SDKUserMessage): void {
    if (this.closed) return;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: msg, done: false });
    } else {
      this.items.push(msg);
    }
  }

  close(): void {
    this.closed = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        if (this.items.length > 0) {
          return Promise.resolve({ value: this.items.shift() as SDKUserMessage, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
    };
  }
}

function userMessage(text: string): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
  };
}

// ── session lifecycle ────────────────────────────────────────────────────

let ctx: SessionContext | null = null;
let live: Query | null = null;
const input = new InputQueue();
let closedSent = false;

function sendClosed(): void {
  if (closedSent) return;
  closedSent = true;
  send({ kind: 'closed' });
}

async function pumpEvents(q: Query): Promise<void> {
  // The SDK's total_cost_usd is CUMULATIVE across the streaming session;
  // everything downstream accumulates, so emit per-turn deltas. modelUsage
  // (the S28 token source — it covers subagents; msg.usage is main-loop-only)
  // is cumulative too, so its sums are delta'd the same way.
  let lastCostUsd = 0;
  let lastTok = { input: 0, output: 0, cache: 0 };
  try {
    for await (const msg of q) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        // The resume handle: main stores it on the session row.
        const sid = (msg as { session_id?: string }).session_id;
        if (sid) emit({ type: 'sdk_session', sdkSessionId: sid });
        continue;
      }
      if (msg.type === 'system' && (msg as { subtype?: string }).subtype === 'elicitation_complete') {
        emit({
          type: 'external_auth',
          server: (msg as { mcp_server_name?: string }).mcp_server_name ?? 'unknown',
          status: 'completed',
        });
        // Auth just landed — report the post-auth connection state.
        setTimeout(() => void reportMcpStatus(q, false), 1_500);
        continue;
      }
      // S28: events originating in a SUBAGENT's turn carry the spawning Agent
      // tool_use id — tagged so the renderer badges nested work instead of
      // presenting it as the main agent's.
      const parentToolUseId =
        (msg as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? undefined;
      if (msg.type === 'stream_event') {
        const ev = (msg as { event?: { type?: string; delta?: { type?: string; text?: string } } })
          .event;
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
          emit({ type: 'text_delta', text: ev.delta.text, ...(parentToolUseId ? { parentToolUseId } : {}) });
        }
      } else if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'text' && block.text) {
            emit({ type: 'text', text: block.text, ...(parentToolUseId ? { parentToolUseId } : {}) });
          } else if (block.type === 'tool_use') {
            const subagentType =
              block.name === 'Agent' || block.name === 'Task'
                ? String(
                    (block.input as { subagent_type?: unknown } | null)?.subagent_type ?? '',
                  ) || undefined
                : undefined;
            emit({
              type: 'tool_start',
              toolUseId: block.id,
              name: block.name,
              input: block.input,
              ...(parentToolUseId ? { parentToolUseId } : {}),
              ...(subagentType ? { subagentType } : {}),
            });
          }
        }
      } else if (msg.type === 'user') {
        const content = msg.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result') {
              emit({
                type: 'tool_end',
                toolUseId: block.tool_use_id,
                ok: block.is_error !== true,
                ...(parentToolUseId ? { parentToolUseId } : {}),
              });
            }
          }
        }
      } else if (msg.type === 'result') {
        // One 'result' per completed turn-set in streaming-input mode.
        // Cost is cumulative (delta'd). Tokens: prefer modelUsage — it covers
        // the whole query pipeline (Task subagents included) where msg.usage
        // is documented MAIN-AGENT-LOOP-ONLY — summed across models and
        // delta'd because it too is cumulative across turns.
        const usage = msg.usage;
        const totalCost = (msg as { total_cost_usd?: number }).total_cost_usd ?? 0;
        const costDelta = Math.max(0, totalCost - lastCostUsd);
        lastCostUsd = Math.max(lastCostUsd, totalCost);
        const mu = (
          msg as {
            modelUsage?: Record<
              string,
              { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number }
            >;
          }
        ).modelUsage;
        let inTok: number;
        let outTok: number;
        let cacheTok: number;
        if (mu && Object.keys(mu).length > 0) {
          const sum = Object.values(mu).reduce(
            (a, m) => ({
              input: a.input + (m.inputTokens ?? 0),
              output: a.output + (m.outputTokens ?? 0),
              cache: a.cache + (m.cacheReadInputTokens ?? 0),
            }),
            { input: 0, output: 0, cache: 0 },
          );
          inTok = Math.max(0, sum.input - lastTok.input);
          outTok = Math.max(0, sum.output - lastTok.output);
          cacheTok = Math.max(0, sum.cache - lastTok.cache);
          lastTok = {
            input: Math.max(sum.input, lastTok.input),
            output: Math.max(sum.output, lastTok.output),
            cache: Math.max(sum.cache, lastTok.cache),
          };
        } else {
          inTok = usage?.input_tokens ?? 0;
          outTok = usage?.output_tokens ?? 0;
          cacheTok = usage?.cache_read_input_tokens ?? 0;
        }
        emit({
          type: 'usage',
          inputTokens: inTok,
          outputTokens: outTok,
          cacheReadTokens: cacheTok,
          costUsd: costDelta,
        });
        if (msg.subtype === 'success' && !msg.is_error) {
          emit({ type: 'done', result: msg.result });
        } else {
          emit({
            type: 'error',
            message: String(
              (msg as { errors?: unknown }).errors ??
                (msg as { result?: unknown }).result ??
                msg.subtype,
            ).slice(0, 1000),
          });
          emit({ type: 'done', result: null });
        }
      }
    }
  } catch (err) {
    emit({ type: 'error', message: String(err).slice(0, 1000) });
    emit({ type: 'done', result: null });
  } finally {
    live = null;
    sendClosed();
  }
}

/** Servers we already forced a connection attempt for (one nudge each). */
const nudgedServers = new Set<string>();

/**
 * Surface external-server state and, once per needs-auth server, force a
 * reconnect — the connection attempt is what raises the url-mode OAuth
 * elicitation. Without this a needs-auth server just sits there silently.
 */
async function reportMcpStatus(q: Query, nudge: boolean): Promise<void> {
  try {
    const statuses = await q.mcpServerStatus();
    const external = statuses.filter((s) => s.name !== 'contrail');
    if (external.length === 0) return;
    emit({
      type: 'mcp_status',
      servers: external.map((s) => ({
        name: s.name,
        status: s.status,
        error: s.error ?? null,
        toolCount: s.tools?.length ?? 0,
      })),
    });
    if (!nudge) return;
    for (const s of external) {
      if (s.status === 'needs-auth' && !nudgedServers.has(s.name)) {
        nudgedServers.add(s.name);
        void q
          .reconnectMcpServer(s.name)
          .then(() => reportMcpStatus(q, false))
          .catch(() => {
            /* the elicitation path itself reports failures */
          });
      }
    }
  } catch {
    /* status unavailable — query winding down */
  }
}

function startSession(sessionCtx: SessionContext): void {
  const options = buildSessionOptions(sessionCtx, invokeViaBridge, handleElicitation);
  options.includePartialMessages = true;
  // The query starts now and idles until the first user message arrives —
  // the CLI handshake is local, so an untouched session costs nothing.
  live = query({ prompt: input, options });
  void pumpEvents(live);
  if ((sessionCtx.externalServers ?? []).length > 0) {
    const q = live;
    // First check after the alwaysLoad connect window; second after the
    // nudge/elicitation had time to move things.
    setTimeout(() => void reportMcpStatus(q, true), 3_000);
    setTimeout(() => void reportMcpStatus(q, false), 15_000);
  }
}

parentPort.on('message', (e) => {
  const msg = e.data;
  switch (msg.kind) {
    case 'init':
      ctx = msg.ctx;
      startSession(msg.ctx);
      send({ kind: 'ready' });
      break;
    case 'send':
      if (!ctx || !live) {
        emit({ type: 'error', message: 'runtime received send before init (or after shutdown)' });
        emit({ type: 'done', result: null });
        break;
      }
      input.push(userMessage(msg.text));
      break;
    case 'capability:result': {
      const resolve = pendingInvokes.get(msg.id);
      if (resolve) {
        pendingInvokes.delete(msg.id);
        resolve(msg.result);
      }
      break;
    }
    case 'elicitation:result': {
      const resolve = pendingElicitations.get(msg.id);
      if (resolve) {
        pendingElicitations.delete(msg.id);
        resolve(msg.accept);
      }
      break;
    }
    case 'interrupt':
      // Soft-stop the current turn; the session and its history survive.
      void live?.interrupt().catch(() => {
        /* interrupting an idle query is a no-op */
      });
      break;
    case 'shutdown':
      // Soft-stop any in-flight turn AND close the input — a turn can run far
      // longer than main's shutdown grace, and an abrupt kill after the grace
      // would orphan the CLI subprocess (the exact thing this handshake exists
      // to prevent).
      void live?.interrupt().catch(() => {
        /* idle query — nothing to interrupt */
      });
      input.close();
      if (!live) sendClosed();
      break;
  }
});
