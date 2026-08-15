import { describe, expect, it } from 'vitest';
import type { ConnectionRecord, EngineDeps } from '@contrail/engine';
import {
  AgentSessionRun,
  redactSensitive,
  scrubCodes,
  type SessionSpec,
} from '../main/services/agentRuntime.js';
import type { ProjectService } from '../main/services/projects.js';

/**
 * The project-silo executor — the engagement-isolation enforcement point —
 * exercised against a LIVE fake DB so the review-confirmed failure mode
 * (enforcing a stale binding snapshot) stays dead.
 */

function conn(id: string, alias: string): ConnectionRecord {
  return {
    id,
    alias,
    orgId: '00D' + id,
    orgName: alias + ' org',
    orgType: 'sandbox',
    isSandbox: true,
    instanceUrl: `https://${alias}.my.salesforce.com`,
    loginUrl: 'https://test.salesforce.com',
    username: 'u@example.com',
    grants: {
      metadata_read: true,
      metadata_write: false,
      diagnostics_read: false,
      data_read: true,
      data_write: false,
    },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    lastUsedAt: null,
  } as ConnectionRecord;
}

/** Mutable fake of the slice of ContrailDb the executor reads. */
function fakeWorld() {
  const connections = new Map<string, ConnectionRecord>();
  const bindings = new Map<string, Array<{ connectionId: string; envRole: string }>>();
  const projects = new Set<string>(['p1']);
  const db = {
    resolveConnection: (ref: string) =>
      connections.get(ref) ??
      [...connections.values()].find((c) => c.alias.toLowerCase() === ref.toLowerCase()) ??
      null,
    listProjectBindings: (projectId: string) => bindings.get(projectId) ?? [],
    getProject: (id: string) =>
      projects.has(id) ? { id, name: 'P', description: null, instructions: null } : null,
  };
  return { connections, bindings, projects, deps: { db } as unknown as EngineDeps };
}

const SPEC_PROJECT = { id: 'p1', name: 'P', description: null, instructions: null };

function makeRun(world: ReturnType<typeof fakeWorld>, silo?: Partial<ProjectService>) {
  const spec: SessionSpec = {
    project: SPEC_PROJECT,
    bindings: [], // deliberately empty: the executor must NOT depend on the snapshot
    model: 'claude-haiku-4-5',
    maxTurns: 10,
    maxBudgetUsd: 0.5,
  };
  return new AgentSessionRun(world.deps, spec, 'session-1', (silo ?? {}) as ProjectService);
}

describe('silo enforcement reads LIVE bindings (never a session-start snapshot)', () => {
  it('a connection unbound after session start is refused on the next call', async () => {
    const world = fakeWorld();
    world.connections.set('c-dev', conn('c-dev', 'dev-org'));
    world.connections.set('c-prod', conn('c-prod', 'client-prod'));
    world.bindings.set('p1', [
      { connectionId: 'c-dev', envRole: 'dev' },
      { connectionId: 'c-prod', envRole: 'prod' },
    ]);
    const run = makeRun(world);

    // Bound right now → the scoped listing sees it.
    const before = await run.executeCapability('list_connections', {});
    expect(before.isError).toBeFalsy();
    expect(before.content[0]?.text).toContain('client-prod');

    // The user unbinds prod mid-session (only the DB row changes).
    world.bindings.set('p1', [{ connectionId: 'c-dev', envRole: 'dev' }]);

    const listing = await run.executeCapability('list_connections', {});
    expect(listing.content[0]?.text).not.toContain('client-prod');

    const call = await run.executeCapability('soql_query', {
      connection: 'client-prod',
      query: 'SELECT COUNT() FROM Account',
    });
    expect(call.isError).toBe(true);
    expect(call.content[0]?.text).toContain('not part of this project');
    // And by id as well as alias:
    const byId = await run.executeCapability('soql_query', { connection: 'c-prod', query: 'x' });
    expect(byId.isError).toBe(true);
  });

  it('unbound references are refused even though the connection exists globally', async () => {
    const world = fakeWorld();
    world.connections.set('c-other', conn('c-other', 'other-clients-org'));
    world.bindings.set('p1', []); // nothing bound to this project
    const run = makeRun(world);
    const result = await run.executeCapability('diff_orgs', {
      connection_a: 'other-clients-org',
      connection_b: 'other-clients-org',
    });
    expect(result.isError).toBe(true);
  });

  it('get_audit_log without a connection is refused (would span every project)', async () => {
    const world = fakeWorld();
    const run = makeRun(world);
    const result = await run.executeCapability('get_audit_log', {});
    expect(result.isError).toBe(true);
  });
});

