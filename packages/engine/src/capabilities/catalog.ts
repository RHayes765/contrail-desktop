import { allCapabilities } from './index.js';

/**
 * The standard-server catalog (spec §6): the first-party capability families
 * a project can toggle. Declarative data consumed by minting, the executor
 * gate, and the toggles UI — adding a capability means adding its name to
 * exactly one entry here (the catalog tripwire test enforces coverage).
 *
 * Lifecycle capabilities (grant: null — list_connections, get_permissions,
 * get_audit_log) are deliberately uncataloged: they are zero-cost local
 * reads every session keeps, so there is nothing to toggle.
 */

export interface CatalogEntry {
  key: string;
  label: string;
  description: string;
  capabilities: string[];
}

export const STANDARD_CATALOG: CatalogEntry[] = [
  {
    key: 'metadata',
    label: 'Metadata',
    description:
      'Browse, search, retrieve, and diff org metadata from local snapshots; org drift and setup audit.',
    capabilities: [
      'list_metadata',
      'retrieve_metadata',
      'search_metadata',
      'get_dependencies',
      'refresh_snapshot',
      'diff_orgs',
      'diff_artifact',
      'get_org_changes',
      'get_setup_audit',
    ],
  },
  {
    key: 'describe',
    label: 'Schema describe',
    description: 'Object and field schema descriptions.',
    capabilities: ['describe_schema'],
  },
  {
    key: 'data',
    label: 'Data & SOQL',
    description:
      'SOQL queries and record reads; DML, anonymous Apex, and bulk CSV data loads — ' +
      'proposal and execution.',
    capabilities: [
      'soql_query',
      'get_record',
      'explain_access',
      'dml_propose',
      'dml_execute',
      'apex_propose',
      'apex_execute',
      'bulk_load_propose',
      'bulk_load_execute',
    ],
  },
  {
    key: 'debug-logs',
    label: 'Debug logs',
    description:
      'Apex debug logs, flow error investigation, standalone Apex test runs, and trace flags.',
    capabilities: ['get_debug_logs', 'get_flow_errors', 'run_apex_tests', 'set_trace_flag'],
  },
  {
    key: 'deploy',
    label: 'Deploy',
    description: 'Metadata deploy validation and execution, flow deactivation.',
    capabilities: ['validate_deploy', 'deactivate_flow', 'execute_deploy'],
  },
];

const KEY_BY_CAPABILITY = new Map<string, string>();
for (const entry of STANDARD_CATALOG) {
  for (const name of entry.capabilities) KEY_BY_CAPABILITY.set(name, entry.key);
}

/** The catalog family a capability belongs to; null = lifecycle (never toggleable). */
export function catalogKeyFor(capabilityName: string): string | null {
  return KEY_BY_CAPABILITY.get(capabilityName) ?? null;
}

export function isStandardCatalogKey(key: string): boolean {
  return STANDARD_CATALOG.some((e) => e.key === key);
}

/** server_key for an external (custom) MCP server row — stable across renames. */
export function externalServerKey(serverId: string): string {
  return `ext:${serverId}`;
}

/**
 * Resolve a toggle: an explicit row always wins. Absent a row, standard
 * families are ON and external servers are OFF — an external server must be
 * opted into per project (engagement isolation: a globally registered
 * connector must never flow into a client project silently).
 */
export function serverEnabled(
  toggles: ReadonlyArray<{ serverKey: string; enabled: boolean }>,
  serverKey: string,
  /**
   * Fallback for EXTERNAL servers with no toggle row: the connector's own
   * default_on flag (v12). Standard families ignore this — they default on
   * by being standard. Explicit per-project toggles always win over both.
   */
  externalDefault = false,
): boolean {
  const row = toggles.find((t) => t.serverKey === serverKey);
  if (row) return row.enabled;
  return isStandardCatalogKey(serverKey) || externalDefault;
}

/** skill_key for a custom (uploaded) skill row — stable across renames. */
export function customSkillKey(skillId: string): string {
  return `ext:${skillId}`;
}

/**
 * Resolve a skill toggle (v13) — serverEnabled's sibling with the same
 * precedence: an explicit per-project row always wins; absent a row, bundled
 * skills are ON and custom skills fall back to their own default_on flag
 * (engagement isolation: an uploaded skill must never flow into a client
 * project silently unless its owner said "on by default").
 */
export function skillEnabled(
  toggles: ReadonlyArray<{ skillKey: string; enabled: boolean }>,
  skillKey: string,
  isBundled: boolean,
  customDefault = false,
): boolean {
  const row = toggles.find((t) => t.skillKey === skillKey);
  if (row) return row.enabled;
  return isBundled || customDefault;
}

/** Every grant-bearing capability must appear in exactly one catalog entry. */
export function catalogCoverageViolations(): string[] {
  const problems: string[] = [];
  const seen = new Map<string, string>();
  for (const entry of STANDARD_CATALOG) {
    for (const name of entry.capabilities) {
      const prior = seen.get(name);
      if (prior) problems.push(`${name} appears in both "${prior}" and "${entry.key}"`);
      seen.set(name, entry.key);
    }
  }
  for (const cap of allCapabilities()) {
    if (cap.grant !== null && !seen.has(cap.name)) {
      problems.push(`${cap.name} (grant ${cap.grant}) is missing from the catalog`);
    }
    if (cap.grant === null && seen.has(cap.name)) {
      problems.push(`${cap.name} is lifecycle (grant null) but appears in the catalog`);
    }
  }
  for (const name of seen.keys()) {
    if (!allCapabilities().some((c) => c.name === name)) {
      problems.push(`catalog names unknown capability ${name}`);
    }
  }
  return problems;
}
