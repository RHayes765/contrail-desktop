import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-cap-'));
  db = new ContrailDb(path.join(tmp, 'test.db'));
  opened = [];
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
      'apex_execute',
      'apex_propose',
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
      'manage_connection',
      'refresh_snapshot',
      'retrieve_metadata',
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

  it('write-class flags cover exactly the write pipeline', () => {
    const writes = allCapabilities()
      .filter((c) => c.writeClass)
      .map((c) => c.name)
      .sort();
    expect(writes).toEqual([
      'apex_execute',
      'apex_propose',
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

  it('get_audit_log returns events', async () => {
    db.insertAuditEvent({ eventType: 'connection.created', outcome: 'success' });
    const result = await invokeCapability(deps, 'get_audit_log', {});
    const parsed = JSON.parse(textOf(result)) as { count: number };
    expect(parsed.count).toBeGreaterThanOrEqual(1);
  });
});
