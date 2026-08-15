import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
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
  // everything downstream accumulates, so emit per-turn deltas.
  let lastCostUsd = 0;
  try {
    for await (const msg of q) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        // The resume handle: main stores it on the session row.
        const sid = (msg as { session_id?: string }).session_id;
        if (sid) emit({ type: 'sdk_session', sdkSessionId: sid });
        continue;
      }
      if (msg.type === 'stream_event') {
        const ev = (msg as { event?: { type?: string; delta?: { type?: string; text?: string } } })
          .event;
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
          emit({ type: 'text_delta', text: ev.delta.text });
        }
      } else if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'text' && block.text) {
            emit({ type: 'text', text: block.text });
          } else if (block.type === 'tool_use') {
            emit({ type: 'tool_start', toolUseId: block.id, name: block.name, input: block.input });
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
              });
            }
          }
        }
      } else if (msg.type === 'result') {
        // One 'result' per completed turn-set in streaming-input mode.
        // Token counts are per-turn; cost is cumulative (delta'd here).
        const usage = msg.usage;
        const totalCost = (msg as { total_cost_usd?: number }).total_cost_usd ?? 0;
        const costDelta = Math.max(0, totalCost - lastCostUsd);
        lastCostUsd = Math.max(lastCostUsd, totalCost);
        emit({
          type: 'usage',
          inputTokens: usage?.input_tokens ?? 0,
          outputTokens: usage?.output_tokens ?? 0,
          cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
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

function startSession(sessionCtx: SessionContext): void {
  const options = buildSessionOptions(sessionCtx, invokeViaBridge);
  options.includePartialMessages = true;
  // The query starts now and idles until the first user message arrives —
  // the CLI handshake is local, so an untouched session costs nothing.
  live = query({ prompt: input, options });
  void pumpEvents(live);
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