describe('project tools', () => {
  it('answer for the session project only — and die with the project', async () => {
    const world = fakeWorld();
    const seenProjects: string[] = [];
    const run = makeRun(world, {
      listDocs: (projectId: string) => {
        seenProjects.push(projectId);
        return [];
      },
    } as unknown as Partial<ProjectService>);

    const ok = await run.executeCapability('list_project_docs', { project_id: 'p-SOMEONE-ELSE' });
    expect(ok.isError).toBeFalsy();
    // Agent-supplied project args are ignored: identity comes from the session.
    expect(seenProjects).toEqual(['p1']);

    world.projects.delete('p1');
    const gone = await run.executeCapability('list_project_docs', {});
    expect(gone.isError).toBe(true);
    expect(gone.content[0]?.text).toContain('no longer exists');
  });

  it('read_project_doc surfaces silo refusals from the doc reader', async () => {
    const world = fakeWorld();
    const run = makeRun(world, {
      readDocText: () => ({ ok: false as const, message: 'filename must be a plain filename, not a path.' }),
    } as unknown as Partial<ProjectService>);
    const result = await run.executeCapability('read_project_doc', {
      filename: '..\\..\\other-project\\docs\\secrets.md',
    });
    expect(result.isError).toBe(true);
  });
});

describe('redaction (invariant 2)', () => {
  it('strips code/secret/token/password-keyed values at any depth', () => {
    const input = {
      connection: 'dev-org',
      confirmation_code: 'ABCD-EFGH',
      nested: { api_token: 'xyz', fine: 'keep', list: [{ password: 'p' }] },
    };
    const redacted = redactSensitive(input) as Record<string, unknown>;
    expect(redacted.confirmation_code).toBe('[redacted]');
    expect((redacted.nested as Record<string, unknown>).api_token).toBe('[redacted]');
    expect((redacted.nested as Record<string, unknown>).fine).toBe('keep');
    expect(
      (((redacted.nested as Record<string, unknown>).list as unknown[])[0] as Record<string, unknown>)
        .password,
    ).toBe('[redacted]');
    // Original untouched — the child still gets real args.
    expect(input.confirmation_code).toBe('ABCD-EFGH');
  });

  it('scrubs confirmation-code shapes out of user text', () => {
    expect(scrubCodes('the code is WXYZ-2345, run it')).toBe('the code is [code], run it');
    // Codes alphabet excludes I, L, O, 0, 1 — lookalike text survives.
    expect(scrubCodes('FILE-NAME stays')).toBe('FILE-NAME stays');
  });
});

describe('tool-card annotation', () => {
  it('labels multi-org calls with every target and the riskiest env role', async () => {
    const world = fakeWorld();
    world.connections.set('c-dev', conn('c-dev', 'dev-org'));
    world.connections.set('c-prod', conn('c-prod', 'client-prod'));
    world.bindings.set('p1', [
      { connectionId: 'c-dev', envRole: 'dev' },
      { connectionId: 'c-prod', envRole: 'prod' },
    ]);
    const run = makeRun(world);
    const target = run.annotateTarget({ connection_a: 'dev-org', connection_b: 'client-prod' });
    expect(target.connection).toBe('dev-org → client-prod');
    expect(target.envRole).toBe('prod');
  });
});

