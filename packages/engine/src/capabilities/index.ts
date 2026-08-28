import { z } from 'zod';
import type { EngineDeps } from '../core/deps.js';
import type { Capability } from './types.js';
import { fail, type ToolResult } from './result.js';
import { connectionCapabilities } from './connections.js';
import { metadataCapabilities } from './metadata.js';
import { diffCapabilities } from './diff.js';
import { dataCapabilities } from './data.js';
import { deployCapabilities } from './deploy.js';

export type { Capability } from './types.js';
export { ok, fail, guarded, type ToolResult } from './result.js';

const ALL: Capability[] = [
  ...connectionCapabilities,
  ...metadataCapabilities,
  ...diffCapabilities,
  ...dataCapabilities,
  ...deployCapabilities,
];

const BY_NAME = new Map(ALL.map((c) => [c.name, c]));

/** Every capability, in registration order (the Phase 0 tools plus later additions). */
export function allCapabilities(): Capability[] {
  return [...ALL];
}

export function getCapability(name: string): Capability | undefined {
  return BY_NAME.get(name);
}

/**
 * Validate args against the capability's schema and run its handler. This is
 * the single entry point every surface uses (agent tool minting, IPC
 * services, tests) — grant enforcement happens inside handlers via the
 * layer-2 gate, exactly as in Phase 0.
 */
export async function invokeCapability(
  deps: EngineDeps,
  name: string,
  args: unknown,
): Promise<ToolResult> {
  const cap = BY_NAME.get(name);
  if (!cap) return fail(`Unknown capability "${name}".`);
  const parsed = z.object(cap.inputSchema).safeParse(args ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return fail(`Invalid arguments for ${name}: ${issues}`);
  }
  return cap.handler(deps, parsed.data as Record<string, unknown>);
}
