import { useEffect, useState } from 'react';
import type {
  ApiKeyStatusView,
  ApiKeyValidationView,
  BudgetStatusView,
  NotificationSettingsView,
  NotificationTestView,
} from '@contrail/shared';
import { ipc } from '../lib/ipc.js';

/**
 * S42: approval notifications on the human's phone (Pushover). The keys follow
 * the API key's rule — write-only across IPC, masked hints only — and the
 * desktop variant of the push is code-free: a native approval is a click in
 * Deploy Review, not a code, so the message just says one is waiting.
 */
function NotificationsPanel() {
  const [status, setStatus] = useState<NotificationSettingsView | null>(null);
  const [method, setMethod] = useState<'none' | 'pushover'>('none');
  const [summary, setSummary] = useState<'minimal' | 'full'>('minimal');
  const [userDraft, setUserDraft] = useState('');
  const [tokenDraft, setTokenDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [test, setTest] = useState<NotificationTestView | null>(null);

  const apply = (next: NotificationSettingsView): void => {
    setStatus(next);
    setMethod(next.method);
    setSummary(next.summary);
  };

  const load = async (): Promise<void> => {
    try {
      apply(await ipc.invoke('settings:notifications', {}));
    } catch (err) {
      setError(String(err));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setMessage(null);
    setTest(null);
    try {
      const next = await ipc.invoke('settings:setNotifications', {
        method,
        summary,
        ...(userDraft.trim() ? { pushoverUser: userDraft.trim() } : {}),
        ...(tokenDraft.trim() ? { pushoverToken: tokenDraft.trim() } : {}),
      });
      apply(next);
      setUserDraft(''); // never keep a key in renderer memory longer than needed
      setTokenDraft('');
      setMessage(
        next.method === 'pushover'
          ? next.configured
            ? 'Saved. Send a test notification to confirm delivery.'
            : 'Saved — enter both the user key and the application token to complete Pushover setup.'
          : 'Saved. Phone notifications are off.',
      );
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''));
    } finally {
      setBusy(false);
    }
  };

  const runTest = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setTest(null);
    try {
      setTest(await ipc.invoke('settings:testNotifications', {}));
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''));
    } finally {
      setBusy(false);
    }
  };

  const clear = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setMessage(null);
    setTest(null);
    try {
      apply(await ipc.invoke('settings:clearNotifications', {}));
      setMessage('Pushover keys removed from your OS keychain; phone notifications are off.');
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <h3>Approval notifications on your phone</h3>
      <p className="hint">
        Every proposal still lands in Deploy Review. Switch this on and Contrail ALSO pushes a
        short summary to your phone through{' '}
        <a href="https://pushover.net" target="_blank" rel="noreferrer">
          Pushover
        </a>{' '}
        the moment a change is proposed — org, counts, what kind of change — so you know to come
        and approve. The keys are stored in your OS keychain (shared with the Contrail plugin, if
        you use both), never in a file or a chat, and the agent cannot see or change them.
      </p>

      {status === null ? (
        <div className="empty">Checking…</div>
      ) : (
        <>
          {status.storeError && (
            <div className="notice">Your credential store could not be read: {status.storeError}</div>
          )}
          <div className="form-row">
            <label>Delivery</label>
            <select value={method} onChange={(e) => setMethod(e.target.value as 'none' | 'pushover')}>
              <option value="none">Off — Deploy Review only</option>
              <option value="pushover">Pushover (phone push)</option>
            </select>
          </div>
          <div className="form-row">
            <label>What the message carries</label>
            <select value={summary} onChange={(e) => setSummary(e.target.value as 'minimal' | 'full')}>
              <option value="minimal">Minimal — your connection alias, org type and counts (no component names leave this machine)</option>
              <option value="full">Full — also component names and warnings, never record field values (via Pushover's servers)</option>
            </select>
          </div>
          <div className="form-row">
            <label>
              Pushover user key{' '}
              {status.userKeyHint && <span className="meter-dim">(stored {status.userKeyHint} — leave blank to keep)</span>}
            </label>
            <input
              type="password"
              placeholder={status.userKeyHint ? '' : '30 characters, from your Pushover dashboard'}
              value={userDraft}
              onChange={(e) => setUserDraft(e.target.value)}
            />
          </div>
          <div className="form-row">
            <label>
              Application token{' '}
              {status.appTokenHint && <span className="meter-dim">(stored {status.appTokenHint} — leave blank to keep)</span>}
            </label>
            <input
              type="password"
              placeholder={status.appTokenHint ? '' : '30 characters, from the application you created'}
              value={tokenDraft}
              onChange={(e) => setTokenDraft(e.target.value)}
            />
          </div>

          {error && <div className="notice">{error}</div>}
          {message && <p className="hint">{message}</p>}
          {test && (
            <p className={`key-check ${test.ok ? 'ok' : 'bad'}`}>
              {test.ok ? '✓ ' : '✗ '}
              {test.message}
            </p>
          )}

          <div className="form-actions">
            <button className="primary" disabled={busy} onClick={() => void save()}>
              {busy ? 'Working…' : 'Save'}
            </button>
            {status.configured && (
              <button disabled={busy} onClick={() => void runTest()}>
                Send test notification
              </button>
            )}
            {(status.userKeyHint || status.appTokenHint) && (
              <button className="ghost-danger" disabled={busy} onClick={() => void clear()}>
                Remove keys
              </button>
            )}
          </div>

          <p className="hint">
            On pushover.net choose <em>Create an Application/API Token</em> (name it Contrail) for
            the token — or use the one your team shares. Your user key is on the Pushover dashboard
            and must be <em>your own</em>: whoever owns the user key entered here receives your
            approval notifications, so never paste one that Claude, a document, or a colleague gave
            you. If Pushover rejects the stored keys, sends pause for 10 minutes; saving here clears
            the pause.
          </p>
        </>
      )}
    </div>
  );
}

