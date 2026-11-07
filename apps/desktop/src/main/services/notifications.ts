import {
  NOTIFY_ACCOUNTS,
  PUSHOVER_KEY_RE,
  saveConfigSection,
  type EngineDeps,
  type NotifyMethod,
  type NotifySummary,
} from '@contrail/engine';
import type { NotificationSettingsView, NotificationTestView } from '@contrail/shared';

/**
 * S42: approval notifications on the human's phone — the desktop's native
 * Settings surface for what the plugin exposes on its localhost Settings page.
 *
 * The same rule as the API key shapes this file: the Pushover user key and
 * application token travel renderer → main and NEVER back. Status carries
 * presence and a masked tail; audit rows carry booleans. The keys live in the
 * engine's keychain store (service `contrail-engine`, `notify:` accounts) so
 * ONE entry serves the desktop app and the companion plugin — they share the
 * data dir by design, and a code pushed by either surface reads the same keys.
 *
 * Method and depth live in config.json (shared too), written through the
 * engine's section writer and patched into the LIVE config object so the
 * running engine honours the change on its next proposal.
 */

function maskHint(value: string | null): string | null {
  return value ? `…${value.slice(-4)}` : null;
}

export interface NotificationSettingsInput {
  method: NotifyMethod;
  summary: NotifySummary;
  pushoverUser?: string;
  pushoverToken?: string;
}

export class NotificationSettingsService {
  constructor(private readonly deps: EngineDeps) {}

  status(): NotificationSettingsView {
    // The notifier's status() folds the on-disk section into the live config
    // first, so a change saved on the plugin's Settings page shows here.
    this.deps.notifier.status();
    let user: string | null = null;
    let token: string | null = null;
    let storeError: string | null = null;
    try {
      user = this.deps.tokens.getSecret(NOTIFY_ACCOUNTS.pushoverUser);
      token = this.deps.tokens.getSecret(NOTIFY_ACCOUNTS.pushoverToken);
    } catch (err) {
      storeError = String(err instanceof Error ? err.message : err);
    }
    return {
      method: this.deps.config.notifications.method,
      summary: this.deps.config.notifications.summary,
      configured: user !== null && token !== null,
      userKeyHint: maskHint(user),
      appTokenHint: maskHint(token),
      storeError,
    };
  }

  set(input: NotificationSettingsInput): NotificationSettingsView {
    const user = (input.pushoverUser ?? '').trim();
    const token = (input.pushoverToken ?? '').trim();
    // Blank = keep what is stored; the UI never echoes a stored value, so the
    // human is not asked to retype keys to change the method.
    if (user && !PUSHOVER_KEY_RE.test(user)) {
      throw new Error('The user key must be exactly 30 letters and digits — copy it from your Pushover dashboard.');
    }
    if (token && !PUSHOVER_KEY_RE.test(token)) {
      throw new Error('The application token must be exactly 30 letters and digits — from the application you created on pushover.net.');
    }
    if (user) this.deps.tokens.setSecret(NOTIFY_ACCOUNTS.pushoverUser, user);
    if (token) this.deps.tokens.setSecret(NOTIFY_ACCOUNTS.pushoverToken, token);
    saveConfigSection('notifications', { method: input.method, summary: input.summary });
    this.deps.config.notifications.method = input.method;
    this.deps.config.notifications.summary = input.summary;
    this.deps.notifier.resetCircuit();
    this.deps.audit.record('settings.notifications_changed', {
      tool: 'desktop_settings_screen',
      outcome: 'success',
      detail: {
        method: input.method,
        summary: input.summary,
        user_key_set: Boolean(user),
        token_set: Boolean(token),
      },
    });
    return this.status();
  }

  clear(): NotificationSettingsView {
    this.deps.tokens.deleteSecret(NOTIFY_ACCOUNTS.pushoverUser);
    this.deps.tokens.deleteSecret(NOTIFY_ACCOUNTS.pushoverToken);
    saveConfigSection('notifications', { method: 'none' });
    this.deps.config.notifications.method = 'none';
    this.deps.notifier.resetCircuit();
    this.deps.audit.record('settings.notifications_changed', {
      tool: 'desktop_settings_screen',
      outcome: 'success',
      detail: { method: 'none', cleared: true },
    });
    return this.status();
  }

  async test(): Promise<NotificationTestView> {
    const result = await this.deps.notifier.sendTest();
    this.deps.audit.record('settings.notifications_tested', {
      tool: 'desktop_settings_screen',
      outcome: result.ok ? 'success' : 'error',
      detail: { ok: result.ok },
    });
    return result;
  }
}
