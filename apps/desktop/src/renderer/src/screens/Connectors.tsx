import { useEffect, useState } from 'react';
import {
  CONNECTOR_PRESETS,
  OAUTH_LOOPBACK_REDIRECT,
  type ConnectorPresetView,
  type McpServerTestView,
} from '@contrail/shared';
import { useMcp } from '../stores/mcp.js';

/**
 * Global external MCP server registry (auth_mode: independent only).
 * Registering + globally enabling a server makes it AVAILABLE; each project
 * still opts in from its Capabilities tab — servers never flow into an
 * engagement silently.
 */

/**
 * Parse KEY=value / KEY: value lines. Malformed lines are REPORTED, never
 * silently dropped — a pasted "Authorization: Bearer …" header that failed
 * to parse would otherwise surface as an opaque 401 deep inside a session.
 */
function parseKeyValues(text: string): { values?: Record<string, string>; bad: string[] } {
  const out: Record<string, string> = {};
  const bad: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    const colon = trimmed.indexOf(':');
    const idx = eq >= 0 && (colon < 0 || eq < colon) ? eq : colon;
    const key = idx > 0 ? trimmed.slice(0, idx).trim() : '';
    if (!key || ['__proto__', 'constructor', 'prototype'].includes(key)) {
      bad.push(trimmed);
      continue;
    }
    out[key] = trimmed.slice(idx + 1).trim();
  }
  return { values: Object.keys(out).length ? { ...out } : undefined, bad };
}

function AddServerForm({ onDone }: { onDone: () => void }) {
  const { addServer, testServer } = useMcp();
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<'stdio' | 'http' | 'sse'>('stdio');
  const [urlOrCommand, setUrlOrCommand] = useState('');
  const [argsText, setArgsText] = useState('');
  const [headersText, setHeadersText] = useState('');
  const [envText, setEnvText] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [presetNote, setPresetNote] = useState<string | null>(null);

  const applyPreset = (p: ConnectorPresetView) => {
    setName(p.label);
    setTransport(p.transport);
    setUrlOrCommand(p.urlSuggestion ?? '');
    setPresetNote(p.note);
  };

  const submit = async () => {
    if (!name.trim() || !urlOrCommand.trim()) return;
    const env = transport === 'stdio' ? parseKeyValues(envText) : { values: undefined, bad: [] };
    const headers =
      transport !== 'stdio' ? parseKeyValues(headersText) : { values: undefined, bad: [] };
    const badLines = [...env.bad, ...headers.bad];
    if (badLines.length) {
      setFormError(
        `These lines are not KEY=value or KEY: value and were NOT saved — fix or remove them: ${badLines.join(' · ')}`,
      );
      return;
    }
    setFormError(null);
    setSaving(true);
    const created = await addServer({
      name: name.trim(),
      transport,
      urlOrCommand: urlOrCommand.trim(),
      // One argument per line — spaces inside a line stay inside the arg.
      args:
        transport === 'stdio' && argsText.trim()
          ? argsText
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean)
          : undefined,
      env: env.values,
      headers: headers.values,
    });
    setSaving(false);
    if (created) {
      onDone();
      // Registration is only half the story — immediately prove (or
      // disprove) that the server actually answers with this config.
      void testServer(created.id);
    }
  };

  return (
    <div className="panel connect-form">
      <div className="form-row">
        <label>Presets (official endpoints)</label>
        <div className="seg">
          {CONNECTOR_PRESETS.map((p) => (
            <button key={p.kind} onClick={() => applyPreset(p)}>
              {p.label}
            </button>
          ))}
        </div>
      </div>
      {presetNote && <p className="hint">{presetNote}</p>}
      <div className="form-row">
        <label>Name</label>
        <input placeholder="slack" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="form-row">
        <label>Transport</label>
        <div className="seg">
          {(['stdio', 'http', 'sse'] as const).map((t) => (
            <button key={t} className={transport === t ? 'on' : ''} onClick={() => setTransport(t)}>
              {t === 'stdio' ? 'local (stdio)' : t}
            </button>
          ))}
        </div>
      </div>
      <div className="form-row">
        <label>{transport === 'stdio' ? 'Command' : 'URL'}</label>
        <input
          placeholder={transport === 'stdio' ? 'node' : 'https://mcp.example.com/mcp'}
          value={urlOrCommand}
          onChange={(e) => setUrlOrCommand(e.target.value)}
        />
      </div>
      {transport === 'stdio' ? (
        <>
          <div className="form-row">
            <label>Arguments (one per line — paths with spaces are safe)</label>
            <textarea
              rows={2}
              placeholder={'C:\\Program Files\\tools\\my-mcp-server.mjs'}
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
            />
          </div>
          <div className="form-row">
            <label>Environment (KEY=value, one per line — values stay in Contrail)</label>
            <textarea rows={2} value={envText} onChange={(e) => setEnvText(e.target.value)} />
          </div>
        </>
      ) : (
        <div className="form-row">
          <label>Headers (KEY=value, one per line — e.g. Authorization=Bearer …)</label>
          <textarea rows={2} value={headersText} onChange={(e) => setHeadersText(e.target.value)} />
        </div>
      )}
      {formError && <div className="notice">{formError}</div>}
      <div className="form-actions">
        <button className="primary" disabled={saving} onClick={() => void submit()}>
          Register server
        </button>
      </div>
      <p className="hint">
        OAuth-native servers (Slack, Google, Atlassian): register first, then click
        <strong> Authorize…</strong> on the server card to sign in with your browser. Or paste a
        token header here. Header and environment values never appear in views or transcripts.
      </p>
    </div>
  );
}

