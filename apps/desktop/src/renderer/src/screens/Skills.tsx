import { useEffect, useState } from 'react';
import { useSkills } from '../stores/skills.js';

/**
 * The universal skill library: the bundled Contrail pack (read-only) plus
 * custom uploads. What each PROJECT actually uses is chosen on the project's
 * Skills tab — this screen only manages the library and the per-skill
 * project default.
 */

export function SkillsScreen(): React.JSX.Element {
  const { library, error, refreshLibrary, clearError, addViaDialog, removeSkill, setDefaultOn } =
    useSkills();
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    void refreshLibrary();
  }, [refreshLibrary]);

  const bundled = (library ?? []).filter((s) => s.source === 'bundled');
  const custom = (library ?? []).filter((s) => s.source === 'custom');

  return (
    <div className="screen">
      <div className="screen-head">
        <h1>Skills</h1>
        <button
          disabled={adding}
          onClick={() => {
            setAdding(true);
            void addViaDialog().finally(() => setAdding(false));
          }}
          title="Choose a folder containing SKILL.md (plus any assets). It is copied into the library; enable it per project on the project's Skills tab."
        >
          {adding ? 'Adding…' : 'Add skill…'}
        </button>
      </div>
      <p className="screen-sub">
        Instruction packs the agent can load on demand. Bundled skills ship with Contrail and are
        on for every project unless a project opts out; custom skills are yours — off by default,
        selectable per project.
      </p>
      {error && (
        <div className="notice clickable" onClick={clearError} title="Dismiss">
          {error}
        </div>
      )}
      {library === null ? (
        <div className="empty">Loading…</div>
      ) : (
        <div className="panel-list">
          {bundled.map((s) => (
            <div key={s.key} className="row-card">
              <div className="conn-main">
                <div>
                  <span className="conn-alias">{s.name}</span>{' '}
                  <span className="meter-dim">bundled</span>
                </div>
                <div className="conn-detail">{s.description}</div>
                <div className="conn-detail meter-dim">
                  on for every project unless it opts out
                </div>
              </div>
            </div>
          ))}
          {custom.map((s) => (
            <div key={s.key} className="row-card">
              <div className="conn-main">
                <div>
                  <span className="conn-alias">{s.name}</span>{' '}
                  <span className="meter-dim">custom</span>
                </div>
                <div className="conn-detail">{s.description}</div>
                <div className="conn-detail meter-dim">
                  {s.defaultOn
                    ? 'on for every project unless it opts out'
                    : 'available to projects that opt in'}
                </div>
              </div>
              <div className="row-actions">
                <label
                  className="grant-toggle"
                  title="Projects without an explicit choice for this skill inherit this. Per-project toggles always win."
                >
                  <input
                    type="checkbox"
                    checked={s.defaultOn}
                    onChange={(e) => s.id && void setDefaultOn(s.id, e.target.checked)}
                  />
                  Default on for projects
                </label>
                {confirmRemove === s.key ? (
                  <button
                    className="ghost-danger"
                    onClick={() => {
                      setConfirmRemove(null);
                      if (s.id) void removeSkill(s.id);
                    }}
                  >
                    Really remove?
                  </button>
                ) : (
                  <button onClick={() => setConfirmRemove(s.key)}>Remove</button>
                )}
              </div>
            </div>
          ))}
          {custom.length === 0 && (
            <div className="empty">No custom skills yet — add a folder with a SKILL.md.</div>
          )}
        </div>
      )}
    </div>
  );
}
