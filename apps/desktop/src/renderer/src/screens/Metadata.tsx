import { useEffect, useRef, useState } from 'react';
import type {
  ArtifactDetailView,
  ArtifactRowView,
  ConnectionView,
  MetadataTypeCountView,
  PermissionSetView,
} from '@contrail/shared';
import { ipc } from '../lib/ipc.js';
import { useConnections } from '../stores/connections.js';

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
  const [rawXml, setRawXml] = useState(false);

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
    setRawXml(false);
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
  const permissionSet = detail?.permissionSet as PermissionSetView | null;

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
            <div className="empty">No orgs connected — add one on the Connections screen.</div>
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
            <>
              <div className="meta-detail-head">
                <div>
                  <div className="conn-alias">{detail.apiName}</div>
                  <div className="conn-detail">
                    {detail.type}
                    {detail.lastModifiedBy && ` · last modified by ${detail.lastModifiedBy}`}
                    {detail.lastModifiedDate &&
                      ` on ${new Date(detail.lastModifiedDate).toLocaleString()}`}
                  </div>
                </div>
                {permissionSet && (
                  <button onClick={() => setRawXml((v) => !v)}>
                    {rawXml ? 'Parsed view' : 'Raw XML'}
                  </button>
                )}
              </div>

              {(detail.uses.length > 0 || detail.usedBy.length > 0) && (
                <div className="dep-panel">
                  {detail.uses.length > 0 && (
                    <div className="dep-group">
                      <span className="dep-label">uses</span>
                      {detail.uses.map((d) => (
                        <button
                          key={`${d.type}:${d.name}`}
                          className="dep-chip"
                          onClick={() => openArtifact(d.type, d.name)}
                        >
                          {d.type}: {d.name}
                        </button>
                      ))}
                    </div>
                  )}
                  {detail.usedBy.length > 0 && (
                    <div className="dep-group">
                      <span className="dep-label">used by</span>
                      {detail.usedBy.map((d) => (
                        <button
                          key={`${d.type}:${d.name}`}
                          className="dep-chip"
                          onClick={() => openArtifact(d.type, d.name)}
                        >
                          {d.type}: {d.name}
                        </button>
                      ))}
                    </div>
                  )}
                  {(detail.usesTruncated || detail.usedByTruncated) && (
                    <span className="meter-dim">
                      showing the first {50} — ask the agent (get_dependencies) for the full graph
                    </span>
                  )}
                </div>
              )}

              {permissionSet && !rawXml ? (
                <PermissionSetPanel view={permissionSet} />
              ) : detail.content ? (
                <pre className="meta-source">{detail.content}</pre>
              ) : (
                <div className="empty">
                  No source on disk for this artifact (children live in their parent's file).
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** A client org can carry 7k+ field rows — an unvirtualized table that size janks. */
const FIELD_ROW_CAP = 300;

function PermissionSetPanel({ view }: { view: PermissionSetView }) {
  return (
    <div className="ps-panel">
      {view.label && (
        <p className="conn-detail">
          {view.label}
          {view.license && ` · license: ${view.license}`}
        </p>
      )}
      {view.objectPermissions.length > 0 && (
        <div className="ps-section">
          <h3>Object permissions</h3>
          <table className="ps-table">
            <thead>
              <tr>
                <th>Object</th><th>Read</th><th>Create</th><th>Edit</th><th>Delete</th><th>View All</th><th>Modify All</th>
              </tr>
            </thead>
            <tbody>
              {view.objectPermissions.map((p) => (
                <tr key={p.object}>
                  <td>{p.object}</td>
                  {[p.read, p.create, p.edit, p.delete, p.viewAll, p.modifyAll].map((v, i) => (
                    <td key={i} className={v ? 'ps-on' : 'ps-off'}>{v ? '✓' : '—'}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {view.fieldPermissions.length > 0 && (
        <div className="ps-section">
          <h3>
            Field permissions
            {view.fieldPermissions.length > FIELD_ROW_CAP &&
              ` (showing ${FIELD_ROW_CAP} of ${view.fieldPermissions.length.toLocaleString()} — use Raw XML for the rest)`}
          </h3>
          <table className="ps-table">
            <thead>
              <tr><th>Field</th><th>Read</th><th>Edit</th></tr>
            </thead>
            <tbody>
              {view.fieldPermissions.slice(0, FIELD_ROW_CAP).map((p) => (
                <tr key={p.field}>
                  <td>{p.field}</td>
                  <td className={p.readable ? 'ps-on' : 'ps-off'}>{p.readable ? '✓' : '—'}</td>
                  <td className={p.editable ? 'ps-on' : 'ps-off'}>{p.editable ? '✓' : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {([
        ['User permissions', view.userPermissions],
        ['Apex class access', view.classAccesses],
        ['Page access', view.pageAccesses],
        ['Record type visibility', view.recordTypeVisibilities],
        ['Application visibility', view.applicationVisibilities],
      ] as const).map(([title, items]) =>
        items.length > 0 ? (
          <div className="ps-section" key={title}>
            <h3>{title}</h3>
            <div className="ps-toggles">
              {items.map((t) => (
                <span key={t.name} className={`ps-toggle${t.enabled ? ' on' : ''}`}>
                  {t.name}
                </span>
              ))}
            </div>
          </div>
        ) : null,
      )}
      {view.tabSettings.length > 0 && (
        <div className="ps-section">
          <h3>Tabs</h3>
          <div className="ps-toggles">
            {view.tabSettings.map((t) => (
              <span key={t.tab} className="ps-toggle on">
                {t.tab}: {t.visibility}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
