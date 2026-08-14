import { z } from 'zod';
import type { ConnectionView, HealthView } from './views.js';

/**
 * The typed IPC contract — the single source of truth for every channel
 * between renderer and main. Main validates every request against the zod
 * schema before the handler runs; the renderer client is typed off the same
 * table. Add a channel here first, then implement its handler.
 *
 * Two kinds of traffic:
 *   - invoke channels (renderer → main → response), declared in `Contracts`
 *   - push channels (main → renderer events), declared in `PushEvents`
 */

// ── invoke channels ──────────────────────────────────────────────────────

export const REQUEST_SCHEMAS = {
  'app:health': z.object({}),
  'connections:list': z.object({}),
} as const;

export type Channel = keyof typeof REQUEST_SCHEMAS;

export interface Contracts {
  'app:health': { req: Record<string, never>; res: HealthView };
  'connections:list': { req: Record<string, never>; res: ConnectionView[] };
}

// Compile-time check: every contract has a schema and vice versa.
type _SchemaCovers = keyof Contracts extends Channel ? true : never;
type _ContractCovers = Channel extends keyof Contracts ? true : never;
const _covered: [_SchemaCovers, _ContractCovers] = [true, true];
void _covered;

// ── push channels (main → renderer) ──────────────────────────────────────

export interface PushEvents {
  'connections:changed': { reason: 'connected' | 'updated' | 'removed' };
}

export type PushChannel = keyof PushEvents;

/** The surface preload exposes on window.contrail. */
export interface ContrailBridge {
  invoke<C extends keyof Contracts>(
    channel: C,
    req: Contracts[C]['req'],
  ): Promise<Contracts[C]['res']>;
  subscribe<C extends PushChannel>(
    channel: C,
    listener: (payload: PushEvents[C]) => void,
  ): () => void;
}
