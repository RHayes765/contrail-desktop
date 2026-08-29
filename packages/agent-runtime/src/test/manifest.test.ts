import { describe, expect, it } from 'vitest';
import { buildSessionOptions } from '../options.js';
import {
  grantUnion,
  mintableCapabilities,
  PROJECT_TOOL_NAMES,
  PROJECT_TOOLS,
  SESSION_EXCLUDED_CAPABILITIES,
} from '../mint.js';
import type { BindingWithGrants, SessionContext } from '../types.js';

/**
 * The tool-manifest snapshot suite — the tripwire for the Agent SDK decision's
 * config risk. If ANY assertion here fails after an SDK bump or refactor,
 * something changed the session's tool universe: stop and review before
 * shipping. (Agreed guardrails: allowlist-only, Bash never, one factory.)
 */

const FULL: BindingWithGrants = {
  connectionId: 'c1',
  alias: 'dev-org',
  orgName: 'Dev',
  orgType: 'developer',
  envRole: 'dev',
  grants: {
    metadata_read: true,
    metadata_write: true,
    diagnostics_read: true,
    data_read: true,
    data_write: true,
  },
};

const READ_ONLY: BindingWithGrants = {
  ...FULL,
  connectionId: 'c2',
  alias: 'client-prod',
  orgType: 'production',
  envRole: 'prod',
  grants: {
    metadata_read: true,
    metadata_write: false,
    diagnostics_read: false,
    data_read: false,
    data_write: false,
  },
};

function ctxWith(bindings: BindingWithGrants[]): SessionContext {
  return {
    sessionId: 's1',
    project: { id: 'p1', name: 'Test', description: null, instructions: null },
    bindings,
    model: 'claude-haiku-4-5',
    maxTurns: 4,
    maxBudgetUsd: 0.25,
    cwd: 'C:/tmp/scratch',
    claudeConfigDir: 'C:/tmp/contrail-claude-runtime',
    apiKey: 'sk-test',
  };
}

const invoke = async () => ({ content: [{ type: 'text' as const, text: 'ok' }] });

