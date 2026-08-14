import type { z } from 'zod';
import type { EngineDeps } from '../core/deps.js';
import type { Grant } from '../core/grants.js';
import type { ToolResult } from './result.js';

/**
 * One engine capability — a named, grant-classified operation with a zod
 * input schema and a handler. This is the Phase 0 MCP tool surface rebuilt
 * MCP-free, so the same 23 operations serve agent tool minting, tests, and
 * any future surface. Descriptions are prompt-engineering assets carried
 * verbatim from the tool layer.
 */
export interface Capability {
  name: string;
  title: string;
  description: string;
  /** The single grant this capability requires; null = no grant (lifecycle/audit). */
  grant: Grant | null;
  /** True for operations that change an org (deploy/DML execution and proposal). */
  writeClass: boolean;
  /** Zod RAW SHAPE (keys → zod types), matching the MCP registerTool convention. */
  inputSchema: Record<string, z.ZodTypeAny>;
  handler(deps: EngineDeps, args: Record<string, unknown>): Promise<ToolResult>;
}