/** Inline editor for a user-supplied OAuth client (Slack/Google — no auto-registration). */
function OauthClientForm({ serverId, onDone }: { serverId: string; onDone: () => void }) {
  const { setOauthClient, authorizeServer } = useMcp();
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!clientId.trim()) return;
    setSaving(true);
    const ok = await setOauthClient(serverId, clientId.trim(), clientSecret.trim());
    setSaving(false);
    if (ok) {
      onDone();
      void authorizeServer(serverId);
    }
  };

  return (
    <div className="panel connect-form">
      <p className="hint">
        Create an OAuth app with this provider, add the redirect URL{' '}
        <code>{OAUTH_LOOPBACK_REDIRECT}</code>, then paste its credentials. Saving starts the
        browser login. The secret stays in Contrail — it never appears in views.
      </p>
      <div className="form-row">
        <label>Client ID</label>
        <input value={clientId} onChange={(e) => setClientId(e.target.value)} />
      </div>
      <div className="form-row">
        <label>Client secret (if the provider issued one)</label>
        <input
          type="password"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
        />
      </div>
      <div className="form-actions">
        <button className="primary" disabled={saving || !clientId.trim()} onClick={() => void submit()}>
          Save &amp; authorize
        </button>
        <button onClick={onDone}>Cancel</button>
      </div>
    </div>
  );
}

function TestResultLine({ result }: { result: McpServerTestView | 'testing' }) {
  if (result === 'testing') return <span className="conn-detail meter-dim">Testing connection…</span>;
  const icon = result.status === 'connected' ? '✓' : result.status === 'needs_auth' ? '🔒' : '✗';
  return (
    <span className={`conn-detail ${result.status === 'connected' ? '' : 'meter-dim'}`}>
      {icon} {result.detail}
      {result.tools.length > 0 &&
        ` Tools: ${result.tools.slice(0, 8).join(', ')}${result.tools.length > 8 ? '…' : ''}`}
    </span>
  );
}

