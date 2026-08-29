import { z } from 'zod';
import {
  allCapabilities,
  catalogKeyFor,
  type Capability,
  type Grant,
  type GrantSet,
} from '@contrail/engine';
import type { BindingWithGrants } from './types.js';

/**
 * Tool minting: which engine capabilities a session receives, derived from
 * the union of its bindings' grants. Ungranted families simply don't exist
 * in the session — and the main-process executor re-checks the TARGET
 * connection's grant on every call (defense in depth; minting is UX, the
 * gate is law).
 */

/**
 * Connection lifecycle is the desktop UI's job, never the agent's — a session
 * must not be able to start OAuth flows, revoke tokens, or open the grants
 * page. These are excluded from minting regardless of grants.
 */
export const SESSION_EXCLUDED_CAPABILITIES: readonly string[] = [
  'connect_org',
  'disconnect_org',
  'manage_connection',
];

export function grantUnion(bindings: BindingWithGrants[]): GrantSet {
  const union: GrantSet = {
    metadata_read: false,
    metadata_write: false,
    diagnostics_read: false,
    data_read: false,
    data_write: false,
  };
  for (const b of bindings) {
    for (const key of Object.keys(union) as Grant[]) {
      if (b.grants[key]) union[key] = true;
    }
  }
  return union;
}

/**
 * The capabilities a session with these bindings is allowed to see.
 * `disabledCatalogKeys` removes whole catalog families the project toggled
 * off; lifecycle capabilities (uncataloged) are unaffected by toggles.
 */
export function mintableCapabilities(
  bindings: BindingWithGrants[],
  disabledCatalogKeys: readonly string[] = [],
): Capability[] {
  const union = grantUnion(bindings);
  const disabled = new Set(disabledCatalogKeys);
  return allCapabilities().filter((cap) => {
    if (SESSION_EXCLUDED_CAPABILITIES.includes(cap.name)) return false;
    const family = catalogKeyFor(cap.name);
    if (family && disabled.has(family)) return false;
    if (cap.grant === null) return true; // zero-cost local reads (list_connections, get_permissions, …)
    return union[cap.grant];
  });
}

/** SDK tool names are namespaced by the in-process MCP server name. */
export const MCP_SERVER_NAME = 'contrail';

export function sdkToolName(capabilityName: string): string {
  return `mcp__${MCP_SERVER_NAME}__${capabilityName}`;
}

// ── project-silo tools ───────────────────────────────────────────────────

/**
 * Tools every session gets regardless of grants: the project's own documents
 * and notes. They carry no connection arguments and no project argument —
 * the executor in main resolves the project FROM THE SESSION, so a session
 * physically cannot name another project's silo. Descriptions are stable
 * prompt assets (cache discipline applies).
 */
export interface ProjectToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
}

export const PROJECT_TOOLS: ProjectToolDef[] = [
  {
    name: 'list_project_docs',
    description:
      'List the reference documents attached to this project (filename, type, size). ' +
      'These are files the user added for you to consult; read one with read_project_doc.',
    inputSchema: {},
  },
  {
    name: 'read_project_doc',
    description:
      'Read a project reference document by filename (as listed by list_project_docs). ' +
      'Text formats only in v1; long documents are truncated with a notice.',
    inputSchema: {
      filename: z.string().describe('Exact filename from list_project_docs.'),
    },
  },
  {
    name: 'list_project_notes',
    description:
      'List this project\'s persistent notes — durable observations recorded by you or the ' +
      'user across sessions (decisions, org quirks, follow-ups). Check them before ' +
      're-deriving project context.',
    inputSchema: {},
  },
  {
    name: 'add_project_note',
    description:
      'Record a persistent project note that future sessions will see. Use for durable ' +
      'facts worth carrying across sessions — decisions made, org quirks discovered, ' +
      'follow-ups promised — not for scratch reasoning.',
    inputSchema: {
      body: z.string().describe('The note text (plain text or markdown, max 10,000 chars).'),
    },
  },
  {
    name: 'list_project_files',
    description:
      'List the text files inside the local folders the user LINKED to this project — a ' +
      'live view of their current contents (no copies; edits on disk appear immediately). ' +
      'Read one with read_project_file. Large folders are listed truncated, with a notice.',
    inputSchema: {},
  },
  {
    name: 'read_project_file',
    description:
      'Read one file from a linked project folder, live from disk. Text formats only; ' +
      'long files are truncated with a notice.',
    inputSchema: {
      folder: z.string().describe('Folder name from list_project_files.'),
      path: z.string().describe('File path relative to that folder, as listed (e.g. "notes/plan.md").'),
    },
  },
  {
    name: 'read_skill',
    description:
      'Load a skill by name — the available skills are listed in the system prompt. ' +
      'Returns the skill\'s full instructions; load it BEFORE relying on its domain. ' +
      'Skills a project has disabled refuse to load.',
    inputSchema: {
      name: z.string().describe('Exact skill name from the system prompt\'s Skills list.'),
    },
  },
];

export const PROJECT_TOOL_NAMES: readonly string[] = PROJECT_TOOLS.map((t) => t.name);
