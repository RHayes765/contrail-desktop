import { query } from '@anthropic-ai/claude-agent-sdk';
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
 *   main → 'init' {ctx}    → build options, wait for 'send'
 *   main → 'send' {text}   → run one query turn-set, streaming 'event's back
 *   main → 'capability:result' → resolves a pending tool invocation
 *   main → 'interrupt'     → abort the in-flight query
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

let ctx: SessionContext | null = null;
let abort: AbortController | null = null;
let nextInvokeId = 1;
const pendingInvokes = new Map<number, (result: BridgeToolResult) => void>();

function send(message: ToMain): void {
  parentPort.postMessage(message);
}

function emit(event: AgentEvent): void {
  send({ kind: 'event', event });
}

/** Capability calls hop to main and await the result. */
function invokeViaBridge(name: string, args: unknown): Promise<BridgeToolResult> {
  return new Promise((resolve) => {
    const id = nextInvokeId++;
    pendingInvokes.set(id, resolve);
    send({ kind: 'capability:invoke', id, name, args });
  });
}

async function runTurn(text: string): Promise<void> {
  if (!ctx) {
    emit({ type: 'error', message: 'runtime received send before init' });
    return;
  }
  abort = new AbortController();
  const options = buildSessionOptions(ctx, invokeViaBridge);
  options.abortController = abort;
  options.includePartialMessages = true;

  try {
    for await (const msg of query({ prompt: text, options })) {
      if (msg.type === 'stream_event') {
        const ev = (msg as { event?: { type?: string; delta?: { type?: string; text?: string } } }).event;
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
        const usage = msg.usage;
        emit({
          type: 'usage',
          inputTokens: usage?.input_tokens ?? 0,
          outputTokens: usage?.output_tokens ?? 0,
          cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
          costUsd: (msg as { total_cost_usd?: number }).total_cost_usd ?? 0,
        });
        if (msg.subtype === 'success' && !msg.is_error) {
          emit({ type: 'done', result: msg.result });
        } else {
          emit({
            type: 'error',
            message: String(
              (msg as { errors?: unknown }).errors ?? (msg as { result?: unknown }).result ?? msg.subtype,
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
    abort = null;
  }
}

parentPort.on('message', (e) => {
  const msg = e.data;
  switch (msg.kind) {
    case 'init':
      ctx = msg.ctx;
      send({ kind: 'ready' });
      break;
    case 'send':
      void runTurn(msg.text);
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
      abort?.abort();
      break;
  }
});
