import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ContrailDb } from '../core/db.js';
import { MemoryTokenStore } from '../core/keychain.js';
import { DEFAULT_CONFIG, type ContrailConfig } from '../core/config.js';
import { SnapshotStore } from '../snapshot/store.js';
import { ApprovalPageServer } from '../deploy/approval.js';
import { createEngineDeps, type EngineDeps } from '../core/deps.js';
import { invokeCapability, type ToolResult } from '../capabilities/index.js';
import { apexScratchName } from '../localdiag/runner.js';
import type {
  ApexSourceKind,
  LocalDiagResult,
  LocalDiagRunner,
  UnavailableCode,
} from '../localdiag/types.js';

/**
 * S26 capability-surface tests (desktop mirror of the plugin's
 * localdiag.test.ts) with a FAKE runner injected through createEngineDeps —
 * plus the pin the desktop uniquely needs: the ENGINE DEFAULT runner has no
 * vendored bundles and must answer not_installed honestly, because only the
 * app's bootstrap injects the real @contrail/apex-ls wiring.
 */

let tmp: string;
let db: ContrailDb;
let deps: EngineDeps;
let fake: {
  apexCalls: Array<{ source: string; kind: ApexSourceKind }>;
  soqlCalls: string[];
  nextApex: LocalDiagResult;
  nextSoql: LocalDiagResult;
};

function fakeRunner(): LocalDiagRunner {
  return {
    async checkApex(source, kind) {
      fake.apexCalls.push({ source, kind });
      return fake.nextApex;
    },
    async checkSoql(query) {
      fake.soqlCalls.push(query);
      return fake.nextSoql;
    },
    async shutdown() {},
  };
}

function textOf(result: ToolResult): string {
  return result.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
}

function makeDeps(localDiag?: LocalDiagRunner): EngineDeps {
  const config: ContrailConfig = {
    ...DEFAULT_CONFIG,
    salesforce: { ...DEFAULT_CONFIG.salesforce },
  };
  return createEngineDeps({
    db,
    tokens: new MemoryTokenStore(),
    config,
    store: new SnapshotStore(path.join(tmp, 'snapshots')),
    approvals: new ApprovalPageServer(async () => {}),
    ...(localDiag ? { localDiag } : {}),
    flowOps: { openBrowser: async () => {} },
  });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-ld-'));
  process.env.CONTRAIL_DATA_DIR = tmp;
  db = new ContrailDb(path.join(tmp, 'test.db'));
  fake = {
    apexCalls: [],
    soqlCalls: [],
    nextApex: { checked: true, diagnostics: [] },
    nextSoql: { checked: true, diagnostics: [] },
  };
  deps = makeDeps(fakeRunner());
});

afterEach(() => {
  db.close();
  delete process.env.CONTRAIL_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('check_apex / check_soql capability surface', () => {
  it('renders diagnostics with honest counts, defaulting the kind to class', async () => {
    fake.nextApex = {
      checked: true,
      diagnostics: [
        { severity: 'error', line: 2, column: 10, message: "missing ';' at '}'", code: 'missing.syntax' },
        { severity: 'warning', line: 4, column: 1, message: 'unused variable', code: 'unused.variable' },
      ],
    };
    const result = await invokeCapability(deps, 'check_apex', { code: 'public class X {}' });
    const body = JSON.parse(textOf(result)) as Record<string, unknown>;
    expect(result.isError ?? false).toBe(false);
    expect(body.error_count).toBe(1);
    expect(body.warning_count).toBe(1);
    expect(fake.apexCalls).toEqual([{ source: 'public class X {}', kind: 'class' }]);
  });

  it('every unavailable code is a structured SUCCESS carrying the fail-closed doctrine', async () => {
    const codes: UnavailableCode[] = [
      'disabled',
      'not_installed',
      'spawn_timeout',
      'check_timeout',
      'server_error',
    ];
    for (const code of codes) {
      fake.nextApex = { checked: false, unavailable: code, detail: `because ${code}` };
      const result = await invokeCapability(deps, 'check_apex', { code: 'public class X {}' });
      expect(result.isError ?? false, code).toBe(false);
      const text = textOf(result);
      expect(text).toContain(`check_apex=unavailable: ${code}`);
      expect(text).toContain('NOT checked');
    }
  });

  it('semantic findings carry the advisory note; pure syntax results do not', async () => {
    fake.nextApex = {
      checked: true,
      diagnostics: [{ severity: 'error', line: 1, column: 1, message: 'x', code: 'missing.syntax' }],
    };
    const syntaxOnly = JSON.parse(
      textOf(await invokeCapability(deps, 'check_apex', { code: 'x' })),
    ) as Record<string, unknown>;
    expect(syntaxOnly.note).toBeUndefined();

    fake.nextApex = {
      checked: true,
      diagnostics: [
        { severity: 'error', line: 1, column: 1, message: 'y', code: 'variable.does.not.exist' },
      ],
    };
    const semantic = JSON.parse(
      textOf(await invokeCapability(deps, 'check_apex', { code: 'x' })),
    ) as Record<string, unknown>;
    expect(String(semantic.note)).toContain('validate_deploy as the authority');
  });

  it('THE HONESTY DEFAULT: engine deps without an injected runner answer not_installed', async () => {
    const bare = makeDeps(); // no localDiag override — the engine default
    const result = await invokeCapability(bare, 'check_apex', { code: 'public class X {}' });
    expect(result.isError ?? false).toBe(false);
    expect(textOf(result)).toContain('check_apex=unavailable: not_installed');
    await bare.localDiag.shutdown();
  });

  it('refuses empty and over-cap inputs before touching the runner', async () => {
    const empty = await invokeCapability(deps, 'check_apex', { code: '   ' });
    expect(empty.isError).toBe(true);
    const overCap = await invokeCapability(deps, 'check_soql', { query: 'x'.repeat(50_001) });
    expect(overCap.isError).toBe(true);
    expect(fake.apexCalls).toHaveLength(0);
    expect(fake.soqlCalls).toHaveLength(0);
  });
});

describe('apexScratchName', () => {
  it('derives the filename from the DECLARED type name', () => {
    expect(apexScratchName('public class InvoiceService {}', 'class')).toBe('InvoiceService.cls');
    expect(apexScratchName('trigger Guard on Account (before insert) {}', 'trigger')).toBe(
      'Guard.trigger',
    );
    expect(apexScratchName("System.debug('x');", 'anonymous')).toBe('__anon__.apex');
  });
});
