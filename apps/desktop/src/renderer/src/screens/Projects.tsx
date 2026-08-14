import { useEffect, useState } from 'react';
import { useProjects } from '../stores/projects.js';
import { useNav } from '../stores/nav.js';

export function ProjectsScreen() {
  const { projects, refresh, create } = useProjects();
  const { openProject } = useNav();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const submit = async () => {
    if (!name.trim()) return;
    try {
      const view = await create(name.trim(), description.trim() || undefined);
      setName('');
      setDescription('');
      setCreating(false);
      openProject(view.id);
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <>
      <div className="screen-head">
        <div>
          <h1>Projects</h1>
          <p className="subtitle">
            Each project is a silo: its own instructions, documents, notes, and org bindings.
            Sessions see their project&rsquo;s context and nothing else.
          </p>
        </div>
        <button className="primary" onClick={() => setCreating((v) => !v)}>
          {creating ? 'Close' : 'New project'}
        </button>
      </div>

      {creating && (
        <div className="panel">
          <div className="form-row">
            <label>Name</label>
            <input
              value={name}
              placeholder="Acme — CPQ rollout"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void submit()}
            />
          </div>
          <div className="form-row">
            <label>Description (optional)</label>
            <input
              value={description}
              placeholder="What this engagement is about"
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="form-actions">
            <button className="primary" onClick={() => void submit()}>
              Create project
            </button>
          </div>
          {error && <div className="notice">{error}</div>}
        </div>
      )}

      {projects === null ? (
        <div className="empty">Loading…</div>
      ) : projects.length === 0 ? (
        <div className="empty">No projects yet — create one to start working.</div>
      ) : (
        <div className="conn-list">
          {projects.map((p) => (
            <div
              className="conn-card clickable"
              key={p.id}
              onClick={() => openProject(p.id)}
            >
              <div className="conn-main">
                <div className="conn-alias">{p.name}</div>
                <div className="conn-detail">
                  {p.description ?? 'no description'} · {p.bindings.length} org
                  {p.bindings.length === 1 ? '' : 's'} bound
                </div>
              </div>
              <div className="binding-chips">
                {p.bindings.map((b) => (
                  <span key={b.connectionId} className={`env-chip ${b.envRole}`}>
                    {b.alias}
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
