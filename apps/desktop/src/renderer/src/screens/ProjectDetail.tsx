import { useEffect, useMemo, useState } from 'react';
import type { EnvRole } from '@contrail/shared';
import { useProjects } from '../stores/projects.js';
import { useConnections } from '../stores/connections.js';
import { useNav } from '../stores/nav.js';

const ENV_ROLES: EnvRole[] = ['dev', 'qa', 'uat', 'prod', 'other'];

type Tab = 'sessions' | 'bindings' | 'instructions' | 'docs' | 'notes';

export function ProjectDetailScreen({ projectId }: { projectId: string }) {
  const {
    projects,
    docs,
    notes,
    sessions,
    select,
    update,
    remove,
    bind,
    unbind,
    addDocs,
    removeDoc,
    addNote,
    error,
    clearError,
  } = useProjects();
  const { connections, refresh: refreshConnections } = useConnections();
  const { goProjects, openChat } = useNav();

  const project = useMemo(
    () => (projects ?? []).find((p) => p.id === projectId) ?? null,
    [projects, projectId],
  );

  const [tab, setTab] = useState<Tab>('sessions');
  const [instructionsDraft, setInstructionsDraft] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [bindConnectionId, setBindConnectionId] = useState('');
  const [bindRole, setBindRole] = useState<EnvRole>('dev');
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    void select(projectId);
    void refreshConnections();
    setInstructionsDraft(null);
    setTab('sessions');
  }, [projectId, select, refreshConnections]);

  if (!project) {
    return (
      <div className="empty">
        Project not found. <button onClick={goProjects}>Back to projects</button>
      </div>
    );
  }

  const boundIds = new Set(project.bindings.map((b) => b.connectionId));
  const bindable = (connections ?? []).filter((c) => !boundIds.has(c.id));
  const instructionsValue = instructionsDraft ?? project.instructions ?? '';
  const instructionsDirty = instructionsDraft !== null && instructionsDraft !== (project.instructions ?? '');

  return (
    <>
      <div className="screen-head">
        <div>
          <button className="crumb" onClick={goProjects}>
            ← Projects
          </button>
          <h1>{project.name}</h1>
          <p className="subtitle">{project.description ?? 'no description'}</p>
        </div>
        <button className="primary" onClick={() => openChat(project.id)}>
          New session
        </button>
      </div>

      {error && (
        <div className="notice" onClick={clearError}>
          {error}
        </div>
      )}

      <div className="tabs">
        {(['sessions', 'bindings', 'instructions', 'docs', 'notes'] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>

      {tab === 'sessions' && (
        <div className="panel-list">
          {sessions.length === 0 ? (
            <div className="empty">No sessions yet. Start one with “New session”.</div>
          ) : (
            sessions.map((s) => (
              <div className="row-card" key={s.id}>
                <div className="conn-main">
                  <div className="conn-alias">{s.title ?? 'untitled session'}</div>
                  <div className="conn-detail">
                    {s.status} · {s.model ?? '?'} · ${s.costUsd.toFixed(4)} ·{' '}
                    {new Date(s.createdAt).toLocaleString()}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {tab === 'bindings' && (
        <>
          <div className="panel-list">
            {project.bindings.length === 0 ? (
              <div className="empty">
                No orgs bound. Sessions in this project will have project tools only.
              </div>
            ) : (
              project.bindings.map((b) => (
                <div className="row-card" key={b.connectionId}>
                  <span className={`env-chip ${b.envRole}`}>{b.envRole}</span>
                  <div className="conn-main">
                    <div className="conn-alias">{b.alias}</div>
                    <div className="conn-detail">
                      {b.orgName ?? 'unnamed'} · {b.orgType}
                    </div>
                  </div>
                  <div className="row-actions">
                    <select
                      value={b.envRole}
                      onChange={(e) => void bind(project.id, b.connectionId, e.target.value as EnvRole)}
                    >
                      {ENV_ROLES.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                    <button onClick={() => void unbind(project.id, b.connectionId)}>Unbind</button>
                  </div>
                </div>
              ))
            )}
          </div>
          {bindable.length > 0 && (
            <div className="panel">
              <div className="form-row inline">
                <select value={bindConnectionId} onChange={(e) => setBindConnectionId(e.target.value)}>
                  <option value="">Choose a connection…</option>
                  {bindable.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.alias} ({c.orgType})
                    </option>
                  ))}
                </select>
                <select value={bindRole} onChange={(e) => setBindRole(e.target.value as EnvRole)}>
                  {ENV_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
                <button
                  className="primary"
                  disabled={!bindConnectionId}
                  onClick={() => {
                    void bind(project.id, bindConnectionId, bindRole);
                    setBindConnectionId('');
                  }}
                >
                  Bind org
                </button>
              </div>
              <p className="hint">
                Sessions in this project can see and use ONLY the orgs bound here, within each
                org&rsquo;s grants.
              </p>
            </div>
          )}
        </>
      )}

      {tab === 'instructions' && (
        <div className="panel">
          <p className="hint">
            Injected verbatim into every session&rsquo;s system context for this project. Client
            conventions, tone, engagement rules — whatever the agent should always know here.
          </p>
          <textarea
            className="instructions-editor"
            rows={14}
            placeholder="e.g. Field naming uses the LF4_ prefix. Never suggest changes to the managed CPQ package. UAT refreshes every Monday."
            value={instructionsValue}
            onChange={(e) => setInstructionsDraft(e.target.value)}
          />
          <div className="form-actions">
            <button
              className="primary"
              disabled={!instructionsDirty}
              onClick={() => {
                void update({ id: project.id, instructions: instructionsValue || null }).then(
                  (ok) => {
                    // Only discard the draft once the save actually landed.
                    if (ok) setInstructionsDraft(null);
                  },
                );
              }}
            >
              Save instructions
            </button>
            {instructionsDirty && (
              <button onClick={() => setInstructionsDraft(null)}>Discard</button>
            )}
          </div>
        </div>
      )}

      {tab === 'docs' && (
        <>
          <div className="panel-list">
            {docs.length === 0 ? (
              <div className="empty">
                No reference documents. Add files the agent should be able to consult — they stay
                inside this project.
              </div>
            ) : (
              docs.map((d) => (
                <div className="row-card" key={d.id}>
                  <div className="conn-main">
                    <div className="conn-alias">{d.filename}</div>
                    <div className="conn-detail">
                      {d.mime ?? 'unknown type'} ·{' '}
                      {d.sizeBytes != null ? `${Math.max(1, Math.round(d.sizeBytes / 1024))} KB` : '?'}{' '}
                      · added {new Date(d.addedAt).toLocaleDateString()}
                    </div>
                  </div>
                  <div className="row-actions">
                    <button onClick={() => void removeDoc(project.id, d.id)}>Remove</button>
                  </div>
                </div>
              ))
            )}
          </div>
          <div className="form-actions">
            <button className="primary" onClick={() => void addDocs(project.id)}>
              Add documents…
            </button>
          </div>
        </>
      )}

      {tab === 'notes' && (
        <>
          <div className="panel-list">
            {notes.length === 0 ? (
              <div className="empty">
                No notes yet. Notes persist across sessions — you and the agent both write them.
              </div>
            ) : (
              notes.map((n) => (
                <div className="row-card note" key={n.id}>
                  <span className={`author-chip ${n.author}`}>{n.author}</span>
                  <div className="conn-main">
                    <div className="note-body">{n.body}</div>
                    <div className="conn-detail">{new Date(n.createdAt).toLocaleString()}</div>
                  </div>
                </div>
              ))
            )}
          </div>
          <div className="panel">
            <div className="form-row">
              <textarea
                rows={3}
                placeholder="Add a note future sessions should see…"
                value={noteDraft}
                onChange={(e) => setNoteDraft(e.target.value)}
              />
            </div>
            <div className="form-actions">
              <button
                className="primary"
                disabled={!noteDraft.trim()}
                onClick={() => {
                  void addNote(project.id, noteDraft.trim()).then((ok) => {
                    if (ok) setNoteDraft('');
                  });
                }}
              >
                Add note
              </button>
            </div>
          </div>
        </>
      )}

      <div className="danger-zone">
        {confirmDelete ? (
          <>
            <span>Delete this project, its docs, notes, and bindings? Sessions history stays.</span>
            <button
              className="danger"
              onClick={() => {
                void remove(project.id);
                goProjects();
              }}
            >
              Really delete
            </button>
            <button onClick={() => setConfirmDelete(false)}>Keep</button>
          </>
        ) : (
          <button className="ghost-danger" onClick={() => setConfirmDelete(true)}>
            Delete project…
          </button>
        )}
      </div>
    </>
  );
}
