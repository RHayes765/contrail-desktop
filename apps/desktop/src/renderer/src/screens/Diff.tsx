import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ArtifactDiffView,
  ConnectionView,
  DiffEntryView,
  DiffScopeView,
} from '@contrail/shared';
import { ipc } from '../lib/ipc.js';
import { useConnections } from '../stores/connections.js';
import { Md } from '../components/thread.js';
import { FlowDiagram, type FlowHighlights } from '../components/FlowDiagram.js';

const SUMMARIZABLE = new Set(['ApexClass', 'ApexTrigger', 'Flow', 'ValidationRule']);

/**
 * The flagship: cross-org metadata diff. Local-first (both sides read the
 * snapshot), honest about coverage, and drillable to the semantic change
 * level. Direction is always A → B: added = only in B.
 */

const ORG_COLORS: Record<string, string> = {
  production: 'var(--env-production)',
  sandbox: 'var(--env-sandbox)',
  developer: 'var(--env-developer)',
  scratch: 'var(--env-scratch)',
};

type StatusFilter = 'all' | 'added' | 'removed' | 'changed';

function OrgPicker({
  label,
  connections,
  value,
  exclude,
  onChange,
}: {
  label: string;
  connections: ConnectionView[];
  value: string | null;
  exclude: string | null;
  onChange: (id: string) => void;
}) {
  const { snapshots, syncSnapshot } = useConnections();
  const conn = connections.find((c) => c.id === value);
  const snap = value ? snapshots[value] : undefined;
  return (
    <div className="diff-picker">
      <span className="dep-label">{label}</span>
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
        <option value="" disabled>
          Choose an org…
        </option>
        {connections
          .filter((c) => c.id !== exclude)
          .map((c) => (
            <option key={c.id} value={c.id}>
              {c.alias} ({c.orgType})
            </option>
          ))}
      </select>
      {conn && (
        <span
          className="env-badge"
          style={{ background: ORG_COLORS[conn.orgType] ?? 'var(--env-other)' }}
        >
          {conn.orgType}
        </span>
      )}
      {value && (
        <span className="conn-detail">
          {snap?.syncing
            ? 'syncing…'
            : snap?.lastIndexedAt
              ? `snapshot ${agoLabel(snap.lastIndexedAt)}${snap.stale ? ' — STALE' : ''}`
              : 'never synced'}
          {snap && !snap.syncing && (snap.stale || !snap.lastIndexedAt) && (
            <button className="diff-sync-link" onClick={() => void syncSnapshot(value)}>
              sync now
            </button>
          )}
        </span>
      )}
    </div>
  );
}

