import {
  deleteSecret,
  readSecretResult,
  writeSecret,
  type EngineDeps,
} from '@contrail/engine';
import type { ApiKeyStatusView, ApiKeyValidationView } from '@contrail/shared';

/**
 * A GET that AUTHENTICATES without spending: listing models proves the key is
 * accepted and costs no tokens, which is exactly what onboarding needs — a
 * real answer without touching the budget.
 */
const MODELS_ENDPOINT = 'https://api.anthropic.com/v1/models';

/**
 * The BYO Anthropic API key. One rule shapes this whole file: the key travels
 * renderer → main and NEVER back. Status carries presence, a masked hint for
 * recognition, and whether the credential store itself is broken — never the
 * value. The key lives only in the OS keychain and in the runtime child's env.
 */

export const API_KEY_SERVICE = 'Contrail Desktop';
export const API_KEY_ACCOUNT = 'anthropic-api-key';

/** "sk-ant-…a1b2" — enough to recognise a key, useless to anyone who sees it. */
function maskHint(key: string): string {
  const tail = key.slice(-4);
  const head = key.slice(0, 7);
  return `${head}…${tail}`;
}

export class SettingsService {
  constructor(private readonly deps: EngineDeps) {}

  keyStatus(): ApiKeyStatusView {
    const result = readSecretResult(API_KEY_SERVICE, API_KEY_ACCOUNT);
    if (!result.ok) {
      // A locked/policy-blocked store is NOT the same as "no key set" — saying
      // so sends the user hunting for a key they already have.
      return { present: false, storeError: result.error, hint: null };
    }
    return {
      present: result.value !== null,
      storeError: null,
      hint: result.value ? maskHint(result.value) : null,
    };
  }

  setKey(rawKey: string): ApiKeyStatusView {
    const key = rawKey.trim();
    if (!key) throw new Error('Paste a key first.');
    // Shape check only — validity is Anthropic's to judge, and a wrong-looking
    // key that actually works must not be refused here.
    if (/\s/.test(key)) {
      throw new Error('That value contains whitespace — paste the key exactly as issued.');
    }
    if (!key.startsWith('sk-')) {
      throw new Error(
        'Anthropic API keys start with "sk-". Copy the key from console.anthropic.com → API keys.',
      );
    }
    writeSecret(API_KEY_SERVICE, API_KEY_ACCOUNT, key);
    // Audited WITHOUT the value; the hint is safe and makes the trail useful.
    this.deps.audit.record('settings.api_key_set', {
      tool: 'desktop_settings_screen',
      outcome: 'success',
      detail: { hint: maskHint(key) },
    });
    return this.keyStatus();
  }

  /**
   * Ask Anthropic whether the STORED key actually works. The key never leaves
   * this method — not into the audit, not into the returned view, not into a
   * log. The three outcomes need three different fixes, so they stay distinct:
   * accepted, rejected (wrong/inactive key), and unreachable (offline/blocked,
   * where the key may be perfectly fine).
   */
  async validateKey(): Promise<ApiKeyValidationView> {
    const stored = readSecretResult(API_KEY_SERVICE, API_KEY_ACCOUNT);
    if (!stored.ok) {
      return {
        ok: false,
        reachable: true,
        status: null,
        message: `Your credential store could not be read: ${stored.error}`,
      };
    }
    if (!stored.value) {
      return { ok: false, reachable: true, status: null, message: 'No key is stored to validate.' };
    }

    let status: number;
    try {
      const res = await fetch(MODELS_ENDPOINT, {
        method: 'GET',
        headers: {
          'x-api-key': stored.value,
          'anthropic-version': '2023-06-01',
        },
      });
      status = res.status;
    } catch {
      // Network failure is NOT a bad key — say so, so the user doesn't go
      // hunting for a replacement they don't need.
      this.deps.audit.record('settings.api_key_validated', {
        tool: 'desktop_settings_screen',
        outcome: 'error',
        detail: { reachable: false },
      });
      return {
        ok: false,
        reachable: false,
        status: null,
        message: 'Could not reach Anthropic (offline or blocked by a network). The key may be fine — try again when connected.',
      };
    }

    const ok = status === 200;
    this.deps.audit.record('settings.api_key_validated', {
      tool: 'desktop_settings_screen',
      outcome: ok ? 'success' : 'refused',
      detail: { status },
    });
    if (ok) {
      return { ok: true, reachable: true, status, message: 'Anthropic accepted this key — you are ready to run sessions.' };
    }
    if (status === 401 || status === 403) {
      return {
        ok: false,
        reachable: true,
        status,
        message: 'Anthropic rejected this key. Check you pasted the whole key and that it is still active in the console.',
      };
    }
    return {
      ok: false,
      reachable: true,
      status,
      message: `Anthropic returned an unexpected status (${status}). Try again shortly.`,
    };
  }

  clearKey(): ApiKeyStatusView {
    deleteSecret(API_KEY_SERVICE, API_KEY_ACCOUNT);
    this.deps.audit.record('settings.api_key_cleared', {
      tool: 'desktop_settings_screen',
      outcome: 'success',
    });
    return this.keyStatus();
  }
}
