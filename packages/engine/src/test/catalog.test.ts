import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ContrailDb } from '../core/db.js';
import {
  STANDARD_CATALOG,
  catalogCoverageViolations,
  catalogKeyFor,
  externalServerKey,
  serverEnabled,
} from '../capabilities/catalog.js';
import { allCapabilities } from '../capabilities/index.js';

/**
 * The capability catalog (spec §6) and per-project server toggles. The
 * coverage tripwire is the load-bearing test: a new capability that never
 * lands in a catalog family would be un-toggleable — minted always.
 */

describe('standard catalog (THE family tripwire)', () => {
  it('covers every grant-bearing capability exactly once, and nothing else', () => {
    expect(catalogCoverageViolations()).toEqual([]);
  });

  it('is exactly the five spec families', () => {
    expect(STANDARD_CATALOG.map((e) => e.key)).toEqual([
      'metadata',
      'describe',
      'data',
      'debug-logs',
      'deploy',
    ]);
  });

  it('maps write-class capabilities to the families the spec names', () => {
    expect(catalogKeyFor('execute_deploy')).toBe('deploy');
    expect(catalogKeyFor('dml_execute')).toBe('data');
    expect(catalogKeyFor('soql_query')).toBe('data');
    expect(catalogKeyFor('get_debug_logs')).toBe('debug-logs');
    expect(catalogKeyFor('describe_schema')).toBe('describe');
    expect(catalogKeyFor('diff_orgs')).toBe('metadata');
  });

  it('lifecycle capabilities are uncataloged (never toggleable)', () => {
    for (const cap of allCapabilities()) {
      if (cap.grant === null) expect(catalogKeyFor(cap.name)).toBeNull();
    }
  });
});

describe('serverEnabled defaults', () => {
  it('standard families default ON; an explicit row wins', () => {
    expect(serverEnabled([], 'metadata')).toBe(true);
    expect(serverEnabled([{ serverKey: 'metadata', enabled: false }], 'metadata')).toBe(false);
  });

  it('external servers default OFF per project — enable is an explicit act', () => {
    const key = externalServerKey('abc-123');
    expect(serverEnabled([], key)).toBe(false);
    expect(serverEnabled([{ serverKey: key, enabled: true }], key)).toBe(true);
  });
});

describe('toggle + custom server storage', () => {
  let tmp: string;
  let db: ContrailDb;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-catalog-'));
    db = new ContrailDb(path.join(tmp, 'test.db'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('toggles upsert per (project, server) and never leak across projects', () => {
    db.setServerToggle('p1', 'deploy', false);
    db.setServerToggle('p1', 'deploy', true);
    db.setServerToggle('p1', 'deploy', false);
    db.setServerToggle('p2', 'deploy', true);
    expect(db.getServerToggles('p1')).toEqual([{ serverKey: 'deploy', enabled: false }]);
    expect(db.getServerToggles('p2')).toEqual([{ serverKey: 'deploy', enabled: true }]);
    expect(db.getServerToggles('p3')).toEqual([]);
  });

  it('refuses empty project or server keys — no NULL-project rows, ever', () => {
    expect(() => db.setServerToggle('', 'deploy', true)).toThrow(/project id/);
    expect(() => db.setServerToggle('p1', '', true)).toThrow(/server key/);
  });

  it('custom servers register independent-auth, ENABLED, and not project-default', () => {
    const s = db.addCustomMcpServer({
      name: 'Echo',
      transport: 'stdio',
      urlOrCommand: 'node',
      config: { args: ['echo.mjs'] },
    });
    expect(s.authMode).toBe('independent');
    // Registering a connector means you want it available — a dead switch
    // right after "save" read as a bug (S12 feedback). Availability is the
    // global gate; which PROJECTS see it stays opt-in via defaultOn/toggles.
    expect(s.enabled).toBe(true);
    expect(s.defaultOn).toBe(false);
    expect(db.listCustomMcpServers()).toHaveLength(1);

    const updated = db.updateCustomMcpServer(s.id, { enabled: true, name: 'Echo 2' });
    expect(updated?.enabled).toBe(true);
    expect(updated?.name).toBe('Echo 2');
    expect(updated?.config.args).toEqual(['echo.mjs']);
  });

  it('removing a server also removes its per-project toggle rows', () => {
    const s = db.addCustomMcpServer({ name: 'X', transport: 'http', urlOrCommand: 'https://x' });
    db.setServerToggle('p1', externalServerKey(s.id), true);
    db.removeCustomMcpServer(s.id);
    expect(db.listCustomMcpServers()).toEqual([]);
    expect(db.getServerToggles('p1')).toEqual([]);
  });

  it('survives unreadable config_json as empty extras', () => {
    const s = db.addCustomMcpServer({ name: 'Y', transport: 'stdio', urlOrCommand: 'node' });
    // simulate a hand-edited row
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).db
      .prepare(`UPDATE custom_mcp_servers SET config_json = 'not json' WHERE id = ?`)
      .run(s.id);
    expect(db.getCustomMcpServer(s.id)?.config).toEqual({});
  });
});

describe('per-connector project defaults (v12)', () => {
  const key = externalServerKey('srv-1');

  it('an external server with defaultOn joins projects that never chose', () => {
    expect(serverEnabled([], key, true)).toBe(true);
    expect(serverEnabled([], key, false)).toBe(false);
  });

  it('an explicit per-project toggle ALWAYS beats the connector default', () => {
    // Project said no — a Slack-style always-on connector stays out.
    expect(serverEnabled([{ serverKey: key, enabled: false }], key, true)).toBe(false);
    // Project said yes — a Jira-style opt-in connector comes in.
    expect(serverEnabled([{ serverKey: key, enabled: true }], key, false)).toBe(true);
  });

  it('standard families ignore the external default entirely', () => {
    // Passing true must not "default on" a standard family that was never
    // standard, and passing false must not disable one that is.
    expect(serverEnabled([], 'metadata', false)).toBe(true);
    expect(serverEnabled([], 'not-a-family', true)).toBe(true); // external-ish key honors it
  });
});
