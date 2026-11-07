import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_CONFIG,
  MemoryTokenStore,
  NOTIFY_ACCOUNTS,
  loadConfig,
  type ApprovalNotifier,
  type ContrailConfig,
  type EngineDeps,
  type NotifyOutcome,
} from '@contrail/engine';
import { NotificationSettingsService } from '../main/services/notifications.js';

/**
 * S42: the Pushover keys are WRITE-ONLY across IPC, like the API key. These
 * pin that the status view, the audit trail and error messages never carry a
 * key; that a save reaches the keychain, config.json AND the live config; and
 * that the service goes through the engine's shared notifier (so the circuit
 * breaker resets and the test button sends through the same client the engine
 * uses at mint time).
 */

const USER = 'U'.repeat(30);
const TOKEN = 'T'.repeat(30);

class FakeNotifier implements ApprovalNotifier {
  tests = 0;
  resets = 0;
  async notify(): Promise<NotifyOutcome> {
    return { status: 'off' };
  }
  async sendTest() {
    this.tests += 1;
    return { ok: true, message: 'Test notification sent to pixel. Check your phone.' };
  }
  status() {
    return { method: 'pushover' as const, configured: true };
  }
  resetCircuit() {
    this.resets += 1;
  }
}

let tmp: string;
let tokens: MemoryTokenStore;
let config: ContrailConfig;
let notifier: FakeNotifier;
let audits: Array<{ event: string; detail: unknown }>;
let svc: NotificationSettingsService;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-notif-'));
  process.env.CONTRAIL_DATA_DIR = tmp;
  tokens = new MemoryTokenStore();
  config = { ...DEFAULT_CONFIG, notifications: { ...DEFAULT_CONFIG.notifications } };
  notifier = new FakeNotifier();
  audits = [];
  const deps = {
    tokens,
    config,
    notifier,
    audit: {
      record: (event: string, input?: { detail?: unknown }) => audits.push({ event, detail: input?.detail }),
    },
  } as unknown as EngineDeps;
  svc = new NotificationSettingsService(deps);
});

afterEach(() => {
  delete process.env.CONTRAIL_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('keys never come back', () => {
  it('status carries hints only, and audit rows carry booleans only', () => {
    svc.set({ method: 'pushover', summary: 'full', pushoverUser: USER, pushoverToken: TOKEN });
    const status = svc.status();
    expect(status.configured).toBe(true);
    expect(status.userKeyHint).toBe('…UUUU');
    expect(status.appTokenHint).toBe('…TTTT');
    const text = JSON.stringify({ status, audits });
    expect(text).not.toContain(USER);
    expect(text).not.toContain(TOKEN);
    expect(audits.at(-1)).toEqual({
      event: 'settings.notifications_changed',
      detail: { method: 'pushover', summary: 'full', user_key_set: true, token_set: true },
    });
  });

  it('a malformed key is refused without touching anything, and the error carries no value', () => {
    expect(() => svc.set({ method: 'pushover', summary: 'minimal', pushoverUser: 'nope' })).toThrow(
      /30 letters and digits/,
    );
    expect(tokens.getSecret(NOTIFY_ACCOUNTS.pushoverUser)).toBeNull();
    expect(config.notifications.method).toBe('none');
    expect(audits).toHaveLength(0);
  });
});

describe('where the settings land', () => {
  it('keys → the engine keychain store under notify: accounts (shared with the plugin)', () => {
    svc.set({ method: 'pushover', summary: 'minimal', pushoverUser: USER, pushoverToken: TOKEN });
    expect(tokens.getSecret(NOTIFY_ACCOUNTS.pushoverUser)).toBe(USER);
    expect(tokens.getSecret(NOTIFY_ACCOUNTS.pushoverToken)).toBe(TOKEN);
  });

  it('method/summary → config.json on disk AND the live config object; the circuit resets', () => {
    svc.set({ method: 'pushover', summary: 'full' });
    expect(config.notifications).toEqual({ method: 'pushover', summary: 'full' });
    expect(loadConfig().notifications).toEqual({ method: 'pushover', summary: 'full' });
    expect(notifier.resets).toBe(1);
  });

  it('blank key fields keep the stored keys', () => {
    tokens.setSecret(NOTIFY_ACCOUNTS.pushoverUser, USER);
    svc.set({ method: 'pushover', summary: 'minimal', pushoverUser: '', pushoverToken: '   ' });
    expect(tokens.getSecret(NOTIFY_ACCOUNTS.pushoverUser)).toBe(USER);
  });

  it('clear removes both keys and switches delivery off, on disk too', () => {
    svc.set({ method: 'pushover', summary: 'minimal', pushoverUser: USER, pushoverToken: TOKEN });
    const after = svc.clear();
    expect(after.configured).toBe(false);
    expect(after.method).toBe('none');
    expect(tokens.getSecret(NOTIFY_ACCOUNTS.pushoverToken)).toBeNull();
    expect(loadConfig().notifications.method).toBe('none');
  });

  it('test delegates to the shared notifier and audits the outcome only', async () => {
    const result = await svc.test();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('pixel');
    expect(notifier.tests).toBe(1);
    expect(audits.at(-1)).toEqual({ event: 'settings.notifications_tested', detail: { ok: true } });
  });
});
