import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContrailDb } from '../core/db.js';
import { MemoryTokenStore } from '../core/keychain.js';
import { DEFAULT_CONFIG } from '../core/config.js';
import { createEngineDeps, type EngineDeps } from '../core/deps.js';
import { allCapabilities, invokeCapability, type ToolResult } from '../capabilities/index.js';
import { emptyGrantSet, TOOL_GRANT_MAP } from '../core/grants.js';
import { SnapshotStore } from '../snapshot/store.js';

/**
 * The capability-surface suite — the Phase 0 MCP-surface tests re-pointed at
 * invokeCapability (same handlers, same ToolResult shape, no transport).
 */

let tmp: string;
let db: ContrailDb;
let deps: EngineDeps;
let opened: string[];
/** When true, the stubbed browser records the URL and then fails to open it. */
let browserFails: boolean;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-cap-'));
  db = new ContrailDb(path.join(tmp, 'test.db'));
  opened = [];
  browserFails = false;
  deps = createEngineDeps({
    db,
    tokens: new MemoryTokenStore(),
    config: { ...DEFAULT_CONFIG },
    store: new SnapshotStore(path.join(tmp, 'snapshots')),
    deploysDir: path.join(tmp, 'deploys'),
    // Stubbed externals — no real browser or Salesforce in tests.
    flowOps: {
      exchangeCode: async () => {
        throw new Error('not exercised in capability tests');
      },
      fetchOrgInfo: async () => {
        throw new Error('not exercised in capability tests');
      },
      fetchIdentity: async () => ({ username: null, userId: null, displayName: null }),
      revokeToken: async () => ({ ok: true }),
      openBrowser: async (url: string) => {
        opened.push(url);
        if (browserFails) throw new Error('no display');
      },
    },
  });
  fs.mkdirSync(path.join(tmp, 'deploys'), { recursive: true });
});

afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function textOf(result: ToolResult): string {
  return result.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
}

