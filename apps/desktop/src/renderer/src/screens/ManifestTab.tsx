import { useEffect, useState } from 'react';
import type { ManifestEntryDetailView, ManifestEntryView } from '@contrail/shared';
import { ipc } from '../lib/ipc.js';
import { useManifest } from '../stores/manifest.js';
import { useNav } from '../stores/nav.js';
import { ArtifactDetailPanel } from '../components/artifactDetail.js';
import { useSummary } from '../components/summary.js';

/**
 * The project manifest tab (S28): everything this project's sessions changed
 * through the ritual — metadata entries openable exactly like the Metadata
 * explorer (shared ArtifactDetailPanel: content, flow diagram, AI summary)
 * plus a what-changed pane from the captured before/after; data writes
 * (DML / anonymous Apex / bulk loads) listed separately. Every entry links
 * to its approval record on the Deploys screen.
 */

const CHANGE_LABEL: Record<string, string> = {
  add: 'added',
  modify: 'modified',
  unchanged_content: 'redeployed',
  delete: 'deleted',
};

function EntryRow({ e, onOpen }: { e: ManifestEntryView; onOpen: (id: string) => void }) {
  return (
    <div className="row-card clickable" onClick={() => onOpen(e.id)}>
      <div className="conn-main">
        <div>
          {e.entryKind === 'metadata' ? (
            <>
              {e.change === 'delete' && '🔴 '}
              <span className="conn-alias">
                {e.type}:{e.apiName}
              </span>{' '}
              <span className="meter-dim">{CHANGE_LABEL[e.change ?? ''] ?? e.change}</span>
            </>
          ) : (
            <span className="conn-alias">{e.label}</span>
          )}
        </div>
        <div className="conn-detail">
          {e.alias} · {new Date(e.executedAt).toLocaleString()}
          {e.warnings.length > 0 && ` · ⚠ ${e.warnings.length}`}
          {e.hasSummary && ' · ✦ summarized'}
          {!e.hasCapturedContent && e.entryKind === 'metadata' && ' · no capture (historic)'}
        </div>
      </div>
    </div>
  );
}

function WhatChanged({ detail }: { detail: ManifestEntryDetailView }) {
  if (detail.identical === true) {
    return <div className="empty">The deployed content was byte-identical to the previous version.</div>;
  }
  if (detail.changes && detail.changes.length > 0) {
    return (
      <div className="panel">
        {detail.changes.map((c, i) => (
          <div className="conn-detail" key={i}>
            {c.kind === 'scalar' && (
              <>
                <strong>{c.path}</strong>: {JSON.stringify(c.a)} → {JSON.stringify(c.b)}
              </>
            )}
            {c.kind === 'added' && (
              <>
                <strong>{c.path}</strong>: added <strong>{c.key}</strong>
              </>
            )}
            {c.kind === 'removed' && (
              <>
                <strong>{c.path}</strong>: removed <strong>{c.key}</strong>
              </>
            )}
            {c.kind === 'unkeyed' && (
              <>
                <strong>{c.path}</strong>: {c.note}
              </>
            )}
          </div>
        ))}
      </div>
    );
  }
  if (detail.hunks && detail.hunks.length > 0) {
    return (
      <pre className="meta-source">
        {detail.hunks
          .map(
            (h) =>
              `@@ line ${h.a_line} → ${h.b_line}\n` +
              h.removed.map((l) => `- ${l}`).join('\n') +
              (h.removed.length && h.added.length ? '\n' : '') +
              h.added.map((l) => `+ ${l}`).join('\n'),
          )
          .join('\n\n')}
      </pre>
    );
  }
  return null;
}

function EntryDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [detail, setDetail] = useState<ManifestEntryDetailView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { openDeploys } = useNav();

  useEffect(() => {
    setDetail(null);
    setError(null);
    void ipc
      .invoke('manifest:entry', { id })
      .then(setDetail)
      .catch((err) => setError(String(err)));
  }, [id]);

  const summary = useSummary(detail?.summary ?? null, (refresh) =>
    ipc.invoke('manifest:summarize', { id, refresh }),
  );

  if (error) return <div className="empty">{error}</div>;
  if (!detail) return <div className="empty">Loading…</div>;
  const e = detail.entry;

  return (
    <>
      <div className="meta-detail-head">
        <button className="crumb" onClick={onBack}>
          ← Manifest
        </button>
        <div className="meta-detail-actions">
          <button onClick={() => openDeploys(e.requestId)}>View approval record</button>
        </div>
      </div>

      {detail.contentSource === 'current_snapshot' && (
        <div className="notice">
          Captured content is unavailable for this historic change — showing the org&apos;s
          CURRENT version, which may include later changes.
        </div>
      )}
      {detail.contentTruncated && (
        <div className="notice">Captured content was truncated (very large artifact).</div>
      )}
      {e.warnings.length > 0 && (
        <div className="notice">{e.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}</div>
      )}

      {detail.artifact ? (
        <ArtifactDetailPanel
          key={e.id}
          detail={detail.artifact}
          summary={summary}
          showSummaryButton
          subtitleExtra={
            e.entryKind === 'metadata'
              ? `${CHANGE_LABEL[e.change ?? ''] ?? 'changed'} on ${e.alias}`
              : `executed on ${e.alias}`
          }
        />
      ) : (
        <div className="empty">
          {e.entryKind === 'data'
            ? 'A data change — its full record lives on the approval page above.'
            : 'No content available for this entry.'}
        </div>
      )}

      {e.entryKind === 'metadata' && (detail.changes || detail.hunks || detail.identical) && (
        <>
          <h3>What changed</h3>
          <WhatChanged detail={detail} />
        </>
      )}

      {detail.detail && e.entryKind === 'data' && (
        <pre className="meta-source">{JSON.stringify(detail.detail, null, 2)}</pre>
      )}
    </>
  );
}

export function ManifestTab({ projectId }: { projectId: string }) {
  const { view, projectId: loadedFor, loadProject, error, clearError } = useManifest();
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    setOpenId(null);
    void loadProject(projectId);
  }, [projectId, loadProject]);

  // Live refresh: an execution just landed in this project's manifest.
  useEffect(() => {
    return ipc.subscribe('manifest:changed', (p) => {
      if (p.projectId === projectId || p.projectId === '') void loadProject(projectId);
    });
  }, [projectId, loadProject]);

  if (error) {
    return (
      <div className="notice clickable" onClick={clearError} title="Dismiss">
        {error}
      </div>
    );
  }
  if (!view || loadedFor !== projectId) return <div className="empty">Loading…</div>;

  if (openId) return <EntryDetail id={openId} onBack={() => setOpenId(null)} />;

  return (
    <>
      <div className="panel">
        <h3>Metadata changes</h3>
        <p className="hint">
          Every component this project&apos;s sessions deployed through the approval ritual —
          click one to open it like the Metadata explorer, with what changed and an AI summary.
        </p>
        {view.metadata.length === 0 ? (
          <div className="empty">No metadata changes yet.</div>
        ) : (
          <div className="panel-list">
            {view.metadata.map((e) => (
              <EntryRow key={e.id} e={e} onOpen={setOpenId} />
            ))}
          </div>
        )}
      </div>

      <div className="panel">
        <h3>Data changes</h3>
        <p className="hint">
          DML, anonymous Apex, and bulk loads executed by this project&apos;s sessions.
        </p>
        {view.data.length === 0 ? (
          <div className="empty">No data changes yet.</div>
        ) : (
          <div className="panel-list">
            {view.data.map((e) => (
              <EntryRow key={e.id} e={e} onOpen={setOpenId} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
