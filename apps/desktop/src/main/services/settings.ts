import {
  deleteSecret,
  readSecretResult,
  writeSecret,
  type EngineDeps,
} from '@contrail/engine';
import type { ApiKeyStatusView } from '@contrail/shared';

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

  clearKey(): ApiKeyStatusView {
    deleteSecret(API_KEY_SERVICE, API_KEY_ACCOUNT);
    this.deps.audit.record('settings.api_key_cleared', {
      tool: 'desktop_settings_screen',
      outcome: 'success',
    });
    return this.keyStatus();
  }
}
