import { useEffect, useState } from 'react';
import { CONNECTOR_PRESETS, type ConnectorPresetView } from '@contrail/shared';
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
  const { addServer } = useMcp();
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
    const ok = await addServer({
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
    if (ok) onDone();
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
        Header-based auth only in v1 — remote servers that require a browser OAuth flow are not
        supported yet. Header and environment values never appear in views or transcripts.
      </p>
    </div>
  );
}

export function ConnectorsScreen() {
  const { servers, error, refreshServers, setServerEnabled, removeServer, clearError } = useMcp();
  const [adding, setAdding] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

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
            <div key={s.id} className="row-card">
              <div className="conn-main">
                <span className="conn-alias">{s.name}</span>
                <span className="conn-detail">
                  {s.transport === 'stdio' ? 'local (stdio)' : s.transport} · {s.urlOrCommand}
                  {s.args.length > 0 && ` ${s.args.join(' ')}`}
                </span>
                <span className="conn-detail meter-dim">
                  {s.headerNames.length > 0 && `headers: ${s.headerNames.join(', ')} · `}
                  {s.envNames.length > 0 && `env: ${s.envNames.join(', ')} · `}
                  {s.enabled ? 'available to projects that opt in' : 'off everywhere'}
                </span>
              </div>
              <div className="row-actions">
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
          ))}
        </div>
      )}
    </>
  );
}
