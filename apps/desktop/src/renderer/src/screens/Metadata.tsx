import { useEffect, useRef, useState } from 'react';
import type {
  ArtifactDetailView,
  ArtifactRowView,
  ConnectionView,
  MetadataTypeCountView,
} from '@contrail/shared';
import { ipc } from '../lib/ipc.js';
import { useConnections } from '../stores/connections.js';
import { ArtifactDetailPanel } from '../components/artifactDetail.js';
import { useSummary } from '../components/summary.js';

const SUMMARIZABLE = new Set(['ApexClass', 'ApexTrigger', 'Flow', 'ValidationRule']);

/**
 * The metadata browser: type tree → artifact list → detail (source +
 * dependency panel). Entirely local-first — everything reads the snapshot
 * index and tree, so browsing costs zero org API calls.
 */

export function MetadataScreen() {
  const { connections, refresh } = useConnections();
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [types, setTypes] = useState<MetadataTypeCountView[] | null>(null);
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [rows, setRows] = useState<ArtifactRowView[] | null>(null);
  const [query, setQuery] = useState('');
  const [detail, setDetail] = useState<ArtifactDetailView | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  // The saved summary arrives with the artifact, so reopening it costs nothing.
  const summary = useSummary(detail?.savedSummary ?? null, (refresh) => {
    if (!connectionId || !detail) return Promise.reject(new Error('No artifact selected.'));
    return ipc.invoke('metadata:summarize', {
      connectionId,
      type: detail.type as 'ApexClass' | 'ApexTrigger' | 'Flow' | 'ValidationRule',
      apiName: detail.apiName,
      refresh,
    });
  });

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const { snapshots } = useConnections();

  // Default to the first connection that actually HAS a snapshot to browse.
  useEffect(() => {
    if (connectionId || !connections?.length) return;
    const withSnapshot = connections.find((c) => (snapshots[c.id]?.artifactCount ?? 0) > 0);
    setConnectionId((withSnapshot ?? connections[0])?.id ?? null);
  }, [connections, connectionId, snapshots]);

  // Guard against a slow response landing after the user switched orgs.
  const activeConnRef = useRef<string | null>(null);
  useEffect(() => {
    if (!connectionId) return;
    activeConnRef.current = connectionId;
    setTypes(null);
    setSelectedType(null);
    setRows(null);
    setDetail(null);
    void ipc.invoke('metadata:types', { connectionId }).then((t) => {
      if (activeConnRef.current === connectionId) setTypes(t);
    });
  }, [connectionId]);

  // A sync finishing while we're on the "no snapshot" state should refresh.
  useEffect(() => {
    return ipc.subscribe('metadata:progress', ({ connectionId: synced, done }) => {
      if (done && synced === connectionId) {
        void ipc.invoke('metadata:types', { connectionId: synced }).then((t) => {
          if (activeConnRef.current === synced) setTypes(t);
        });
      }
    });
  }, [connectionId]);

  useEffect(() => {
    if (!connectionId || !selectedType) return;
    setRows(null);
    const timer = setTimeout(() => {
      void ipc
        .invoke('metadata:list', {
          connectionId,
          type: selectedType,
          query: query.trim() || undefined,
        })
        .then(setRows);
    }, 150);
    return () => clearTimeout(timer);
  }, [connectionId, selectedType, query]);

  const openArtifact = (type: string, apiName: string) => {
    if (!connectionId) return;
    const requestConn = connectionId;
    setDetail(null);
    setDetailError(null);
    setSelectedType(type);
    void ipc
      .invoke('metadata:artifact', { connectionId, type, apiName })
      .then((d) => {
        if (activeConnRef.current === requestConn) setDetail(d);
      })
      .catch((err) => {
        if (activeConnRef.current === requestConn) setDetailError(String(err));
      });
  };

  const conn: ConnectionView | undefined = (connections ?? []).find((c) => c.id === connectionId);

  return (
    <div className="meta-shell">
      <div className="meta-head">
        <h1>Metadata</h1>
        <select value={connectionId ?? ''} onChange={(e) => setConnectionId(e.target.value)}>
          {(connections ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.alias}
            </option>
          ))}
        </select>
        {conn && <span className="meter-dim">browsing the local snapshot — no org calls</span>}
      </div>

      <div className="meta-panes">
        <div className="meta-types">
          {connections !== null && connections.length === 0 ? (
            <div className="empty">No orgs connected — add one on the SF Orgs screen.</div>
          ) : types === null ? (
            <div className="empty">Loading…</div>
          ) : types.length === 0 ? (
            <div className="empty">No snapshot yet — sync this org from Connections.</div>
          ) : (
            types.map((t) => (
              <button
                key={t.type}
                className={`meta-type${selectedType === t.type ? ' on' : ''}`}
                onClick={() => {
                  setSelectedType(t.type);
                  setQuery('');
                  setDetail(null);
                }}
              >
                <span>{t.type}</span>
                <span className="meta-count">{t.count.toLocaleString()}</span>
              </button>
            ))
          )}
        </div>

        <div className="meta-list">
          {selectedType === null ? (
            <div className="empty">Pick a type.</div>
          ) : (
            <>
              <input
                className="meta-search"
                placeholder={`Search ${selectedType}…`}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {rows === null ? (
                <div className="empty">Loading…</div>
              ) : rows.length === 0 ? (
                <div className="empty">No matches.</div>
              ) : (
                rows.map((r) => (
                  <button
                    key={r.apiName}
                    className={`meta-row${detail?.apiName === r.apiName ? ' on' : ''}`}
                    onClick={() => openArtifact(r.type, r.apiName)}
                  >
                    <span className="meta-row-name">{r.apiName}</span>
                    {r.lastModifiedDate && (
                      <span className="meta-row-date">
                        {new Date(r.lastModifiedDate).toLocaleDateString()}
                      </span>
                    )}
                  </button>
                ))
              )}
            </>
          )}
        </div>

        <div className="meta-detail">
          {detailError ? (
            <div className="empty">{detailError}</div>
          ) : detail === null ? (
            <div className="empty">Pick an artifact.</div>
          ) : (
            // Keyed by artifact identity so the panel's local view state
            // (raw-XML toggle) resets on every open, as it always has.
            <ArtifactDetailPanel
              key={`${detail.type}:${detail.apiName}`}
              detail={detail}
              summary={summary}
              showSummaryButton={SUMMARIZABLE.has(detail.type)}
              onOpenRef={openArtifact}
            />
          )}
        </div>
      </div>
    </div>
  );
}