export function ConnectorsScreen() {
  const {
    servers,
    error,
    refreshServers,
    setServerEnabled,
    removeServer,
    clearError,
    testServer,
    authorizeServer,
    testResults,
  } = useMcp();
  const [adding, setAdding] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [editingOauth, setEditingOauth] = useState<string | null>(null);

  useEffect(() => {
    void refreshServers();
  }, [refreshServers]);

  return (
    <>
      <div className="screen-head">
        <h1>Connectors</h1>
        <button className="primary" onClick={() => setAdding((v) => !v)}>
          {adding ? 'Close' : 'Add MCP server…'}
        </button>
      </div>
      <p className="hint">
        External MCP servers extend sessions beyond Salesforce (Slack, Jira, custom tools). They
        run outside Contrail&apos;s grant system, and the agent can share conversation context
        with them — so each project must additionally opt in from its Capabilities tab.
      </p>
      {error && (
        <div className="notice clickable" onClick={clearError} title="Dismiss">
          {error}
        </div>
      )}
      {adding && <AddServerForm onDone={() => setAdding(false)} />}
      {servers === null ? (
        <div className="empty">Loading…</div>
      ) : servers.length === 0 ? (
        <div className="empty">No external servers registered.</div>
      ) : (
        <div className="panel-list">
          {servers.map((s) => (
            <div key={s.id}>
            <div className="row-card">
              <div className="conn-main">
                <div>
                  <span className="conn-alias">{s.name}</span>{' '}
                  <span className="meter-dim">
                    {s.transport === 'stdio' ? 'local (stdio)' : s.transport}
                  </span>
                </div>
                <div className="conn-detail">
                  {s.urlOrCommand}
                  {s.args.length > 0 && ` ${s.args.join(' ')}`}
                </div>
                <div className="conn-detail meter-dim">
                  {s.headerNames.length > 0 && `headers: ${s.headerNames.join(', ')} · `}
                  {s.envNames.length > 0 && `env: ${s.envNames.join(', ')} · `}
                  {s.hasOauthClient && 'own OAuth client · '}
                  {s.enabled ? 'available to projects that opt in' : 'off everywhere'}
                </div>
                {s.authorizedScopes && (
                  <div className="conn-detail meter-dim" title={s.authorizedScopes.join('\n')}>
                    granted scopes:{' '}
                    {s.authorizedScopes
                      .map((sc) => {
                        const trimmed = sc.replace(/\/+$/, '');
                        return trimmed.split('/').pop() || trimmed;
                      })
                      .join(', ')}
                  </div>
                )}
                {testResults[s.id] && (
                  <div>
                    <TestResultLine result={testResults[s.id]} />
                  </div>
                )}
              </div>
              <div className="row-actions">
                {s.transport !== 'stdio' && (
                  <>
                    <button
                      disabled={testResults[s.id] === 'testing'}
                      onClick={() => void authorizeServer(s.id)}
                      title="Sign in with the provider in your browser — Contrail runs the OAuth flow and stores the token in the keychain"
                    >
                      Authorize…
                    </button>
                    <button
                      onClick={() => setEditingOauth(editingOauth === s.id ? null : s.id)}
                      title="For providers without automatic registration (Slack, Google): paste an OAuth client from an app you create with them"
                    >
                      OAuth client…
                    </button>
                  </>
                )}
                <button
                  disabled={testResults[s.id] === 'testing'}
                  onClick={() => void testServer(s.id)}
                >
                  Test
                </button>
                <label className="grant-toggle">
                  <input
                    type="checkbox"
                    checked={s.enabled}
                    onChange={(e) => void setServerEnabled(s.id, e.target.checked)}
                  />
                  Enabled
                </label>
                {confirmRemove === s.id ? (
                  <button
                    className="ghost-danger"
                    onClick={() => {
                      setConfirmRemove(null);
                      void removeServer(s.id);
                    }}
                  >
                    Really remove?
                  </button>
                ) : (
                  <button onClick={() => setConfirmRemove(s.id)}>Remove</button>
                )}
              </div>
            </div>
            {editingOauth === s.id && (
              <OauthClientForm serverId={s.id} onDone={() => setEditingOauth(null)} />
            )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
