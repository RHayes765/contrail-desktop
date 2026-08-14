import { useEffect, useState } from 'react';
import type { ConnectionView } from '@contrail/shared';
import { useConnections } from '../stores/connections.js';

const ENV_COLORS: Record<string, string> = {
  production: 'var(--env-production)',
  sandbox: 'var(--env-sandbox)',
  developer: 'var(--env-developer)',
  scratch: 'var(--env-scratch)',
};

const GRANT_LABELS: Array<[keyof ConnectionView['grants'], string]> = [
  ['metadata_read', 'M-R'],
  ['metadata_write', 'M-W'],
  ['diagnostics_read', 'Diag'],
  ['data_read', 'D-R'],
  ['data_write', 'D-W'],
];

function ConnectForm({ onDone }: { onDone: () => void }) {
  const { connect, connecting } = useConnections();
  const [login, setLogin] = useState<'production' | 'sandbox' | 'custom'>('sandbox');
  const [customHost, setCustomHost] = useState('');
  const [label, setLabel] = useState('');

  const submit = async () => {
    const loginValue = login === 'custom' ? customHost.trim() : login;
    if (login === 'custom' && !loginValue) return;
    await connect(loginValue || undefined, label.trim() || undefined);
    onDone();
  };

  return (
    <div className="panel connect-form">
      <div className="form-row">
        <label>Login endpoint</label>
        <div className="seg">
          {(['sandbox', 'production', 'custom'] as const).map((opt) => (
            <button
              key={opt}
              className={login === opt ? 'on' : ''}
              onClick={() => setLogin(opt)}
            >
              {opt === 'custom' ? 'My Domain…' : opt}
            </button>
          ))}
        </div>
      </div>
      {login === 'custom' && (
        <div className="form-row">
          <label>My Domain host</label>
          <input
            placeholder="acme--uat.sandbox.my.salesforce.com"
            value={customHost}
            onChange={(e) => setCustomHost(e.target.value)}
          />
        </div>
      )}
      <div className="form-row">
        <label>Label (optional — reuse an existing label to re-authorize it)</label>
        <input
          placeholder="client-uat"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
      </div>
      <div className="form-actions">
        <button className="primary" disabled={connecting} onClick={() => void submit()}>
          {connecting ? 'Opening browser…' : 'Open Salesforce login'}
        </button>
      </div>
      <p className="hint">
        Your browser opens for login; you set the five grants on the Contrail page afterwards.
        Grants are never chosen by the agent.
      </p>
    </div>
  );
}

export function ConnectionsScreen() {
  const { connections, pings, connectMessage, refresh, ping, remove, clearConnectMessage } =
    useConnections();
  const [showConnect, setShowConnect] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <>
      <div className="screen-head">
        <div>
          <h1>Connections</h1>
          <p className="subtitle">
            Orgs this machine is authorized against. Grants are set by you on the connection page —
            never by the agent.
          </p>
        </div>
        <button className="primary" onClick={() => setShowConnect((v) => !v)}>
          {showConnect ? 'Close' : 'Connect an org'}
        </button>
      </div>

      {showConnect && <ConnectForm onDone={() => undefined} />}

      {connectMessage && (
        <div className="notice" onClick={clearConnectMessage}>
          {connectMessage}
        </div>
      )}

      {connections === null ? (
        <div className="empty">Loading…</div>
      ) : connections.length === 0 ? (
        <div className="empty">No orgs connected yet. Use “Connect an org” to add the first one.</div>
      ) : (
        <div className="conn-list">
          {connections.map((c) => {
            const pingResult = pings[c.id];
            return (
              <div className="conn-card" key={c.id}>
                <span
                  className="env-badge"
                  style={{ background: ENV_COLORS[c.orgType] ?? 'var(--env-other)' }}
                >
                  {c.orgType}
                </span>
                <div className="conn-main">
                  <div className="conn-alias">
                    {c.alias}
                    {pingResult && (
                      <span className={`ping-badge ${pingResult.status}`}>
                        {pingResult.status === 'ok' ? 'token ok' : pingResult.status}
                      </span>
                    )}
                  </div>
                  <div className="conn-detail">
                    {c.orgName ?? 'unnamed org'} · {c.username ?? 'unknown user'} · {c.instanceUrl}
                  </div>
                </div>
                <div className="grant-badges">
                  {GRANT_LABELS.map(([key, label]) => (
                    <span key={key} className={`grant${c.grants[key] ? ' on' : ''}`}>
                      {label}
                    </span>
                  ))}
                </div>
                <div className="row-actions">
                  <button onClick={() => void ping(c.id)}>Check</button>
                  {confirmRemove === c.id ? (
                    <>
                      <button
                        className="danger"
                        onClick={() => {
                          setConfirmRemove(null);
                          void remove(c.id);
                        }}
                      >
                        Really disconnect
                      </button>
                      <button onClick={() => setConfirmRemove(null)}>Keep</button>
                    </>
                  ) : (
                    <button onClick={() => setConfirmRemove(c.id)}>Disconnect</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
