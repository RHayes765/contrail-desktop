import { createRequire } from 'node:module';

/**
 * Native-module verification, resolved from the ENGINE's module context —
 * better-sqlite3 and @napi-rs/keyring are this package's dependencies, so a
 * host app (whose own node_modules doesn't contain them under strict pnpm
 * isolation) must probe through here, not with its own require.
 */
const require = createRequire(import.meta.url);

export interface NativeProbe {
  ok: boolean;
  detail: string;
}

export function probeBetterSqlite3(): NativeProbe {
  try {
    const Database = require('better-sqlite3') as typeof import('better-sqlite3');
    const db = new Database(':memory:');
    const row = db.prepare('SELECT sqlite_version() AS v').get() as { v: string };
    db.close();
    return { ok: true, detail: `SQLite ${row.v}` };
  } catch (err) {
    return { ok: false, detail: String(err) };
  }
}

export function probeKeyring(): NativeProbe {
  try {
    // Load only — no keychain entry is read or written.
    const keyring = require('@napi-rs/keyring') as { Entry: unknown };
    return { ok: keyring.Entry != null, detail: 'loaded' };
  } catch (err) {
    return { ok: false, detail: String(err) };
  }
}

// ── generic OS-keychain secrets (e.g. the BYO Anthropic API key) ─────────
// Host apps must go through these helpers: under pnpm strict isolation the
// keyring package resolves only from the engine's own context.

interface KeyringEntry {
  getPassword(): string | null;
  setPassword(value: string): void;
  deletePassword(): boolean;
}

function entry(service: string, account: string): KeyringEntry {
  const { Entry } = require('@napi-rs/keyring') as {
    Entry: new (service: string, account: string) => KeyringEntry;
  };
  return new Entry(service, account);
}

export function readSecret(service: string, account: string): string | null {
  try {
    return entry(service, account).getPassword();
  } catch {
    return null;
  }
}

/**
 * Like readSecret, but distinguishes "nothing stored" from "the credential
 * store itself failed" (locked, policy-blocked, missing service). readSecret
 * collapses both to null, which sends a user hunting for a key they already
 * set — so anything that reports status to a human should use this instead.
 */
export function readSecretResult(
  service: string,
  account: string,
): { ok: true; value: string | null } | { ok: false; error: string } {
  try {
    return { ok: true, value: entry(service, account).getPassword() };
  } catch (err) {
    const message = String(err);
    // @napi-rs/keyring throws "No matching entry found..." for absence, which
    // is a normal empty state rather than a store failure.
    if (/no matching entry|not found|no such/i.test(message)) {
      return { ok: true, value: null };
    }
    return { ok: false, error: message.slice(0, 300) };
  }
}

export function writeSecret(service: string, account: string, value: string): void {
  entry(service, account).setPassword(value);
}

export function deleteSecret(service: string, account: string): boolean {
  try {
    return entry(service, account).deletePassword();
  } catch {
    return false;
  }
}
