import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { sdkToolName } from './mint.js';
import type { SessionContext } from './types.js';

/**
 * Subagent definitions (S28): the Claude-Code-style fan-out, inside
 * Contrail's cage. Every definition is READ-ONLY by construction:
 *
 *   - `tools` is an EXPLICIT list (never inheritance — an omitted list would
 *     inherit the parent's full surface, write tools and external MCP
 *     servers included);
 *   - no propose/execute tool, no deactivate_flow, no refresh_snapshot (it
 *     mutates the shared local snapshot), no set_trace_flag (writes a setup
 *     record), no add_project_note, and never the Agent tool itself (no
 *     recursive spawning);
 *   - `disallowedTools` repeats the bans as belt-and-suspenders.
 *
 * Writes stay with the accountable MAIN thread — which also sidesteps a real
 * race: approval interception and presentation-expectation are keyed per
 * session with no per-call identity, so concurrent write-presenting
 * subagents would fight over them. Every subagent tool call still crosses
 * the same bridge into the same main-process executor: grants, project
 * silo, and catalog toggles remain law regardless of what is listed here.
 */

/** Read-only capabilities a subagent may use (intersected with what the session minted). */
export const SUBAGENT_READ_TOOLS: ReadonlySet<string> = new Set([
  'list_connections',
  'get_permissions',
  'get_audit_log',
  'list_metadata',
  'retrieve_metadata',
  'describe_schema',
  'search_metadata',
  'get_dependencies',
  'get_org_changes',
  'get_setup_audit',
  'diff_orgs',
  'diff_artifact',
  'soql_query',
  'get_record',
  'explain_access',
  'get_debug_logs',
  'get_flow_errors',
  'check_apex',
  'check_soql',
  'list_project_docs',
  'read_project_doc',
  'list_project_notes',
  'list_project_files',
  'read_project_file',
  'read_skill',
]);

/** test-critic only: org-side execution, but test transactions commit nothing. */
export const TEST_CRITIC_EXTRA: readonly string[] = ['run_apex_tests'];

/** Everything a subagent must never hold — repeated in disallowedTools. */
export const SUBAGENT_BANNED_TOOLS: readonly string[] = [
  'validate_deploy',
  'execute_deploy',
  'deactivate_flow',
  'dml_propose',
  'dml_execute',
  'apex_propose',
  'apex_execute',
  'bulk_load_propose',
  'bulk_load_execute',
  'refresh_snapshot',
  'set_trace_flag',
  'add_project_note',
  'request_review',
  'connect_org',
  'disconnect_org',
  'manage_connection',
];

const SHARED_RULES =
  '\n\nRules: you are READ-ONLY — you hold no write tools and must never attempt or ' +
  'suggest workarounds to write. Name every org you touch by its alias. Report honestly: ' +
  'what you verified, what you could not, and what remains unknown. Be concrete — cite ' +
  'artifact names, line references, and query results, not vibes. Your final message is ' +
  'your whole report; make it complete and skimmable.';

const DEFINITIONS: Array<{
  key: string;
  description: string;
  prompt: string;
  extraTools?: readonly string[];
}> = [
  {
    key: 'deploy-reviewer',
    description:
      'Adversarial reviewer for staged Salesforce changes (metadata, Apex, DML plans, bulk ' +
      'loads) BEFORE they are proposed. Give it the exact content and the target org; it ' +
      'hunts for what would break.',
    prompt:
      'You are an adversarial Salesforce deploy reviewer. You receive content that is about ' +
      'to be proposed for deployment and the target connection. Hunt for real defects: ' +
      'data-loss paths (field type changes, whole-document replaces, destructive entries), ' +
      'security regressions (FLS/permissions not shipped with new components, over-broad ' +
      'access), governor traps (queries/DML in loops, unbounded queries), broken references ' +
      '(use describe_schema, search_metadata, and get_dependencies against the TARGET org ' +
      'to verify every field, object, and cross-reference actually exists), and missing ' +
      'test coverage. Run check_apex / check_soql on any code or queries. Classify each ' +
      'finding blocker / concern / note with the concrete failure scenario; if you find ' +
      'nothing after genuinely looking, say so plainly — do not invent findings.' +
      SHARED_RULES,
  },
  {
    key: 'test-critic',
    description:
      'Reviews Apex test classes for assertion quality, bulk coverage, and false-green ' +
      'patterns; can run already-deployed tests to check current state.',
    prompt:
      'You are an Apex test critic. Review the given test classes for: assertions that ' +
      'actually assert behavior (not just "no exception"), bulk paths (251+ records where ' +
      'the code path warrants), test-data independence (no SeeAllData, factories over ' +
      'hardcoded ids), negative and permission-boundary cases, and false-green patterns ' +
      '(swallowed exceptions, asserts inside conditionals). Use retrieve_metadata to read ' +
      'the classes under test; run_apex_tests to check the current state of DEPLOYED tests ' +
      'when useful. Report per class: verdict, gaps, and the specific scenarios missing.' +
      SHARED_RULES,
    extraTools: TEST_CRITIC_EXTRA,
  },
  {
    key: 'org-impact-scout',
    description:
      'Blast-radius scout: what depends on an artifact, what a change or delete would ' +
      'touch, and how much data rides on it.',
    prompt:
      'You are an org-impact scout. For the artifacts named, map the blast radius: ' +
      'get_dependencies (used_by, depth 2 where it matters), search_metadata for textual ' +
      'references the graph may miss, describe_schema for relationship shape, and ' +
      'row-count SOQL (SELECT COUNT() ...) to size the data riding on affected objects ' +
      'and fields. Distinguish hard breaks (compile/reference failures) from behavioral ' +
      'drift (automation that will fire differently). End with a ranked impact list.' +
      SHARED_RULES,
  },
  {
    key: 'scout',
    description:
      'General-purpose read-only investigator for anything else: org exploration, ' +
      'metadata archaeology, data questions, log digging — any research task worth ' +
      'delegating or running in parallel.',
    prompt:
      'You are a read-only Salesforce investigator working a delegated research task ' +
      'inside a Contrail project. Use the read tools — metadata search/retrieve, ' +
      'dependencies, schema describes, SOQL, debug logs, setup audit, org drift — to ' +
      'answer exactly what was asked. Follow the salesforce-house-rules skill if listed ' +
      '(load it with read_skill).' +
      SHARED_RULES,
  },
];

/**
 * Build the per-session subagent definitions: each role's tools are the
 * intersection of its allowlist with what THIS session actually minted (a
 * session without data_read simply yields validators without soql_query),
 * mapped into the SDK's mcp__contrail__* namespace.
 */
export function buildAgentDefinitions(
  ctx: SessionContext,
  mintedCapabilityNames: readonly string[],
): Record<string, AgentDefinition> {
  const minted = new Set(mintedCapabilityNames);
  const disallowed = ['Agent', 'Task', ...SUBAGENT_BANNED_TOOLS.map(sdkToolName)];
  const defs: Record<string, AgentDefinition> = {};
  for (const d of DEFINITIONS) {
    const names = [...SUBAGENT_READ_TOOLS, ...(d.extraTools ?? [])].filter((n) =>
      minted.has(n),
    );
    defs[d.key] = {
      description: d.description,
      prompt: d.prompt,
      tools: names.sort().map(sdkToolName),
      disallowedTools: disallowed,
      model: 'inherit',
    };
  }
  void ctx;
  return defs;
}
