import { useState } from 'react';
import type {
  ArtifactDetailView,
  DependencyRefView,
  PermissionSetView,
} from '@contrail/shared';
import { FlowDiagram } from './FlowDiagram.js';
import { SummaryButton, SummaryPanel, type SummaryState } from './summary.js';

/**
 * The artifact viewing experience, extracted from the Metadata screen (S28)
 * so the project manifest can open an artifact THE SAME WAY the explorer
 * does: header with provenance, AI-summary button/panel, dependency chips,
 * and the parsed-view/diagram/raw-XML body. Pure presentation — every data
 * concern (which IPC channel produced the ArtifactDetailView, which summary
 * hook feeds it) stays with the caller.
 */

/** Uses/Used-by grouped by type; the section and each subgroup collapse. */
export function DepSection({
  title,
  refs,
  truncated,
  onOpen,
}: {
  title: string;
  refs: DependencyRefView[];
  truncated: boolean;
  onOpen: (type: string, name: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  if (refs.length === 0) return null;

  const groups = new Map<string, DependencyRefView[]>();
  for (const ref of refs) {
    const list = groups.get(ref.type) ?? [];
    list.push(ref);
    groups.set(ref.type, list);
  }
  const sorted = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  return (
    <div className="dep-section">
      <button className="dep-section-head" onClick={() => setOpen((v) => !v)}>
        <span className="dep-caret">{open ? '▾' : '▸'}</span>
        <span className="dep-label">{title}</span>
        <span className="meta-count">{refs.length}{truncated ? '+' : ''}</span>
      </button>
      {open &&
        sorted.map(([type, items]) => {
          // Small groups start open; big ones start collapsed.
          const groupOpen = openGroups[type] ?? items.length <= 5;
          return (
            <div className="dep-subgroup" key={type}>
              <button
                className="dep-subgroup-head"
                onClick={() => setOpenGroups((g) => ({ ...g, [type]: !groupOpen }))}
              >
                <span className="dep-caret">{groupOpen ? '▾' : '▸'}</span>
                <span>{type}</span>
                <span className="meta-count">{items.length}</span>
              </button>
              {groupOpen && (
                <div className="dep-group">
                  {items.map((d) => (
                    <button
                      key={`${d.type}:${d.name}`}
                      className="dep-chip"
                      onClick={() => onOpen(d.type, d.name)}
                    >
                      {d.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      {open && truncated && (
        <span className="meter-dim">first 50 shown — ask the agent for the full graph</span>
      )}
    </div>
  );
}

export function ArtifactDetailPanel({
  detail,
  summary,
  showSummaryButton = false,
  onOpenRef,
  subtitleExtra,
}: {
  detail: ArtifactDetailView;
  /** The caller's useSummary state — null hides the summary UI entirely. */
  summary: SummaryState | null;
  showSummaryButton?: boolean;
  onOpenRef?: (type: string, name: string) => void;
  /** Extra line appended to the provenance subtitle (e.g. capture source). */
  subtitleExtra?: string;
}) {
  const [rawXml, setRawXml] = useState(false);
  const permissionSet = detail.permissionSet as PermissionSetView | null;
  const openRef = onOpenRef ?? (() => undefined);

  return (
    <>
      <div className="meta-detail-head">
        <div>
          <div className="conn-alias">{detail.apiName}</div>
          <div className="conn-detail">
            {detail.type}
            {detail.lastModifiedBy && ` · last modified by ${detail.lastModifiedBy}`}
            {detail.lastModifiedDate &&
              ` on ${new Date(detail.lastModifiedDate).toLocaleString()}`}
            {subtitleExtra && ` · ${subtitleExtra}`}
          </div>
        </div>
        <div className="meta-detail-actions">
          {showSummaryButton && summary && <SummaryButton state={summary} />}
          {(permissionSet || detail.flowGraph) && (
            <button onClick={() => setRawXml((v) => !v)}>
              {rawXml ? (detail.flowGraph ? 'Diagram' : 'Parsed view') : 'Raw XML'}
            </button>
          )}
        </div>
      </div>

      {summary && <SummaryPanel label="AI summary" state={summary} />}

      <div className="dep-panel">
        <DepSection
          title="uses"
          refs={detail.uses}
          truncated={detail.usesTruncated}
          onOpen={openRef}
        />
        <DepSection
          title="used by"
          refs={detail.usedBy}
          truncated={detail.usedByTruncated}
          onOpen={openRef}
        />
      </div>

      {permissionSet && !rawXml ? (
        <PermissionSetPanel view={permissionSet} />
      ) : detail.flowGraph && !rawXml ? (
        <FlowDiagram graph={detail.flowGraph} />
      ) : detail.content ? (
        <pre className="meta-source">{detail.content}</pre>
      ) : (
        <div className="empty">
          No source on disk for this artifact (children live in their parent's file).
        </div>
      )}
    </>
  );
}

/** A client org can carry 7k+ field rows — an unvirtualized table that size janks. */
const FIELD_ROW_CAP = 300;

export function PermissionSetPanel({ view }: { view: PermissionSetView }) {
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