describe('transcript replay (readTranscript)', () => {
  it('parses well-formed lines, skips torn ones, and reports missing files honestly', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { AgentSessionManager } = await import('../main/services/agentRuntime.js');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-transcript-'));
    const transcriptPath = path.join(tmp, 't.jsonl');
    fs.writeFileSync(
      transcriptPath,
      [
        JSON.stringify({ ts: 't', kind: 'session', sessionId: 's1' }),
        JSON.stringify({ ts: 't', kind: 'user', text: 'hello' }),
        JSON.stringify({ ts: 't', kind: 'tool_start', toolUseId: 'tu1', name: 'soql_query', input: '{"connection":"dev"}' }),
        JSON.stringify({ ts: 't', kind: 'tool_end', toolUseId: 'tu1', ok: true }),
        '{"ts":"t","kind":"assistant","text":"thirt', // torn line (crash mid-write)
        JSON.stringify({ ts: 't', kind: 'assistant', text: '13' }),
        JSON.stringify({ ts: 't', kind: 'usage', costUsd: 0.01 }),
      ].join('\n') + '\n',
    );

    const row = {
      id: 's1', projectId: 'p1', title: 'q', status: 'ended', transcriptPath,
      model: 'claude-haiku-4-5', inputTokens: 1, outputTokens: 2, cacheReadTokens: 3,
      costUsd: 0.01, createdAt: 'now', endedAt: 'now',
    };
    const deps = {
      db: {
        reconcileOrphanedAgentSessions: () => 0,
        getAgentSession: (id: string) => (id === 's1' ? row : null),
      },
    } as never;
    const manager = new AgentSessionManager(deps, {} as never, 'unused', () => undefined);

    const t = manager.readTranscript('s1');
    expect(t.missing).toBe(false);
    expect(t.entries.map((e) => e.kind)).toEqual(['user', 'tool_start', 'tool_end', 'assistant']);
    expect(t.entries[1]).toMatchObject({ name: 'soql_query' });

    // No transcript on disk → honest 'missing', never a throw.
    fs.rmSync(transcriptPath);
    expect(manager.readTranscript('s1').missing).toBe(true);
    expect(() => manager.readTranscript('nope')).toThrow(/not found/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('confirmation-code vault (codes never transit the runtime)', () => {
  it('extracts the last code from user text; scrub replaces every one', async () => {
    const { extractConfirmationCode } = await import('../main/services/agentRuntime.js');
    expect(extractConfirmationCode('typo WXYZ-2345, use ABCD-EFGH instead')).toBe('ABCD-EFGH');
    expect(extractConfirmationCode('no codes here')).toBeNull();
    expect(scrubCodes('WXYZ-2345 then ABCD-EFGH')).toBe('[code] then [code]');
  });

  it('substitutes the vaulted code only for write-execute capabilities', async () => {
    const { applyVaultedCode } = await import('../main/services/agentRuntime.js');
    const args: Record<string, unknown> = { connection: 'dev', confirmation_code: '[code]' };
    expect(applyVaultedCode('execute_deploy', args, 'ABCD-EFGH').used).toBe(true);
    expect(args.confirmation_code).toBe('ABCD-EFGH');
    // Read tools never get a code injected, even if the vault is loaded.
    const readArgs: Record<string, unknown> = { connection: 'dev' };
    expect(applyVaultedCode('soql_query', readArgs, 'ABCD-EFGH').used).toBe(false);
    expect('confirmation_code' in readArgs).toBe(false);
    // An empty vault substitutes nothing — the engine refuses with its own message.
    const bare: Record<string, unknown> = { connection: 'dev' };
    expect(applyVaultedCode('dml_execute', bare, null).used).toBe(false);
    expect(bare.confirmation_code).toBeUndefined();
  });
});

describe('native grants editor (ConnectionService.setGrants)', () => {
  it('rejects dependency violations, audits valid changes with before/after', async () => {
    const { ConnectionService } = await import('../main/services/connections.js');
    const rec = conn('c-1', 'dev-org');
    let saved: unknown = null;
    const audits: Array<{ type: string; detail: unknown }> = [];
    const deps = {
      db: {
        resolveConnection: (ref: string) =>
          ref === 'c-1' ? { ...rec, grants: saved ?? rec.grants } : null,
        updateGrants: (_id: string, grants: unknown) => {
          saved = grants;
        },
      },
      audit: {
        record: (type: string, input: { detail?: unknown }) =>
          audits.push({ type, detail: input.detail }),
      },
    } as never;
    const service = new ConnectionService(deps, () => undefined);

    // data_write without data_read violates the engine dependency rule.
    expect(() =>
      service.setGrants('c-1', {
        metadata_read: true,
        metadata_write: false,
        diagnostics_read: false,
        data_read: false,
        data_write: true,
      }),
    ).toThrow(/data_write requires data_read/);
    expect(saved).toBeNull(); // nothing persisted on refusal

    const updated = service.setGrants('c-1', {
      metadata_read: true,
      metadata_write: true,
      diagnostics_read: true,
      data_read: true,
      data_write: false,
    });
    expect(updated.grants.metadata_write).toBe(true);
    expect(audits[0]?.type).toBe('connection.grants_changed');
    expect((audits[0]?.detail as { before: unknown }).before).toBeTruthy();
  });
});