describe('tool manifest (THE isolation snapshot)', () => {
  it('full grants mint exactly the expected capability set — no more, no less', () => {
    const names = mintableCapabilities([FULL]).map((c) => c.name).sort();
    expect(names).toEqual([
      'apex_execute',
      'apex_propose',
      'deactivate_flow',
      'describe_schema',
      'diff_artifact',
      'diff_orgs',
      'dml_execute',
      'dml_propose',
      'execute_deploy',
      'get_audit_log',
      'get_debug_logs',
      'get_dependencies',
      'get_flow_errors',
      'get_org_changes',
      'get_permissions',
      'get_record',
      'get_setup_audit',
      'list_connections',
      'list_metadata',
      'refresh_snapshot',
      'retrieve_metadata',
      'run_apex_tests',
      'search_metadata',
      'set_trace_flag',
      'soql_query',
      'validate_deploy',
    ]);
  });

  it('connection lifecycle is NEVER minted into a session', () => {
    const names = mintableCapabilities([FULL]).map((c) => c.name);
    for (const excluded of SESSION_EXCLUDED_CAPABILITIES) {
      expect(names).not.toContain(excluded);
    }
  });

  it('metadata_read-only bindings get no write/data/diagnostics families', () => {
    const names = mintableCapabilities([READ_ONLY]).map((c) => c.name).sort();
    expect(names).toEqual([
      'describe_schema',
      'diff_artifact',
      'diff_orgs',
      'get_audit_log',
      'get_dependencies',
      'get_org_changes',
      'get_permissions',
      'get_setup_audit',
      'list_connections',
      'list_metadata',
      'refresh_snapshot',
      'retrieve_metadata',
      'search_metadata',
    ]);
  });

  it('grant union across bindings works (mixed fleet mints the union)', () => {
    const union = grantUnion([FULL, READ_ONLY]);
    expect(union.metadata_write).toBe(true);
    expect(union.data_write).toBe(true);
  });

  it('session options hold every isolation invariant', () => {
    const options = buildSessionOptions(ctxWith([FULL]), invoke);
    // NO built-in tools, by construction — the single most load-bearing line.
    expect(options.tools).toEqual([]);
    // Never load the user's ~/.claude settings, CLAUDE.md, or skills.
    expect(options.settingSources).toEqual([]);
    // Session history persists ONLY in the Contrail-owned config dir — the
    // resume mechanism. (Deliberate change from persistSession:false when
    // resume shipped; the user's real ~/.claude is still never touched.)
    expect(options.persistSession).not.toBe(false);
    expect(options.env?.CLAUDE_CONFIG_DIR).toBe('C:/tmp/contrail-claude-runtime');
    // Budget caps present.
    expect(options.maxTurns).toBe(4);
    expect(options.maxBudgetUsd).toBe(0.25);
  });

  it('resume passes through only when set', () => {
    const fresh = buildSessionOptions(ctxWith([FULL]), invoke);
    expect('resume' in fresh).toBe(false);
    const resumed = buildSessionOptions(
      { ...ctxWith([FULL]), resumeSdkSessionId: 'sdk-123' },
      invoke,
    );
    expect((resumed as { resume?: string }).resume).toBe('sdk-123');
  });

  it('allowedTools carries ONLY namespaced contrail capabilities — no built-in names ever', () => {
    const options = buildSessionOptions(ctxWith([FULL]), invoke);
    const allowed = options.allowedTools ?? [];
    expect(allowed.length).toBeGreaterThan(0);
    for (const name of allowed) {
      expect(name).toMatch(/^mcp__contrail__/);
    }
    const FORBIDDEN = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Task', 'Skill'];
    for (const builtIn of FORBIDDEN) {
      expect(allowed).not.toContain(builtIn);
    }
  });

  it('catalog toggles remove whole families from minting and allowedTools', () => {
    const names = mintableCapabilities([FULL], ['deploy', 'debug-logs']).map((c) => c.name);
    for (const gone of [
      'validate_deploy',
      'execute_deploy',
      'deactivate_flow',
      'get_debug_logs',
      'get_flow_errors',
      'run_apex_tests',
      'set_trace_flag',
    ]) {
      expect(names).not.toContain(gone);
    }
    // Untouched families and lifecycle survive.
    for (const kept of ['soql_query', 'list_metadata', 'list_connections', 'get_permissions']) {
      expect(names).toContain(kept);
    }
    const options = buildSessionOptions(
      { ...ctxWith([FULL]), disabledCatalogKeys: ['deploy', 'debug-logs'] },
      invoke,
    );
    const allowed = options.allowedTools ?? [];
    expect(allowed).not.toContain('mcp__contrail__execute_deploy');
    expect(allowed).toContain('mcp__contrail__soql_query');
  });

  it('external servers pass through: mcpServers entry + server-level allow spec', () => {
    const options = buildSessionOptions(
      {
        ...ctxWith([FULL]),
        externalServers: [
          { key: 'echo', transport: 'stdio', urlOrCommand: 'node', args: ['echo.mjs'] },
          { key: 'tracker', transport: 'http', urlOrCommand: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer tok' } },
        ],
      },
      invoke,
    );
    const servers = options.mcpServers as Record<string, { type?: string; command?: string; url?: string }>;
    expect(Object.keys(servers).sort()).toEqual(['contrail', 'echo', 'tracker']);
    expect(servers.echo).toMatchObject({ type: 'stdio', command: 'node' });
    expect(servers.tracker).toMatchObject({ type: 'http', url: 'https://mcp.example.com/mcp' });
    const allowed = options.allowedTools ?? [];
    expect(allowed).toContain('mcp__echo');
    expect(allowed).toContain('mcp__tracker');
    // Every entry is either a contrail capability or a declared external server — nothing else.
    for (const name of allowed) {
      expect(name).toMatch(/^mcp__(contrail__|echo$|tracker$)/);
    }
    // Auth material must never leak into the model-visible system prompt.
    expect(JSON.stringify(options.systemPrompt)).not.toContain('Bearer tok');
  });

  it('an external server can never shadow the first-party contrail namespace', () => {
    const options = buildSessionOptions(
      {
        ...ctxWith([FULL]),
        externalServers: [{ key: 'contrail', transport: 'http', urlOrCommand: 'https://evil.example.com' }],
      },
      invoke,
    );
    const servers = options.mcpServers as Record<string, { type?: string; url?: string }>;
    expect(Object.keys(servers)).toEqual(['contrail']);
    expect(servers.contrail.url).toBeUndefined(); // still the in-process SDK instance
    expect(options.allowedTools).not.toContain('mcp__contrail');
  });

  it('no external config means exactly one mcp server — absence adds nothing', () => {
    const options = buildSessionOptions(ctxWith([FULL]), invoke);
    expect(Object.keys(options.mcpServers ?? {})).toEqual(['contrail']);
  });

  it('external servers connect at startup (alwaysLoad) and the elicitation handler rides along', () => {
    const onElicitation = async () => null;
    const options = buildSessionOptions(
      {
        ...ctxWith([FULL]),
        externalServers: [{ key: 'echo', transport: 'stdio', urlOrCommand: 'node' }],
      },
      invoke,
      onElicitation,
    );
    const servers = options.mcpServers as Record<string, { alwaysLoad?: boolean }>;
    expect(servers.echo.alwaysLoad).toBe(true);
    expect(options.onElicitation).toBe(onElicitation);
    // Without a handler the option is absent entirely, not undefined-set.
    const bare = buildSessionOptions(ctxWith([FULL]), invoke);
    expect('onElicitation' in bare).toBe(false);
  });

  it('a server whose slug collides with a prototype key still mints (hasOwn, not `in`)', () => {
    const options = buildSessionOptions(
      {
        ...ctxWith([FULL]),
        externalServers: [{ key: 'constructor', transport: 'stdio', urlOrCommand: 'node' }],
      },
      invoke,
    );
    expect(Object.keys(options.mcpServers ?? {}).sort()).toEqual(['constructor', 'contrail']);
    expect(options.allowedTools).toContain('mcp__constructor');
  });

  it('read-only sessions cannot see write tools even in allowedTools', () => {
    const options = buildSessionOptions(ctxWith([READ_ONLY]), invoke);
    const allowed = options.allowedTools ?? [];
    for (const writeTool of [
      'validate_deploy',
      'execute_deploy',
      'dml_propose',
      'dml_execute',
      'deactivate_flow',
      'apex_propose',
      'apex_execute',
    ]) {
      expect(allowed).not.toContain(`mcp__contrail__${writeTool}`);
    }
  });

  it('project-silo tools mint into EVERY session — even with zero grants', () => {
    expect([...PROJECT_TOOL_NAMES].sort()).toEqual([
      'add_project_note',
      'list_project_docs',
      'list_project_files',
      'list_project_notes',
      'read_project_doc',
      'read_project_file',
      'read_skill',
    ]);
    const noGrants: BindingWithGrants = {
      ...READ_ONLY,
      grants: {
        metadata_read: false,
        metadata_write: false,
        diagnostics_read: false,
        data_read: false,
        data_write: false,
      },
    };
    for (const bindings of [[FULL], [noGrants], []]) {
      const allowed = buildSessionOptions(ctxWith(bindings), invoke).allowedTools ?? [];
      for (const name of PROJECT_TOOL_NAMES) {
        expect(allowed).toContain(`mcp__contrail__${name}`);
      }
    }
  });

  it('project tools never carry a project or connection argument (silo identity is server-side)', () => {
    // The whole point: the agent cannot NAME a project — main resolves it
    // from the session. A schema key like project_id would break that.
    for (const def of PROJECT_TOOLS) {
      const keys = Object.keys(def.inputSchema);
      expect(keys).not.toContain('project');
      expect(keys).not.toContain('project_id');
      expect(keys).not.toContain('projectId');
      expect(keys).not.toContain('connection');
    }
  });

  it('effort passes through to SDK options only when set', () => {
    const withEffort = buildSessionOptions({ ...ctxWith([FULL]), effort: 'high' }, invoke);
    expect((withEffort as { effort?: string }).effort).toBe('high');
    const without = buildSessionOptions(ctxWith([FULL]), invoke);
    expect('effort' in without).toBe(false);
  });

  it('system prompt is stable across calls (prompt-cache invariant)', () => {
    const a = buildSessionOptions(ctxWith([FULL]), invoke).systemPrompt;
    const b = buildSessionOptions(ctxWith([FULL]), invoke).systemPrompt;
    expect(a).toEqual(b);
    expect(String(a)).not.toMatch(/\d{4}-\d{2}-\d{2}|\d{2}:\d{2}/); // no dates/clocks in the prefix
  });

  it('skills section: present when skills ride the context, absent when none do', () => {
    const skills = [
      { name: 'building-salesforce-metadata', description: 'Author deployable metadata.' },
      { name: 'salesforce-house-rules', description: 'The operating contract for org work.' },
    ];
    const withSkills = String(
      buildSessionOptions({ ...ctxWith([FULL]), skills }, invoke).systemPrompt,
    );
    expect(withSkills).toContain('# Skills');
    expect(withSkills).toContain('read_skill');
    expect(withSkills).toContain('- salesforce-house-rules — The operating contract for org work.');
    // Stability applies with skills too.
    expect(withSkills).toEqual(
      String(buildSessionOptions({ ...ctxWith([FULL]), skills }, invoke).systemPrompt),
    );
    expect(withSkills).not.toMatch(/\d{4}-\d{2}-\d{2}|\d{2}:\d{2}/);

    // The house rules make loading a skill part of the contract, and phrase it
    // conditionally so it still reads correctly when no skills are enabled.
    expect(withSkills).toMatch(/Load the skill before you do the work/);
    expect(withSkills).toMatch(/When the Skills section below lists one/);

    const without = String(buildSessionOptions(ctxWith([FULL]), invoke).systemPrompt);
    expect(without).not.toContain('# Skills');
    expect(without).toMatch(/Load the skill before you do the work/); // rule survives, section doesn't
    const empty = String(
      buildSessionOptions({ ...ctxWith([FULL]), skills: [] }, invoke).systemPrompt,
    );
    expect(empty).not.toContain('# Skills');
  });
});
