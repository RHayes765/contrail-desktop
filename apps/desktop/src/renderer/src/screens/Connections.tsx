import { useEffect, useState } from 'react';
import type { ConnectionView, GrantSetView } from '@contrail/shared';
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

const GRANT_FULL_LABELS: Array<[keyof GrantSetView, string]> = [
  ['metadata_read', 'Metadata read'],
  ['metadata_write', 'Metadata write (deploys)'],
  ['diagnostics_read', 'Diagnostics read (logs)'],
  ['data_read', 'Data read (SOQL)'],
  ['data_write', 'Data write (DML)'],
];

/** write → its required read (mirrors the engine's GRANT_DEPENDENCIES). */
const REQUIRES: Partial<Record<keyof GrantSetView, keyof GrantSetView>> = {
  metadata_write: 'metadata_read',
  data_write: 'data_read',
};

function GrantsEditor({
  connection,
  onDone,
}: {
  connection: ConnectionView;
  onDone: () => void;
}) {
  const { setGrants } = useConnections();
  const [draft, setDraft] = useState<GrantSetView>({ ...connection.grants });
  const [saving, setSaving] = useState(false);

  const toggle = (key: keyof GrantSetView) => {
    setDraft((d) => {
      const next = { ...d, [key]: !d[key] };
      if (next[key]) {
        // Enabling a write pulls in its required read.
        const required = REQUIRES[key];
        if (required) next[required] = true;
      } else {
        // Disabling a read drops any write that depends on it.
        for (const [dependent, required] of Object.entries(REQUIRES) as Array<
          [keyof GrantSetView, keyof GrantSetView]
        >) {
          if (required === key) next[dependent] = false;
        }
      }
      return next;
    });
  };

  const dirty = GRANT_FULL_LABELS.some(([key]) => draft[key] !== connection.grants[key]);

  return (
    <div className="grants-editor">
      {GRANT_FULL_LABELS.map(([key, label]) => (
        <label key={key} className="grant-toggle">
          <input type="checkbox" checked={draft[key]} onChange={() => toggle(key)} />
          <span>{label}</span>
        </label>
      ))}
      <div className="form-actions">
        <button
          className="primary"
          disabled={!dirty || saving}
          onClick={() => {
            setSaving(true);
            void setGrants(connection.id, draft).then((ok) => {
              setSaving(false);
              if (ok) onDone();
            });
          }}
        >
          {saving ? 'Saving…' : 'Save grants'}
        </button>
        <button onClick={onDone}>Cancel</button>
        <span className="hint" style={{ margin: 0 }}>
          Changes apply to running sessions on their next tool call.
        </span>
      </div>
    </div>
  );
}

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
  const [editingGrants, setEditingGrants] = useState<string | null>(null);

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
              <div className="conn-card-wrap" key={c.id}>
                <div className="conn-card">
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
                    <button
                      onClick={() => setEditingGrants(editingGrants === c.id ? null : c.id)}
                    >
                      {editingGrants === c.id ? 'Close' : 'Grants'}
                    </button>
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
                {editingGrants === c.id && (
                  <GrantsEditor connection={c} onDone={() => setEditingGrants(null)} />
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
