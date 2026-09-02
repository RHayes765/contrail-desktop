import { useEffect, useMemo, useState } from 'react';
import type { EnvRole } from '@contrail/shared';
import { useProjects } from '../stores/projects.js';
import { useConnections } from '../stores/connections.js';
import { useMcp } from '../stores/mcp.js';
import { useSkills } from '../stores/skills.js';
import { useNav } from '../stores/nav.js';
import { useChat } from '../stores/chat.js';
import { ManifestTab } from './ManifestTab.js';

const ENV_ROLES: EnvRole[] = ['dev', 'qa', 'uat', 'prod', 'other'];

type Tab =
  | 'sessions'
  | 'manifest'
  | 'bindings'
  | 'capabilities'
  | 'skills'
  | 'instructions'
  | 'docs'
  | 'notes';

/** Per-project catalog family + external-server toggle panel. */
function CapabilitiesTab({ projectId }: { projectId: string }) {
  const { project, projectId: loadedFor, loadProject, setToggle, error, clearError } = useMcp();
  const { goConnectors } = useNav();

  useEffect(() => {
    void loadProject(projectId);
  }, [projectId, loadProject]);

  if (!project || loadedFor !== projectId) {
    return error ? (
      <div className="notice clickable" onClick={clearError} title="Dismiss">
        {error}
      </div>
    ) : (
      <div className="empty">Loading…</div>
    );
  }

  return (
    <>
      {error && (
        <div className="notice clickable" onClick={clearError} title="Dismiss">
          {error}
        </div>
      )}
      <div className="panel grants-editor">
        <h3>Tool families</h3>
        <p className="hint">
          Families toggled off don&apos;t exist in this project&apos;s new sessions, and running
          sessions lose them on their next call. Grants on each connection still apply on top.
        </p>
        {project.families.map((f) => (
          <label key={f.key} className="grant-toggle">
            <input
              type="checkbox"
              checked={f.enabled}
              onChange={(e) => void setToggle(projectId, f.key, e.target.checked)}
            />
            <span>
              <strong>{f.label}</strong> — {f.description}{' '}
              <span className="meter-dim">({f.capabilities.join(', ')})</span>
            </span>
          </label>
        ))}
      </div>
      <div className="panel grants-editor">
        <h3>External MCP servers</h3>
        {project.externalServers.length === 0 ? (
          <p className="hint">
            None registered.{' '}
            <button className="crumb" onClick={goConnectors}>
              Add one on the Connectors screen →
            </button>
          </p>
        ) : (
          <>
            <p className="hint">
              Off by default in every project. An external server runs outside Contrail&apos;s
              grant system, and the agent can share conversation context with it — enable it here
              only if this engagement should use it. Disabling one ends any running session that
              was using it (its connection can&apos;t be revoked mid-flight).
            </p>
            {project.externalServers.map((s) => (
              <label key={s.id} className="grant-toggle">
                <input
                  type="checkbox"
                  checked={s.enabledForProject}
                  disabled={!s.globallyEnabled}
                  onChange={(e) => void setToggle(projectId, `ext:${s.id}`, e.target.checked)}
                />
                <span>
                  <strong>{s.name}</strong>{' '}
                  <span className="meter-dim">
                    ({s.transport === 'stdio' ? 'local' : s.transport})
                    {!s.globallyEnabled && ' — disabled globally on the Connectors screen'}
                  </span>
                </span>
              </label>
            ))}
          </>
        )}
      </div>
    </>
  );
}

/** Per-project skill selection: bundled default-on, custom opt-in, explicit choices win. */
function SkillsTab({ projectId }: { projectId: string }) {
  const { project, projectId: loadedFor, loadProject, setToggle, error, clearError } = useSkills();
  const { goSkills } = useNav();

  useEffect(() => {
    void loadProject(projectId);
  }, [projectId, loadProject]);

  if (!project || loadedFor !== projectId) {
    return error ? (
      <div className="notice clickable" onClick={clearError} title="Dismiss">
        {error}
      </div>
    ) : (
      <div className="empty">Loading…</div>
    );
  }

  const bundled = project.skills.filter((s) => s.source === 'bundled');
  const custom = project.skills.filter((s) => s.source === 'custom');

  return (
    <>
      {error && (
        <div className="notice clickable" onClick={clearError} title="Dismiss">
          {error}
        </div>
      )}
      <div className="panel grants-editor">
        <h3>Skills</h3>
        <p className="hint">
          Enabled skills are announced to this project&apos;s sessions (the agent loads the full
          instructions on demand). New sessions pick up changes at start; a running session loses a
          disabled skill on its next read.{' '}
          <button className="crumb" onClick={goSkills}>
            Manage the library →
          </button>
        </p>
        {[...bundled, ...custom].map((s) => (
          <label key={s.key} className="grant-toggle">
            <input
              type="checkbox"
              checked={s.enabled}
              onChange={(e) => void setToggle(projectId, s.key, e.target.checked)}
            />
            <span>
              <strong>{s.name}</strong>{' '}
              <span className="meter-dim">({s.source})</span> — {s.description}
            </span>
          </label>
        ))}
      </div>
    </>
  );
}

