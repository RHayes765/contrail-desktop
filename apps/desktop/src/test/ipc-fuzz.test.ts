import { afterEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { REQUEST_SCHEMAS } from '@contrail/shared';
import type { EngineDeps } from '@contrail/engine';
import { registerHandlers } from '../main/ipc/registry.js';
// The aliased electron stub (see vitest.config.ts) provides a recording ipcMain.
import { ipcMain } from 'electron';

/**
 * IPC fuzz suite (M6). The renderer is the one surface a hostile or buggy
 * caller reaches directly, so the contract is: NO payload that fails its zod
 * schema ever reaches a handler. These tests treat every channel as untrusted
 * input and prove the gate holds — at the schema, and at the live registry.
 */

// Payloads that are not the object every channel expects. A renderer (or
// something posing as one) can send any of these.
const HOSTILE_NON_OBJECTS: unknown[] = [
  null,
  undefined,
  '"; DROP TABLE connections; --',
  42,
  true,
  ['array', 'not', 'object'],
  'sk-ant-pretend-this-leaked',
  'x'.repeat(100_000), // oversized
];

const channels = Object.keys(REQUEST_SCHEMAS) as Array<keyof typeof REQUEST_SCHEMAS>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stub = ipcMain as any;

afterEach(() => {
  stub._reset();
});

describe('every channel rejects non-object payloads at the schema', () => {
  it('has a non-trivial number of channels to guard', () => {
    expect(channels.length).toBeGreaterThan(50);
  });

  for (const channel of channels) {
    it(`${channel} rejects every hostile non-object`, () => {
      const schema = REQUEST_SCHEMAS[channel] as z.ZodTypeAny;
      for (const bad of HOSTILE_NON_OBJECTS) {
        // undefined is what the registry sees as "no payload"; it coalesces to
        // {}, so schemas with no required fields legitimately accept it. Every
        // OTHER hostile value must be rejected outright.
        if (bad === undefined) continue;
        expect(schema.safeParse(bad).success, `${channel} accepted ${JSON.stringify(bad)?.slice(0, 40)}`).toBe(
          false,
        );
      }
    });
  }
});

describe('the live registry gate blocks bad payloads before the handler', () => {
  function registerSpies(): Map<string, ReturnType<typeof vi.fn>> {
    const spies = new Map<string, ReturnType<typeof vi.fn>>();
    const handlers: Record<string, unknown> = {};
    for (const channel of channels) {
      const spy = vi.fn(() => ({ ok: true }));
      spies.set(channel, spy);
      handlers[channel] = spy;
    }
    registerHandlers({} as EngineDeps, handlers as never);
    return spies;
  }

  it('registers exactly the contract channels', () => {
    registerSpies();
    expect(stub._channels().sort()).toEqual([...channels].sort());
  });

  it('a garbage payload throws and the handler is never called', async () => {
    const spies = registerSpies();
    // A channel with required fields — garbage must not slip through.
    await expect(stub._invoke('settings:setKey', 'not-an-object')).rejects.toThrow(/Invalid request/);
    await expect(stub._invoke('settings:setKey', { key: 123 })).rejects.toThrow(/Invalid request/);
    await expect(stub._invoke('settings:setKey', { key: 'short' })).rejects.toThrow(/Invalid request/);
    expect(spies.get('settings:setKey')!).not.toHaveBeenCalled();
  });

  it('a well-formed payload passes the gate and reaches the handler', async () => {
    const spies = registerSpies();
    const good = 'sk-ant-averyreallookinglongkey000000';
    await stub._invoke('settings:setKey', { key: good });
    expect(spies.get('settings:setKey')!).toHaveBeenCalledOnce();
    // The gate hands the handler the PARSED data, unchanged for a valid payload.
    expect(spies.get('settings:setKey')!.mock.calls[0]![1]).toEqual({ key: good });
  });

  it('no-field channels accept an empty/absent payload but reject a non-object', async () => {
    const spies = registerSpies();
    await stub._invoke('settings:keyStatus', undefined); // registry coalesces to {}
    expect(spies.get('settings:keyStatus')!).toHaveBeenCalledOnce();
    await expect(stub._invoke('settings:keyStatus', 'garbage')).rejects.toThrow(/Invalid request/);
  });
});

describe('representative typed-field enforcement', () => {
  it('numeric bounds and enums are enforced, not merely typed', () => {
    const cap = REQUEST_SCHEMAS['settings:setBudgetCap'] as z.ZodTypeAny;
    expect(cap.safeParse({ capUsd: -1 }).success).toBe(false); // below min
    expect(cap.safeParse({ capUsd: 5000 }).success).toBe(false); // above max
    expect(cap.safeParse({ capUsd: 'lots' }).success).toBe(false); // wrong type
    expect(cap.safeParse({ capUsd: 10 }).success).toBe(true);

    const summarize = REQUEST_SCHEMAS['metadata:summarize'] as z.ZodTypeAny;
    expect(
      summarize.safeParse({ connectionId: 'c', type: 'NotAType', apiName: 'X' }).success,
      'a bogus metadata type must be refused',
    ).toBe(false);
  });
});
