import { useEffect, useState } from 'react';
import type { ApiKeyStatusView } from '@contrail/shared';
import { ipc } from '../lib/ipc.js';

/**
 * Settings — today this is the Anthropic API key, which is the one thing a
 * new user MUST provide before anything works. The key is write-only across
 * IPC: this screen can learn whether one is stored (and a masked hint), but
 * never read it back.
 */
export function SettingsScreen() {
  const [status, setStatus] = useState<ApiKeyStatusView | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const next = await ipc.invoke('settings:setKey', { key: draft });
      setStatus(next);
      setDraft(''); // never keep the key in renderer memory longer than needed
      setMessage('Key saved to your OS keychain. New sessions will use it.');
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

        <div className="form-actions">
          <button className="primary" disabled={busy || !draft.trim()} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save key'}
          </button>
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
    </>
  );
}