describe('capability surface', () => {
  it('exposes exactly the current capability set, all classified in TOOL_GRANT_MAP', () => {
    const caps = allCapabilities();
    const names = caps.map((c) => c.name).sort();
    expect(names).toEqual([
      'agent_activation_execute',
      'agent_activation_propose',
      'apex_execute',
      'apex_propose',
      'bulk_load_execute',
      'bulk_load_propose',
      'check_apex',
      'check_soql',
      'connect_org',
      'deactivate_flow',
      'describe_schema',
      'diff_artifact',
      'diff_orgs',
      'disconnect_org',
      'dml_execute',
      'dml_propose',
      'execute_deploy',
      'explain_access',
      'export_change_evidence',
      'get_audit_log',
      'get_debug_logs',
      'get_dependencies',
      'get_flow_errors',
      'get_org_changes',
      'get_permissions',
      'get_record',
      'get_report_data',
      'get_setup_audit',
      'list_connections',
      'list_metadata',
      'manage_connection',
      'refresh_snapshot',
      'retrieve_metadata',
      'run_agent_eval',
      'run_apex_tests',
      'search_metadata',
      'set_trace_flag',
      'soql_query',
      'validate_deploy',
    ]);
    for (const cap of caps) {
      expect(TOOL_GRANT_MAP, `${cap.name} must be grant-classified`).toHaveProperty(cap.name);
      // The declared grant on the capability must agree with the enforcement map —
      // minting filters by the former, the layer-2 gate refuses by the latter.
      expect(cap.grant, `${cap.name} grant declaration must match TOOL_GRANT_MAP`).toBe(
        TOOL_GRANT_MAP[cap.name],
      );
    }
  });

  it('every capability description fits the 2,000-byte cut (UTF-8)', () => {
    // Capabilities are minted to the Agent SDK as mcp__contrail__* tools, and
    // a client cuts an MCP tool description at 2 KB, removing the tail —
    // where a newly appended paragraph sits. This covers every capability,
    // so one added later is held to the same bound. Parameter descriptions
    // are outside it.
    const LIMIT = 2000;
    const caps = allCapabilities();
    expect(caps.length).toBeGreaterThan(0);
    for (const cap of caps) {
      expect(
        Buffer.byteLength(cap.description, 'utf8'),
        `${cap.name} description bytes`,
      ).toBeLessThanOrEqual(LIMIT);
    }
  });

  it('every proposing capability tells the agent about policies and describes ticket and justification', () => {
    // S46 (B): the mirror gate pins each governance text once, where its
    // constant is defined; this pins that every proposing capability still
    // carries it. validate_deploy has its own Policies paragraph; the other
    // five end with the shared note. All six take ticket and justification.
    // Desktop twin of the plugin's mcp.test.ts case.
    const POLICY_NOTE =
      "Policies in the human's config.json (list_connections reports them) can require a " +
      'justification or ticket, or freeze the connection. A proposal that breaks one is ' +
      'refused, naming the rule, and leaves any pending approval untouched: relay it, and never ' +
      'route around it. During a freeze the request is created, but while it lasts the human ' +
      'must type an emergency reason on their approval surface before it can be released.';
    const POLICIES_PARAGRAPH =
      "Policies: the human's config.json can set rules (list_connections reports them). A " +
      'real validation that breaks one is refused, naming the rule, and replaces no pending ' +
      'code: relay it to the human and never try another route. During a freeze the request ' +
      'is created, but while it lasts the human must type an emergency reason on their ' +
      'approval surface to release it. dry_run reports what a real validation would be ' +
      'refused for (policy_check) without refusing.';
    const TICKET =
      'The change ticket or reference for this write (the tracker key or change number the ' +
      'human named), one line, max 120 characters. Pass it ONLY when the human gave you one in ' +
      'this conversation or in the task they handed you — never invent, guess or reuse one. It ' +
      "is shown on the human's approval surface and recorded with the request. If " +
      "list_connections reports that this connection's policy requires a ticket and you have " +
      'none, ask the human for it before proposing.';
    const JUSTIFICATION =
      'One or two sentences on WHY this change is being made now, max 1000 characters. DRAFT it ' +
      'yourself from what the human asked for in this conversation, in their terms — the reason, ' +
      'not a description of the mechanics; do not pad it and do not state anything the human did ' +
      "not say. It is shown on the human's approval surface in an editable field, marked as " +
      'drafted by the agent, where they can overwrite it — a human who approves from the phone ' +
      "notification alone does not see it. Required when the connection's policy says so — by " +
      'default on production orgs and on orgs whose type Contrail could not determine — and ' +
      'welcome everywhere else.';
    const NOTED = [
      'deactivate_flow',
      'dml_propose',
      'apex_propose',
      'agent_activation_propose',
      'bulk_load_propose',
    ];
    const byName = new Map(allCapabilities().map((c) => [c.name, c]));
    for (const name of ['validate_deploy', ...NOTED]) {
      const cap = byName.get(name);
      expect(cap, name).toBeDefined();
      const description = cap!.description;
      if (name === 'validate_deploy') {
        expect(description.endsWith(` ${POLICIES_PARAGRAPH}`), `${name} ends with its Policies paragraph`).toBe(
          true,
        );
        expect(description, name).not.toContain(POLICY_NOTE);
      } else {
        expect(description.endsWith(` ${POLICY_NOTE}`), `${name} ends with the policy note`).toBe(true);
      }
      expect(cap!.inputSchema.ticket?.description, `${name} ticket`).toBe(TICKET);
      expect(cap!.inputSchema.justification?.description, `${name} justification`).toBe(JUSTIFICATION);
    }
  });

  it('write-class flags cover exactly the write pipeline', () => {
    const writes = allCapabilities()
      .filter((c) => c.writeClass)
      .map((c) => c.name)
      .sort();
    expect(writes).toEqual([
      'agent_activation_execute',
      'agent_activation_propose',
      'apex_execute',
      'apex_propose',
      'bulk_load_execute',
      'bulk_load_propose',
      'deactivate_flow',
      'dml_execute',
      'dml_propose',
      'execute_deploy',
      'validate_deploy',
    ]);
  });

  it('rejects malformed arguments with a schema error, not a crash', async () => {
    const result = await invokeCapability(deps, 'soql_query', { connection: 'x' }); // missing query
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Invalid arguments for soql_query');
  });

  it('refuses a metadata capability without the metadata_read grant, and audits the refusal', async () => {
    db.insertConnection({
      alias: 'no-grants',
      instanceUrl: 'https://locked.my.salesforce.com',
      loginUrl: 'https://login.salesforce.com',
      orgId: '00Dxx0000000009EAA',
      orgName: 'Locked',
      orgType: 'production',
      isSandbox: false,
      username: null,
      userId: null,
      grants: emptyGrantSet(),
    });
    const result = await invokeCapability(deps, 'list_metadata', { connection: 'no-grants' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('metadata_read');
    const refusal = db
      .queryAuditEvents({})
      .find((e) => e.eventType === 'grant.refused' && e.tool === 'list_metadata');
    expect(refusal).toBeTruthy();
    expect(refusal!.outcome).toBe('refused');
  });

  it('list_connections returns stored connections without any token material', async () => {
    const grants = emptyGrantSet();
    grants.metadata_read = true;
    db.insertConnection({
      alias: 'acme-uat',
      instanceUrl: 'https://acme--uat.sandbox.my.salesforce.com',
      loginUrl: 'https://test.salesforce.com',
      orgId: '00Dxx0000000001EAA',
      orgName: 'Acme UAT',
      orgType: 'sandbox',
      isSandbox: true,
      username: 'ryley@acme.com.uat',
      userId: null,
      grants,
    });
    const result = await invokeCapability(deps, 'list_connections', {});
    const text = textOf(result);
    const parsed = JSON.parse(text) as { count: number; connections: Array<Record<string, unknown>> };
    expect(parsed.count).toBe(1);
    expect(parsed.connections[0]!.alias).toBe('acme-uat');
    expect(text).not.toMatch(/refresh|access_token|RT-|AT-/);
  });

  it('list_connections reports, per connection, the policy that applies, and policies_status', async () => {
    // S46 (B): the injected config carries the built-in rule — production
    // (and unknown) orgs need a justification, nothing else does.
    for (const [alias, orgType, orgId] of [
      ['acme-prod', 'production', '00Dpp0000000001EAA'],
      ['acme-uat', 'sandbox', '00Dpp0000000002EAA'],
    ] as const) {
      db.insertConnection({
        alias,
        instanceUrl: 'https://acme.example.invalid',
        loginUrl: 'https://login.salesforce.com',
        orgId,
        orgName: 'Acme',
        orgType,
        isSandbox: orgType === 'sandbox',
        username: null,
        userId: null,
        grants: emptyGrantSet(),
      });
    }
    const result = await invokeCapability(deps, 'list_connections', {});
    const parsed = JSON.parse(textOf(result)) as {
      connections: Array<{ alias: string; policy: Record<string, unknown> | null }>;
      policies_status: Record<string, unknown>;
    };
    const policyOf = (alias: string) => parsed.connections.find((c) => c.alias === alias)!.policy;
    expect(policyOf('acme-prod')).toEqual({
      rules: ['default: production needs a justification'],
      requires_justification: true,
      requires_ticket: false,
      ticket_patterns: [],
      denies: [],
      min_test_level: null,
      freeze_windows: [],
      freeze_now: null,
    });
    expect(policyOf('acme-uat')).toMatchObject({ rules: [], requires_justification: false });
    expect(parsed.policies_status).toEqual({ status: 'ok', source: 'config', unmatched_rules: [] });
  });

  it('get_permissions reports granted AND not-granted, with the write-invariant note', async () => {
    const grants = emptyGrantSet();
    grants.data_read = true;
    db.insertConnection({
      alias: 'client-prod',
      instanceUrl: 'https://client.my.salesforce.com',
      loginUrl: 'https://login.salesforce.com',
      orgId: '00Dzz0000000002EAA',
      orgName: 'Client',
      orgType: 'production',
      isSandbox: false,
      username: null,
      userId: null,
      grants,
    });
    const result = await invokeCapability(deps, 'get_permissions', { connection: 'client-prod' });
    const parsed = JSON.parse(textOf(result)) as {
      granted: string[];
      not_granted: string[];
      notes: string[];
    };
    expect(parsed.granted).toEqual(['data_read']);
    expect(parsed.not_granted.sort()).toEqual(
      ['metadata_read', 'metadata_write', 'diagnostics_read', 'data_write'].sort(),
    );
    expect(parsed.notes.join(' ')).toContain('human approval');
  });

  it('errors cleanly for an unknown connection reference', async () => {
    const result = await invokeCapability(deps, 'get_permissions', { connection: 'nonexistent' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('list_connections');
  });

  it('manage_connection keeps the session-bearing URL out of model context when the browser opens', async () => {
    db.insertConnection({
      alias: 'managed-org',
      instanceUrl: 'https://managed.my.salesforce.com',
      loginUrl: 'https://login.salesforce.com',
      orgId: '00Dmm0000000003EAA',
      orgName: 'Managed',
      orgType: 'production',
      isSandbox: false,
      username: null,
      userId: null,
      grants: emptyGrantSet(),
    });
    const result = await invokeCapability(deps, 'manage_connection', { connection: 'managed-org' });
    const text = textOf(result);
    // The browser got the real tokened URL; the model got none of it.
    expect(opened.some((u) => u.includes('/manage?s='))).toBe(true);
    expect(text).not.toContain('?s=');
    expect(text).not.toContain('management_url');
    expect(text).toContain('"page_opened_in_browser": true');
  });

  it('manage_connection never returns the page address when the browser cannot be opened — the URL goes to the server log', async () => {
    db.insertConnection({
      alias: 'unopened-org',
      instanceUrl: 'https://unopened.example.invalid',
      loginUrl: 'https://login.salesforce.com',
      orgId: '00Dmm0000000004EAA',
      orgName: 'Unopened',
      orgType: 'sandbox',
      isSandbox: true,
      username: null,
      userId: null,
      grants: emptyGrantSet(),
    });
    browserFails = true;
    const logged: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      logged.push(String(chunk));
      return true;
    });
    let result: ToolResult;
    try {
      result = await invokeCapability(deps, 'manage_connection', { connection: 'unopened-org' });
    } finally {
      stderr.mockRestore();
    }
    const text = textOf(result);
    expect(result.isError ?? false).toBe(false);
    expect(text).toContain('"page_opened_in_browser": false');
    expect(text).toContain('deliberately NOT');
    expect(text).toContain('get_permissions');
    // No address of any kind, and never the session token.
    expect(text).not.toContain('http');
    expect(text).not.toContain('localhost');
    expect(text).not.toContain('?s=');
    expect(text).not.toContain('management_url');
    // The tokened URL went to the server log (stderr), as the approval and settings pages do.
    const url = opened.find((u) => u.includes('/manage?s='));
    expect(url).toBeDefined();
    expect(logged.some((line) => line.includes(url!))).toBe(true);
  });

  it('get_audit_log returns events', async () => {
    db.insertAuditEvent({ eventType: 'connection.created', outcome: 'success' });
    const result = await invokeCapability(deps, 'get_audit_log', {});
    const parsed = JSON.parse(textOf(result)) as { count: number };
    expect(parsed.count).toBeGreaterThanOrEqual(1);
  });

  it("get_audit_log request_id returns that request's trail only; event_type takes a type or a family; until bounds the end", async () => {
    // S46 (B): the rows whose detail names the request id, as requestId or in
    // the expiry sweep's requestIds list.
    const mine = '0b9e8f0e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
    const other = '7f6e5d4c-3b2a-4109-8f7e-6d5c4b3a2910';
    db.insertAuditEvent({
      eventType: 'dml.proposed',
      outcome: 'success',
      detail: { requestId: mine, operation: 'update' },
    });
    db.insertAuditEvent({ eventType: 'approval.notified', outcome: 'success', detail: { requestId: mine } });
    db.insertAuditEvent({ eventType: 'dml.refused', outcome: 'refused', detail: { requestId: mine } });
    db.insertAuditEvent({ eventType: 'dml.proposed', outcome: 'success', detail: { requestId: other } });
    db.insertAuditEvent({ eventType: 'policy.refused', outcome: 'refused', detail: { phase: 'propose' } });
    db.insertAuditEvent({ eventType: 'policy.config_seen', outcome: 'success', detail: { status: 'ok' } });
    db.insertAuditEvent({ eventType: 'dml.superseded', outcome: 'success', detail: { count: 1 } });
    db.insertAuditEvent({
      eventType: 'deploy.expired',
      tool: 'validate_deploy',
      outcome: 'success',
      detail: { count: 1, requestIds: [mine] },
    });

    const trail = JSON.parse(
      textOf(await invokeCapability(deps, 'get_audit_log', { request_id: mine })),
    ) as {
      count: number;
      events: Array<{ event_type: string; detail: { requestId?: string; requestIds?: string[] } }>;
    };
    expect(trail.count).toBe(4);
    expect(trail.events.map((e) => e.event_type).sort()).toEqual(
      ['approval.notified', 'deploy.expired', 'dml.proposed', 'dml.refused'].sort(),
    );
    expect(
      trail.events.every((e) => e.detail.requestId === mine || (e.detail.requestIds ?? []).includes(mine)),
    ).toBe(true);
    const otherTrail = JSON.parse(
      textOf(await invokeCapability(deps, 'get_audit_log', { request_id: other })),
    ) as { events: Array<{ event_type: string }> };
    expect(otherTrail.events.map((e) => e.event_type)).toEqual(['dml.proposed']);

    const exact = JSON.parse(
      textOf(await invokeCapability(deps, 'get_audit_log', { event_type: 'policy.refused' })),
    ) as { events: Array<{ event_type: string }> };
    expect(exact.events.map((e) => e.event_type)).toEqual(['policy.refused']);
    const family = JSON.parse(
      textOf(await invokeCapability(deps, 'get_audit_log', { event_type: 'policy.' })),
    ) as { events: Array<{ event_type: string }> };
    expect(family.events.map((e) => e.event_type).sort()).toEqual(['policy.config_seen', 'policy.refused']);

    const before = JSON.parse(
      textOf(
        await invokeCapability(deps, 'get_audit_log', {
          request_id: mine,
          until: '2000-01-01T00:00:00.000Z',
        }),
      ),
    ) as { count: number };
    expect(before.count).toBe(0);

    // A bound that is not a timestamp is refused, never compared as text.
    const badBound = await invokeCapability(deps, 'get_audit_log', { until: 'yesterday' });
    expect(badBound.isError).toBe(true);
    expect(textOf(badBound)).toBe(
      'until must be an ISO 8601 timestamp (for example 2026-11-17T09:00:00Z), got "yesterday".',
    );

    // Not a request id: refused, never matched loosely (a LIKE wildcard would match every row).
    const bad = await invokeCapability(deps, 'get_audit_log', { request_id: '%' });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain('request id must be the request_id a validate or propose result returned');
    const badType = await invokeCapability(deps, 'get_audit_log', { event_type: 'policy%' });
    expect(badType.isError).toBe(true);
    expect(textOf(badType)).toContain('event type must look like policy.refused');
  });

  it('export_change_evidence with no filter is refused and writes nothing', async () => {
    const before = process.env.CONTRAIL_DATA_DIR;
    process.env.CONTRAIL_DATA_DIR = tmp;
    try {
      const result = await invokeCapability(deps, 'export_change_evidence', {});
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(
        'Name at least one of connection, ticket, request_id or since. An unfiltered dossier would ' +
          "mix every connection's changes in one folder.",
      );
      expect(fs.existsSync(path.join(tmp, 'evidence'))).toBe(false);
    } finally {
      if (before === undefined) delete process.env.CONTRAIL_DATA_DIR;
      else process.env.CONTRAIL_DATA_DIR = before;
    }
  });

  it('export_change_evidence is grant-null, read-class and uncataloged', async () => {
    const cap = allCapabilities().find((c) => c.name === 'export_change_evidence')!;
    expect(cap.grant).toBeNull();
    expect(cap.writeClass).toBe(false);
    const { catalogKeyFor } = await import('../capabilities/catalog.js');
    expect(catalogKeyFor('export_change_evidence')).toBeNull();
  });

  it('the human-surface methods are named only by the engine, the approval page server, Deploy Review and tests', () => {
    // S46 (B): saving a justification, recording a freeze override and the
    // Deploy Review governance check are the human's acts on their own
    // approval surface. No capability, agent-runtime module, IPC handler,
    // preload bridge, renderer module or other module may reach them — so
    // this is an allow-list over the engine, the agent runtime, the shared
    // package, the skills package and the app's main, preload and renderer
    // sources, not a scan of capabilities/: a new file that names one of
    // them fails here. Build output (dist) and node_modules are not scanned.
    const engineSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const repo = path.resolve(engineSrc, '..', '..', '..');
    const roots = [
      path.join(repo, 'packages', 'engine', 'src'),
      path.join(repo, 'packages', 'agent-runtime', 'src'),
      path.join(repo, 'packages', 'shared', 'src'),
      path.join(repo, 'packages', 'skills'),
      path.join(repo, 'apps', 'desktop', 'src', 'main'),
      path.join(repo, 'apps', 'desktop', 'src', 'preload'),
      path.join(repo, 'apps', 'desktop', 'src', 'renderer'),
    ];
    // A root that moved would be walked as empty and pass vacuously.
    for (const root of roots) expect(fs.existsSync(root), root).toBe(true);
    const HUMAN_ONLY = ['recordFreezeOverride', 'saveJustification', 'reviewGovernance'];
    const ALLOWED = new Set([
      'packages/engine/src/deploy/engine.ts',
      'packages/engine/src/deploy/approval.ts',
      'apps/desktop/src/main/services/deploys.ts',
    ]);
    const offenders: string[] = [];
    const seen: string[] = [];
    const walk = (dir: string): void => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'test' || entry.name === 'node_modules' || entry.name === 'dist') continue;
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx|js|mjs)$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
        const rel = path.relative(repo, full).split(path.sep).join('/');
        const text = fs.readFileSync(full, 'utf8');
        for (const name of HUMAN_ONLY) {
          if (!new RegExp(`\\b${name}\\b`).test(text)) continue;
          if (ALLOWED.has(rel)) seen.push(`${rel}: ${name}`);
          else offenders.push(`${rel}: ${name}`);
        }
      }
    };
    for (const root of roots) walk(root);
    expect(offenders).toEqual([]);
    // The scan finds them where they live, so a rename cannot make it vacuous.
    expect(seen).toEqual(
      expect.arrayContaining([
        'packages/engine/src/deploy/engine.ts: saveJustification',
        'packages/engine/src/deploy/engine.ts: recordFreezeOverride',
        'packages/engine/src/deploy/engine.ts: reviewGovernance',
        'packages/engine/src/deploy/approval.ts: saveJustification',
        'packages/engine/src/deploy/approval.ts: recordFreezeOverride',
      ]),
    );
  });
});