export function ProjectDetailScreen({ projectId }: { projectId: string }) {
  const {
    projects,
    docs,
    folders,
    notes,
    sessions,
    select,
    update,
    remove,
    bind,
    unbind,
    addDocs,
    removeDoc,
    linkFolder,
    unlinkFolder,
    addNote,
    deleteSession,
    renameSession,
    error,
    clearError,
  } = useProjects();
  const { connections, refresh: refreshConnections } = useConnections();
  const { goProjects, openChat, openSession } = useNav();

  const project = useMemo(
    () => (projects ?? []).find((p) => p.id === projectId) ?? null,
    [projects, projectId],
  );

  const [tab, setTab] = useState<Tab>('sessions');
  const [confirmDeleteSession, setConfirmDeleteSession] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [continuing, setContinuing] = useState(false);

  /**
   * Clicking a session CONTINUES it — the live one returns to its chat, an
   * ended one is resumed onto the same row and opens in chat. The read-only
   * transcript is still one click away, but "click the thing I was working on
   * and keep working" is what the list is for.
   */
  const continueSession = async (sessionId: string, status: string): Promise<void> => {
    if (continuing) return;
    if (status === 'active') {
      openChat(projectId);
      return;
    }
    setContinuing(true);
    try {
      await useChat.getState().resume(projectId, sessionId);
      const chat = useChat.getState();
      if (chat.sessionId === sessionId) openChat(projectId);
      // resume() surfaced its own error into the chat store; fall back to the
      // read-only transcript so the click is never a dead end.
      else openSession(projectId, sessionId);
    } finally {
      setContinuing(false);
    }
  };

  const commitRename = async (sessionId: string): Promise<void> => {
    const name = renameDraft.trim();
    if (!name) return;
    if (await renameSession(projectId, sessionId, name)) setRenamingId(null);
  };
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
        {(['sessions', 'manifest', 'bindings', 'capabilities', 'skills', 'instructions', 'docs', 'notes'] as Tab[]).map(
          (t) => (
            <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
              {t}
            </button>
          ),
        )}
      </div>

      {tab === 'capabilities' && <CapabilitiesTab projectId={project.id} />}
      {tab === 'skills' && <SkillsTab projectId={project.id} />}
      {tab === 'manifest' && <ManifestTab projectId={project.id} />}

      {tab === 'sessions' && (
        <div className="panel-list">
          {sessions.length === 0 ? (
            <div className="empty">No sessions yet. Start one with “New session”.</div>
          ) : (
            sessions.map((s) => (
              <div
                className="row-card clickable"
                key={s.id}
                onClick={() => void continueSession(s.id, s.status)}
              >
                <div className="conn-main">
                  {renamingId === s.id ? (
                    // Click-through would open the chat mid-edit.
                    <div onClick={(e) => e.stopPropagation()}>
                      <input
                        autoFocus
                        value={renameDraft}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void commitRename(s.id);
                          if (e.key === 'Escape') setRenamingId(null);
                        }}
                      />
                    </div>
                  ) : (
                    <div className="conn-alias">{s.title ?? 'untitled session'}</div>
                  )}
                  <div className="conn-detail">
                    {s.status} · {s.model ?? '?'} · ${s.costUsd.toFixed(4)} ·{' '}
                    {new Date(s.createdAt).toLocaleString()}
                  </div>
                </div>
                <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                  {renamingId === s.id ? (
                    <>
                      <button onClick={() => void commitRename(s.id)}>Save</button>
                      <button onClick={() => setRenamingId(null)}>Cancel</button>
                    </>
                  ) : (
                    <>
                      <button
                        onClick={() => {
                          setRenamingId(s.id);
                          setRenameDraft(s.title ?? '');
                        }}
                      >
                        Rename
                      </button>
                      <button onClick={() => openSession(project.id, s.id)}>Transcript</button>
                      {confirmDeleteSession === s.id ? (
                        <>
                          <button
                            className="danger"
                            onClick={() => {
                              setConfirmDeleteSession(null);
                              void deleteSession(project.id, s.id);
                            }}
                          >
                            Really delete
                          </button>
                          <button onClick={() => setConfirmDeleteSession(null)}>Keep</button>
                        </>
                      ) : (
                        <button
                          className="ghost-danger"
                          onClick={() => setConfirmDeleteSession(s.id)}
                        >
                          Delete
                        </button>
                      )}
                    </>
                  )}
                </div>
                <span className="row-open">continue →</span>
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
          <h3 className="silo-section-head">Linked folders</h3>
          <div className="panel-list">
            {folders.length === 0 ? (
              <div className="empty">
                No linked folders. Link a local folder and the agent sees its current contents —
                live, no copies, nothing to re-upload.
              </div>
            ) : (
              folders.map((f) => (
                <div className="row-card" key={f.id}>
                  <div className="conn-main">
                    <div className="conn-alias">{f.name}</div>
                    <div className="conn-detail" title={f.path}>
                      {f.path} · linked {new Date(f.addedAt).toLocaleDateString()}
                    </div>
                  </div>
                  <div className="row-actions">
                    <button
                      title="Removes the link only — your folder and files are untouched."
                      onClick={() => void unlinkFolder(project.id, f.id)}
                    >
                      Unlink
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
          <div className="form-actions">
            <button className="primary" onClick={() => void linkFolder(project.id)}>
              Link a folder…
            </button>
          </div>

          <h3 className="silo-section-head">Documents</h3>
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
            <span>
              Delete this project, its docs, notes, and bindings? Linked folders are unlinked
              (your files are untouched). Sessions history stays.
            </span>
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
