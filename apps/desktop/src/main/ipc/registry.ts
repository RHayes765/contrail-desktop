import { ipcMain, type WebContents } from 'electron';
import type { z } from 'zod';
import {
  REQUEST_SCHEMAS,
  type Channel,
  type Contracts,
  type PushChannel,
  type PushEvents,
} from '@contrail/shared';
import type { EngineDeps } from '@contrail/engine';

/**
 * The typed IPC registry. Every invoke channel is validated against its zod
 * schema from @contrail/shared BEFORE the handler runs — a renderer payload
 * that doesn't parse never reaches engine code. Handlers receive the engine
 * deps; anything they return must already be a renderer-safe view (no tokens,
 * no confirmation codes, no session-bearing URLs).
 */

type Handler<C extends Channel> = (
  deps: EngineDeps,
  req: Contracts[C]['req'],
) => Promise<Contracts[C]['res']> | Contracts[C]['res'];

export function registerHandlers(
  deps: EngineDeps,
  handlers: { [C in Channel]: Handler<C> },
): void {
  for (const channel of Object.keys(REQUEST_SCHEMAS) as Channel[]) {
    const schema = REQUEST_SCHEMAS[channel] as z.ZodTypeAny;
    const handler = handlers[channel] as Handler<Channel>;
    ipcMain.handle(channel, async (_event, rawReq: unknown) => {
      const parsed = schema.safeParse(rawReq ?? {});
      if (!parsed.success) {
        throw new Error(`Invalid request for ${channel}: ${parsed.error.message}`);
      }
      return handler(deps, parsed.data as Contracts[Channel]['req']);
    });
  }
}

/** Typed push to one renderer. */
export function push<C extends PushChannel>(
  target: WebContents,
  channel: C,
  payload: PushEvents[C],
): void {
  target.send(channel, payload);
}