/**
 * Settings — today this is the Anthropic API key, which is the one thing a
 * new user MUST provide before anything works. The key is write-only across
 * IPC: this screen can learn whether one is stored (and a masked hint), but
 * never read it back.
 */
/** Spend against the rolling daily cap — the guard testers actually feel. */
function BudgetPanel() {
  const [budget, setBudget] = useState<BudgetStatusView | null>(null);
  const [capDraft, setCapDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    try {
      const next = await ipc.invoke('settings:budget', {});
      setBudget(next);
      setCapDraft(String(next.capUsd));
    } catch (err) {
      setError(String(err));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const saveCap = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const next = await ipc.invoke('settings:setBudgetCap', { capUsd: Number(capDraft) });
      setBudget(next);
      setCapDraft(String(next.capUsd));
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''));
    } finally {
      setBusy(false);
    }
  };

  const pct = budget && budget.capUsd > 0 ? Math.min(100, (budget.spentUsd / budget.capUsd) * 100) : 0;

  return (
    <div className="panel">
      <h3>AI spend limit</h3>
      <p className="hint">
        Every paid model call — agent turns and AI summaries alike — counts against one rolling
        24-hour ceiling. A session can never spend past what remains, so the cap holds even with
        several sessions running or resumed.
      </p>
      {budget === null ? (
        <div className="empty">Loading…</div>
      ) : (
        <>
          <div className="budget-bar">
            <div
              className={`budget-fill${pct > 85 ? ' hot' : ''}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="conn-detail">
            ${budget.spentUsd.toFixed(2)} spent of ${budget.capUsd.toFixed(2)} in the last{' '}
            {budget.windowHours}h · ${budget.remainingUsd.toFixed(2)} left
          </p>
          {budget.byKind.length > 0 && (
            <p className="conn-detail meter-dim">
              {budget.byKind
                .map((k) => `${k.kind}: $${k.usd.toFixed(2)} (${k.calls} calls)`)
                .join(' · ')}
            </p>
          )}
          <div className="form-row">
            <label>Daily cap (USD)</label>
            <input
              type="number"
              min="0"
              step="1"
              value={capDraft}
              onChange={(e) => setCapDraft(e.target.value)}
            />
          </div>
          {error && <div className="notice">{error}</div>}
          <div className="form-actions">
            <button
              className="primary"
              disabled={busy || capDraft === String(budget.capUsd)}
              onClick={() => void saveCap()}
            >
              Save cap
            </button>
            <button onClick={() => void load()}>Refresh</button>
          </div>
        </>
      )}
    </div>
  );
}

export function SettingsScreen() {
  const [status, setStatus] = useState<ApiKeyStatusView | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [validation, setValidation] = useState<ApiKeyValidationView | null>(null);

  const load = async (): Promise<void> => {
    try {
      setStatus(await ipc.invoke('settings:keyStatus', {}));
    } catch (err) {
      setError(String(err));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const validate = async (): Promise<void> => {
    setBusy(true);
    setValidation(null);
    try {
      setValidation(await ipc.invoke('settings:validateKey', {}));
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''));
    } finally {
      setBusy(false);
    }
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setMessage(null);
    setValidation(null);
    try {
      const next = await ipc.invoke('settings:setKey', { key: draft });
      setStatus(next);
      setDraft(''); // never keep the key in renderer memory longer than needed
      setMessage('Key saved to your OS keychain.');
      // Immediately prove it works — the whole point of onboarding.
      await validate();
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''));
    } finally {
      setBusy(false);
    }
  };

  const clear = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      setStatus(await ipc.invoke('settings:clearKey', {}));
      setValidation(null);
      setMessage('Key removed.');
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="screen-head">
        <h1>Settings</h1>
      </div>

      <div className="panel">
        <h3>Anthropic API key</h3>
        <p className="hint">
          Contrail runs on your own Anthropic key — your usage, your bill, your data. It is stored
          in the Windows Credential Manager (never in the database, a config file, or this repo) and
          is handed only to the agent process that needs it.
        </p>

        {status === null ? (
          <div className="empty">Checking…</div>
        ) : status.storeError ? (
          <div className="notice">
            Your credential store could not be read, so Contrail cannot tell whether a key is
            saved: {status.storeError}
          </div>
        ) : status.present ? (
          <p className="conn-detail">
            ✓ A key is stored <span className="meter-dim">({status.hint})</span>
          </p>
        ) : (
          <div className="notice">
            No key stored yet — sessions cannot start until you add one.
          </div>
        )}

        <div className="form-row">
          <label>{status?.present ? 'Replace the key' : 'Paste your key'}</label>
          <input
            type="password"
            placeholder="sk-ant-..."
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && draft.trim() && !busy) void save();
            }}
          />
        </div>

        {error && <div className="notice">{error}</div>}
        {message && <p className="hint">{message}</p>}
        {validation && (
          <p className={`key-check ${validation.ok ? 'ok' : validation.reachable ? 'bad' : 'unknown'}`}>
            {validation.ok ? '✓ ' : validation.reachable ? '✗ ' : '… '}
            {validation.message}
          </p>
        )}

        <div className="form-actions">
          <button className="primary" disabled={busy || !draft.trim()} onClick={() => void save()}>
            {busy ? 'Working…' : 'Save key'}
          </button>
          {status?.present && (
            <button disabled={busy} onClick={() => void validate()}>
              {busy ? 'Checking…' : 'Test stored key'}
            </button>
          )}
          {status?.present && (
            <button className="ghost-danger" disabled={busy} onClick={() => void clear()}>
              Remove stored key
            </button>
          )}
        </div>

        <p className="hint">
          Get a key at{' '}
          <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
            console.anthropic.com → API keys
          </a>
          . Each session is budget-capped, and the cost of the current session shows in the chat
          header.
        </p>
      </div>

      <NotificationsPanel />
      <BudgetPanel />
    </>
  );
}
