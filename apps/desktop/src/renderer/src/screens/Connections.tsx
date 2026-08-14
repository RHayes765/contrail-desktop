import type { ConnectionView } from '@contrail/shared';

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

export function ConnectionsScreen({ connections }: { connections: ConnectionView[] | null }) {
  return (
    <>
      <h1>Connections</h1>
      <p className="subtitle">
        Orgs this machine is authorized against. Grants are set by you on the connection page —
        never by the agent.
      </p>
      {connections === null ? (
        <div className="empty">Loading…</div>
      ) : connections.length === 0 ? (
        <div className="empty">
          No orgs connected yet. Connecting arrives with chat in M1 — until then, connections
          made through the Contrail plugin appear here.
        </div>
      ) : (
        <div className="conn-list">
          {connections.map((c) => (
            <div className="conn-card" key={c.id}>
              <span
                className="env-badge"
                style={{ background: ENV_COLORS[c.orgType] ?? 'var(--env-other)' }}
              >
                {c.orgType}
              </span>
              <div className="conn-main">
                <div className="conn-alias">{c.alias}</div>
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
            </div>
          ))}
        </div>
      )}
    </>
  );
}
