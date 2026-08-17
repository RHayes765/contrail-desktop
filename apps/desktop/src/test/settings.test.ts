import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineDeps } from '@contrail/engine';

/**
 * The API key is WRITE-ONLY across IPC. These tests pin that: the key goes
 * renderer → keychain and nothing — not the status view, not the audit trail,
 * not an error message — ever carries it back.
 */

const KEY = 'sk-ant-api03-SECRETVALUE-do-not-leak-7f2a';

let store: Map<string, string>;
let storeThrows: Error | null;
let audits: Array<{ event: string; detail: unknown }>;

vi.mock('@contrail/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@contrail/engine')>();
  return {
    ...actual,
    writeSecret: (service: string, account: string, value: string) => {
      store.set(`${service}/${account}`, value);
    },
    deleteSecret: (service: string, account: string) => store.delete(`${service}/${account}`),
    readSecretResult: (service: string, account: string) => {
      if (storeThrows) return { ok: false as const, error: String(storeThrows) };
      return { ok: true as const, value: store.get(`${service}/${account}`) ?? null };
    },
  };
});

const { SettingsService } = await import('../main/services/settings.js');

function makeService() {
  const deps = {
    audit: {
      record: (event: string, input?: { detail?: unknown }) =>
        audits.push({ event, detail: input?.detail }),
    },
  } as unknown as EngineDeps;
  return new SettingsService(deps);
}

beforeEach(() => {
  store = new Map();
  storeThrows = null;
  audits = [];
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('the key never comes back (THE invariant)', () => {
  it('status carries presence and a masked hint, never the key', () => {
    const svc = makeService();
    svc.setKey(KEY);
    const status = svc.keyStatus();
    expect(status.present).toBe(true);
    expect(JSON.stringify(status)).not.toContain(KEY);
    expect(JSON.stringify(status)).not.toContain('SECRETVALUE');
    // The hint is recognisable but useless: head + last 4 only.
    expect(status.hint).toBe('sk-ant-…7f2a');
  });

  it('the audit trail records the hint, never the value', () => {
    const svc = makeService();
    svc.setKey(KEY);
    expect(audits.map((a) => a.event)).toContain('settings.api_key_set');
    expect(JSON.stringify(audits)).not.toContain(KEY);
    expect(JSON.stringify(audits)).toContain('sk-ant-…7f2a');
  });

  it('setKey returns status only — its return value carries no key', () => {
    const svc = makeService();
    const returned = svc.setKey(KEY);
    expect(JSON.stringify(returned)).not.toContain(KEY);
  });
});

describe('storage round-trip', () => {
  it('stores under the service/account the runtime reads', () => {
    makeService().setKey(KEY);
    expect(store.get('Contrail Desktop/anthropic-api-key')).toBe(KEY);
  });

  it('clearKey removes it and reports absent', () => {
    const svc = makeService();
    svc.setKey(KEY);
    const after = svc.clearKey();
    expect(after.present).toBe(false);
    expect(after.hint).toBeNull();
    expect(store.size).toBe(0);
  });
});

describe('input validation refuses paste accidents', () => {
  it('rejects empty, whitespace-bearing, and non-sk values without storing', () => {
    const svc = makeService();
    expect(() => svc.setKey('   ')).toThrow(/paste a key/i);
    expect(() => svc.setKey('sk-ant with a space')).toThrow(/whitespace/i);
    expect(() => svc.setKey('definitely-not-a-key')).toThrow(/start with "sk-"/);
    expect(store.size).toBe(0);
  });

  it('trims surrounding whitespace from an otherwise good paste', () => {
    const svc = makeService();
    svc.setKey(`  ${KEY}\n`);
    expect(store.get('Contrail Desktop/anthropic-api-key')).toBe(KEY);
  });
});

describe('a broken credential store is distinguishable from an empty one', () => {
  it('reports storeError instead of silently claiming no key', () => {
    storeThrows = new Error('The credential store is locked by policy');
    const status = makeService().keyStatus();
    expect(status.present).toBe(false);
    expect(status.storeError).toMatch(/locked by policy/);
  });
});
