import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ContrailDb, unmatchedRuleText, type EngineDeps } from '@contrail/engine';
import { ConnectionService } from '../main/services/connections.js';
import {
  freezeNowLabel,
  policiesUnreadableText,
  policyLine,
  policyRequirementLabels,
  policySourceLabel,
} from '../renderer/src/lib/policies.js';
import { ALWAYS_WINDOW, governanceEngine } from './governance-engine.js';

/**
 * S46 (B): the SF Orgs screen shows the policies that apply to each
 * connection — the same report an agent's list_connections carries, from
 * ONE read of config.json's policies through the real engine. Read-only.
 */

let tmp: string;
let db: ContrailDb;
let gov: ReturnType<typeof governanceEngine>;
let service: ConnectionService;

function connection(alias: string, orgType: string, orgId: string): string {
  return db.insertConnection({
    alias,
    instanceUrl: `https://${alias}.example.invalid`,
    loginUrl: 'https://login.example.invalid',
    orgId,
    orgName: alias,
    orgType,
    isSandbox: orgType !== 'production',
    username: null,
    userId: null,
    grants: {
      metadata_read: true,
      metadata_write: true,
      diagnostics_read: false,
      data_read: false,
      data_write: false,
    },
  }).id;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-connpol-'));
  db = new ContrailDb(path.join(tmp, 'test.db'));
  gov = governanceEngine(db, tmp);
  service = new ConnectionService({ db, deploys: gov.engine } as unknown as EngineDeps, () => undefined);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('connections:policies', () => {
  it('reports each connection’s rules from one read, with the source and the unmatched rules', () => {
    gov.config.policies = {
      rules: [
        {
          name: 'acme client',
          match: { connections: ['acme-*'] },
          requireJustification: true,
          requireTicket: true,
          ticketPattern: 'ACME-[0-9]+',
          denyDestructiveMetadata: true,
          minTestLevel: 'RunLocalTests',
          freezeWindows: [ALWAYS_WINDOW],
        },
        { name: 'retired client', match: { connections: ['globex-*'] }, requireTicket: true },
      ],
    };
    const prod = connection('acme-prod', 'production', '00D000000000001AAA');
    const dev = connection('initech-dev', 'developer', '00D000000000002AAA');
    const view = service.policies();
    expect(view.status).toBe('ok');
    expect(view.source).toBe('config');
    expect(view.problem).toBeNull();
    expect(view.unmatchedRuleLines).toEqual([unmatchedRuleText('retired client')]);
    const p = view.byConnection[prod]!;
    expect(p).toMatchObject({
      rules: ['acme client'],
      requiresJustification: true,
      requiresTicket: true,
      ticketPatterns: ['ACME-[0-9]+'],
      denies: ['destructive_metadata'],
      minTestLevel: 'RunLocalTests',
      freezeNow: { rule: 'acme client', window: 'always' },
    });
    expect(p.freezeWindows).toHaveLength(1);
    expect(view.byConnection[dev]).toMatchObject({ rules: [], freezeNow: null });

    // The card's wording.
    expect(policyLine(p)).toBe(
      'Policy "acme client" — justification required · ticket required · ticket must match ' +
        'ACME-[0-9]+ · destructive metadata changes denied · deploys need test_level RunLocalTests ' +
        `or stricter · freeze window "always": ${p.freezeWindows[0]!.when} UTC`,
    );
    expect(policyRequirementLabels(view.byConnection[dev]!)).toEqual([]);
    expect(policyLine(view.byConnection[dev]!)).toBeNull();
    expect(freezeNowLabel(p)).toMatch(/^CHANGE FREEZE in effect \("always", rule "acme client"\) until /);
    expect(freezeNowLabel(view.byConnection[dev]!)).toBeNull();
    expect(policySourceLabel('config')).toBe('from config.json');
  });

  it('a data-delete rule says which proposals it covers — never "data deletes denied" on its own', () => {
    // The engine refuses deletes only in dml_propose and bulk_load_propose;
    // anonymous Apex is not inspected (its own policy line says so).
    gov.config.policies = {
      rules: [
        { name: 'acme deletes', match: { connections: ['acme-*'] }, denyDataDeletes: true, denyAnonymousApex: true },
      ],
    };
    const conn = connection('acme-uat', 'sandbox', '00D000000000006AAA');
    const p = service.policies().byConnection[conn]!;
    expect(p.denies).toEqual(['data_deletes', 'anonymous_apex']);
    const label =
      'data deletes via dml_propose / bulk_load_propose denied (anonymous Apex not inspected)';
    expect(policyRequirementLabels(p)).toEqual([label, 'anonymous Apex denied']);
    expect(policyLine(p)).toBe(`Policy "acme deletes" — ${label} · anonymous Apex denied`);
  });

  it("the built-in rule says so, and covers production and unknown connections", () => {
    gov.engine.setPolicySource(() => ({
      ok: true,
      policies: gov.config.policies,
      source: 'default',
    }));
    const prod = connection('client-prod', 'production', '00D000000000003AAA');
    const sandbox = connection('client-uat', 'sandbox', '00D000000000004AAA');
    const view = service.policies();
    expect(view.source).toBe('default');
    expect(policySourceLabel(view.source)).toBe(
      "Contrail's built-in default — config.json has no policies section",
    );
    expect(view.byConnection[prod]!.requiresJustification).toBe(true);
    expect(view.byConnection[sandbox]!.rules).toEqual([]);
  });

  it('unreadable policies: no per-connection policy, the problem said, and what that refuses', () => {
    gov.engine.setPolicySource(() => ({ ok: false, problem: 'policies.rules[0]: unknown key "requireTickets"' }));
    connection('acme-prod', 'production', '00D000000000005AAA');
    const view = service.policies();
    expect(view).toEqual({
      status: 'unreadable',
      source: null,
      problem: 'policies.rules[0]: unknown key "requireTickets"',
      unmatchedRuleLines: [],
      byConnection: {},
    });
    expect(policiesUnreadableText(view.problem!)).toBe(
      'The policies in config.json could not be read, so every write proposal and every agent ' +
        'test-run start is refused until the file is fixed: policies.rules[0]: unknown key "requireTickets"',
    );
  });
});