function agoLabel(iso: string): string {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function DiffScreen() {
  const { connections, refresh, snapshots } = useConnections();
  const [connA, setConnA] = useState<string | null>(null);
  const [connB, setConnB] = useState<string | null>(null);
  const [scope, setScope] = useState<DiffScopeView | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [query, setQuery] = useState('');
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [drill, setDrill] = useState<ArtifactDiffView | null>(null);
  const [drillLoading, setDrillLoading] = useState(false);
  /** Snapshot identities the current scope was computed against. */
  const [scopeBasis, setScopeBasis] = useState<{ a: string | null; b: string | null } | null>(null);
  // Sequence tokens: anything in flight when the pair/direction changes is
  // dropped on arrival — a pre-swap drill must never render beside
  // post-swap totals with its aliases reversed.
  const seqRef = useRef(0);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async () => {
    if (!connA || !connB) return;
    const seq = ++seqRef.current;
    setRunning(true);
    setError(null);
    setDrill(null);
    try {
      const result = await ipc.invoke('diff:scope', { connectionA: connA, connectionB: connB });
      if (seqRef.current !== seq) return; // pair changed mid-flight
      setScope(result);
      setScopeBasis({
        a: snapshots[connA]?.lastIndexedAt ?? null,
        b: snapshots[connB]?.lastIndexedAt ?? null,
      });
      setOpenGroups({});
    } catch (err) {
      if (seqRef.current !== seq) return;
      setError(String(err));
      setScope(null);
    } finally {
      if (seqRef.current === seq) setRunning(false);
    }
  };

  const swap = () => {
    seqRef.current++;
    const a = connA;
    setConnA(connB);
    setConnB(a);
    setScope(null);
    setDrill(null);
    setRunning(false);
  };

  const openDrill = (entry: DiffEntryView) => {
    if (!connA || !connB) return;
    const seq = ++seqRef.current;
    setDrillLoading(true);
    setDrill(null);
    setError(null);
    void ipc
      .invoke('diff:artifact', {
        connectionA: connA,
        connectionB: connB,
        type: entry.type,
        apiName: entry.apiName,
      })
      .then((view) => {
        if (seqRef.current === seq) setDrill(view);
      })
      .catch((err) => {
        if (seqRef.current === seq) setError(String(err));
      })
      .finally(() => {
        if (seqRef.current === seq) setDrillLoading(false);
      });
  };

  // A re-sync while results are on screen makes them historical — say so.
  const scopeOutdated =
    scope != null &&
    scopeBasis != null &&
    ((connA && (snapshots[connA]?.lastIndexedAt ?? null) !== scopeBasis.a) ||
      (connB && (snapshots[connB]?.lastIndexedAt ?? null) !== scopeBasis.b));

  const groups = useMemo(() => {
    if (!scope) return [];
    const needle = query.trim().toLowerCase();
    const filtered = scope.entries.filter(
      (e) =>
        (statusFilter === 'all' || e.status === statusFilter) &&
        (!needle || e.apiName.toLowerCase().includes(needle)),
    );
    const byType = new Map<string, DiffEntryView[]>();
    for (const entry of filtered) {
      const list = byType.get(entry.type) ?? [];
      list.push(entry);
      byType.set(entry.type, list);
    }
    return [...byType.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [scope, statusFilter, query]);

  const staleWarning =
    (connA && snapshots[connA]?.stale) || (connB && snapshots[connB]?.stale);

  return (
    <>
      <div className="screen-head">
        <div>
          <h1>Diff</h1>
          <p className="subtitle">
            Compare two orgs' metadata snapshots — local, instant, and honest about what each
            snapshot covers. Direction reads A → B: “added” means only in B.
          </p>
        </div>
      </div>

      <div className="panel diff-controls">
        <OrgPicker
          label="Org A"
          connections={connections ?? []}
          value={connA}
          exclude={connB}
          onChange={(id) => {
            seqRef.current++;
            setConnA(id);
            setScope(null);
            setDrill(null);
            setRunning(false);
          }}
        />
        <button className="diff-swap" title="Swap direction" onClick={swap}>
          ⇄
        </button>
        <OrgPicker
          label="Org B"
          connections={connections ?? []}
          value={connB}
          exclude={connA}
          onChange={(id) => {
            seqRef.current++;
            setConnB(id);
            setScope(null);
            setDrill(null);
            setRunning(false);
          }}
        />
        <button className="primary" disabled={!connA || !connB || running} onClick={() => void run()}>
          {running ? 'Diffing…' : 'Run diff'}
        </button>
      </div>

      {staleWarning && (
        <div className="notice">
          One or both snapshots are stale — this diff reflects the snapshots, not the live orgs.
          Sync from the pickers above for current results.
        </div>
      )}
      {scopeOutdated && (
        <div className="notice">
          A snapshot changed since these results were computed — they are now historical.
          Re-run the diff for current numbers.
        </div>
      )}
      {error && (
        <div className="notice" onClick={() => setError(null)}>
          {error}
        </div>
      )}

      {scope && (
        <>
          <div className="diff-totals">
            <div className="diff-card added">
              <span className="diff-num">{scope.totals.added.toLocaleString()}</span>
              <span>added in {scope.aliasB}</span>
            </div>
            <div className="diff-card removed">
              <span className="diff-num">{scope.totals.removed.toLocaleString()}</span>
              <span>only in {scope.aliasA}</span>
            </div>
            <div className="diff-card changed">
              <span className="diff-num">{scope.totals.changed.toLocaleString()}</span>
              <span>changed</span>
            </div>
            <div className="diff-card unchanged">
              <span className="diff-num">{scope.totals.unchanged.toLocaleString()}</span>
              <span>unchanged</span>
            </div>
            <span className="conn-detail">
              {scope.cached ? 'cached · ' : ''}computed {agoLabel(scope.computedAt)}
            </span>
          </div>

          {scope.uncoveredTypes.length > 0 && (
            <div className="notice diff-uncovered">
              Not comparable (snapshot coverage):{' '}
              {scope.uncoveredTypes
                .map(
                  (u) =>
                    `${u.type} — not synced in ${u.missingIn === 'A' ? scope.aliasA : scope.aliasB} (${u.countInOther.toLocaleString()} in the other)`,
                )
                .join('; ')}
            </div>
          )}

          <div className="diff-filters">
            {(['all', 'changed', 'added', 'removed'] as StatusFilter[]).map((f) => (
              <button
                key={f}
                className={`seg-chip${statusFilter === f ? ' on' : ''}`}
                onClick={() => setStatusFilter(f)}
              >
                {f}
              </button>
            ))}
            <input
              className="meta-search diff-search"
              placeholder="Filter by name…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {scope.truncated && (
              <span className="meter-dim">list capped — totals are exact</span>
            )}
          </div>

          <div className="diff-body">
            <div className="diff-list">
              {groups.length === 0 ? (
                <div className="empty">Nothing matches.</div>
              ) : (
                groups.map(([type, entries]) => {
                  const open = openGroups[type] ?? entries.length <= 12;
                  return (
                    <div key={type}>
                      <button
                        className="dep-section-head"
                        onClick={() => setOpenGroups((g) => ({ ...g, [type]: !open }))}
                      >
                        <span className="dep-caret">{open ? '▾' : '▸'}</span>
                        <span className="dep-label">{type}</span>
                        <span className="meta-count">{entries.length}</span>
                      </button>
                      {open &&
                        entries.map((entry) => (
                          <button
                            key={`${entry.type}:${entry.apiName}`}
                            className={`diff-row${drill?.apiName === entry.apiName && drill?.type === entry.type ? ' on' : ''}`}
                            onClick={() => openDrill(entry)}
                          >
                            <span className={`diff-status ${entry.status}`}>{entry.status}</span>
                            <span className="meta-row-name">{entry.apiName}</span>
                            {entry.unreadable && (
                              <span className="meter-dim" title="snapshot file unreadable">⚠</span>
                            )}
                            {entry.status === 'changed' && entry.changeCount > 0 && (
                              <span className="meta-count">{entry.changeCount}</span>
                            )}
                          </button>
                        ))}
                    </div>
                  );
                })
              )}
            </div>

            <div className="diff-detail">
              {drillLoading ? (
                <div className="empty">Loading…</div>
              ) : drill ? (
                <DrillPanel drill={drill} connectionA={connA} connectionB={connB} />
              ) : (
                <div className="empty">Pick an entry to see its changes.</div>
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
}

/** Object-valued sides must never print "[object Object]". */
function fmtSide(value: unknown): string {
  if (value == null) return '(unset)';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

type FlowViewMode = 'changes' | 'diagramA' | 'diagramB' | 'raw';

function DrillPanel({
  drill,
  connectionA,
  connectionB,
}: {
  drill: ArtifactDiffView;
  connectionA: string | null;
  connectionB: string | null;
}) {
  const [raw, setRaw] = useState(false);
  const [flowView, setFlowView] = useState<FlowViewMode>('changes');
  const [summary, setSummary] = useState<string | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const oneSided = drill.presence !== 'both';
  const unreadable = drill.unreadableA || drill.unreadableB;
  const isFlow = drill.flowGraphA != null || drill.flowGraphB != null;

  const summarize = () => {
    if (!connectionA || !connectionB || !SUMMARIZABLE.has(drill.type)) return;
    setSummarizing(true);
    setSummaryError(null);
    void ipc
      .invoke('diff:summarize', {
        connectionA,
        connectionB,
        type: drill.type as 'ApexClass' | 'ApexTrigger' | 'Flow' | 'ValidationRule',
        apiName: drill.apiName,
      })
      .then((r) => setSummary(r.summary))
      .catch((err) => setSummaryError(String(err)))
      .finally(() => setSummarizing(false));
  };

  // Per-version highlight maps: B's diagram marks added+changed, A's marks
  // removed+changed — each diagram flags exactly what a viewer of THAT
  // version needs to notice.
  const highlightsA: FlowHighlights = {};
  const highlightsB: FlowHighlights = {};
  if (drill.flowNodeChanges) {
    for (const name of drill.flowNodeChanges.changed) {
      highlightsA[name] = 'changed';
      highlightsB[name] = 'changed';
    }
    for (const name of drill.flowNodeChanges.addedInB) highlightsB[name] = 'added';
    for (const name of drill.flowNodeChanges.removedInB) highlightsA[name] = 'removed';
  }

  return (
    <>
      <div className="meta-detail-head">
        <div>
          <div className="conn-alias">{drill.apiName}</div>
          <div className="conn-detail">
            {drill.type} · {drill.aliasA} → {drill.aliasB}
            {oneSided &&
              ` · only in ${drill.presence === 'a-only' ? drill.aliasA : drill.aliasB}`}
          </div>
        </div>
        <div className="meta-detail-actions">
          {SUMMARIZABLE.has(drill.type) && !summary && !unreadable && (
            <button disabled={summarizing} onClick={summarize}>
              {summarizing ? 'Summarizing…' : 'AI summary'}
            </button>
          )}
          {isFlow && !oneSided && !unreadable ? (
            <div className="seg">
              {(
                [
                  ['changes', 'Changes'],
                  ['diagramA', drill.aliasA],
                  ['diagramB', drill.aliasB],
                  ['raw', 'Raw'],
                ] as Array<[FlowViewMode, string]>
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  className={flowView === mode ? 'on' : ''}
                  onClick={() => setFlowView(mode)}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : (
            !oneSided &&
            !unreadable && (
              <button onClick={() => setRaw((v) => !v)}>
                {raw ? 'Changes' : 'Raw side-by-side'}
              </button>
            )
          )}
        </div>
      </div>

      {summaryError && <div className="notice">{summaryError}</div>}
      {summary && (
        <div className="summary-panel">
          <div className="dep-label">AI summary of the change</div>
          <Md text={summary} />
        </div>
      )}

      {/* One-sided flows: the diagram IS the view (its inspector holds the XML). */}
      {isFlow && oneSided && !unreadable && (drill.flowGraphA ?? drill.flowGraphB) && (
        <FlowDiagram graph={(drill.flowGraphA ?? drill.flowGraphB)!} />
      )}
      {isFlow && !oneSided && !unreadable && flowView === 'diagramA' && drill.flowGraphA && (
        <FlowDiagram graph={drill.flowGraphA} highlights={highlightsA} />
      )}
      {isFlow && !oneSided && !unreadable && flowView === 'diagramB' && drill.flowGraphB && (
        <FlowDiagram graph={drill.flowGraphB} highlights={highlightsB} />
      )}

      {(isFlow && !unreadable && (oneSided || flowView === 'diagramA' || flowView === 'diagramB')) ? null : unreadable ? (
        <div className="empty">
          The snapshot file could not be read in{' '}
          {[drill.unreadableA && drill.aliasA, drill.unreadableB && drill.aliasB]
            .filter(Boolean)
            .join(' and ')}
          {' '}— the artifact IS indexed there. Re-sync that org and try again.
        </div>
      ) : oneSided ? (
        <pre className="meta-source">{drill.contentA ?? drill.contentB ?? ''}</pre>
      ) : (isFlow ? flowView === 'raw' : raw) ? (
        <div className="diff-raw">
          <div>
            <div className="dep-label">{drill.aliasA}</div>
            <pre className="meta-source">{drill.contentA ?? ''}</pre>
          </div>
          <div>
            <div className="dep-label">{drill.aliasB}</div>
            <pre className="meta-source">{drill.contentB ?? ''}</pre>
          </div>
        </div>
      ) : drill.identical ? (
        <div className="empty">
          Semantically identical — the files differ only in ordering or whitespace.
        </div>
      ) : drill.format === 'xml' && drill.changes ? (
        <div className="diff-changes">
          {drill.changes.map((change, i) => (
            <div key={i} className="diff-change">
              {change.kind === 'scalar' ? (
                <>
                  <span className="diff-path">{change.path}</span>
                  <span className="diff-a">{fmtSide(change.a)}</span>
                  <span className="diff-arrow">→</span>
                  <span className="diff-b">{fmtSide(change.b)}</span>
                </>
              ) : change.kind === 'added' ? (
                <>
                  <span className="diff-status added">added</span>
                  <span className="diff-path">
                    {change.path} · {change.key}
                  </span>
                </>
              ) : change.kind === 'removed' ? (
                <>
                  <span className="diff-status removed">removed</span>
                  <span className="diff-path">
                    {change.path} · {change.key}
                  </span>
                </>
              ) : (
                <>
                  <span className="diff-status changed">note</span>
                  <span className="diff-path">
                    {change.path} · {change.note}
                  </span>
                </>
              )}
            </div>
          ))}
          {drill.changesTruncated && (
            <span className="meter-dim">change list truncated — raw view has everything</span>
          )}
        </div>
      ) : drill.countsOnly ? (
        <div className="empty">
          Large rewrite: +{drill.linesAdded.toLocaleString()} / −
          {drill.linesRemoved.toLocaleString()} lines — too big for hunk extraction. The raw
          side-by-side view has both versions.
        </div>
      ) : drill.hunks ? (
        <div className="diff-hunks">
          {drill.hunks.map((hunk, i) => (
            <div key={i} className="diff-hunk">
              <div className="conn-detail">
                @ {drill.aliasA} line {hunk.a_line} · {drill.aliasB} line {hunk.b_line}
              </div>
              {hunk.removed.map((line, j) => (
                <div key={`r${j}`} className="hunk-line removed">
                  - {line}
                </div>
              ))}
              {hunk.added.map((line, j) => (
                <div key={`a${j}`} className="hunk-line added">
                  + {line}
                </div>
              ))}
            </div>
          ))}
          {drill.hunksTruncated && (
            <span className="meter-dim">hunks truncated — raw view has everything</span>
          )}
        </div>
      ) : (
        <div className="empty">No structured diff available — use the raw view.</div>
      )}
    </>
  );
}
