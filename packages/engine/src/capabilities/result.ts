import { ContrailError } from '../core/errors.js';
import { log } from '../core/log.js';

/** Result shape shared with the Phase 0 MCP tool layer (content parts + isError). */
export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

export function ok(payload: unknown, prefix?: string): ToolResult {
  const json = JSON.stringify(payload, null, 2);
  return { content: [{ type: 'text', text: prefix ? `${prefix}\n${json}` : json }] };
}

export function fail(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function guarded(handler: () => Promise<ToolResult> | ToolResult): Promise<ToolResult> {
  return Promise.resolve()
    .then(handler)
    .catch((err) => {
      if (err instanceof ContrailError) return fail(err.message);
      log('error', 'capability handler failed', { err: String(err) });
      return fail(`Unexpected engine error: ${String(err)}`);
    });
}
