import { useEffect, useState } from 'react';
import type { DeployRequestView } from '@contrail/shared';
import { useDeploys } from '../stores/deploys.js';
import { useNav } from '../stores/nav.js';

/**
 * Deploy Review — the write-safety surface (spec §M5). Everything about it
 * is deliberate: the giant env-colored target so nobody approves against
 * the wrong org, destructive changes first and red, Approve disabled unless
 * the request is validated and unexpired, a REQUIRED comment on production.
 * There is no confirmation code anywhere on this screen — the renderer's
 * decision IS the approval, and only the main process touches the code.
 */

const STATE_LABEL: Record<string, string> = {
  validated: 'Awaiting approval',
  executing: 'Executing…',
  executed: 'Executed',
  execution_failed: 'Execution failed',
  expired: 'Expired',
  superseded: 'Superseded',
  locked: 'Locked (too many failed code attempts)',
};

function stateLabel(r: DeployRequestView): string {
  if (r.desktopState === 'rejected') return 'Rejected';
  return STATE_LABEL[r.status] ?? r.status;
}

function orgClass(orgType: string): string {
  return orgType === 'production' ? 'prod' : orgType === 'sandbox' ? 'dev' : 'other';
}

function ReviewPanel({ request }: { request: DeployRequestView }) {
  const { approve, reject, deciding, error, clearError } = useDeploys();
  const [comment, setComment] = useState('');
  const isProd = request.orgType === 'production';
  const expired = new Date(request.expiresAt).getTime() < Date.now();
  const approvable =
    request.status === 'validated' && request.desktopState !== 'rejected' && !expired;
  const busy = deciding === request.id;
  // Nothing to show = nothing to judge. A blank review must never carry an
  // enabled Approve button (plugin-era rows, unparsed summaries).
  const describable =
    request.changes.length +
      request.destructive.length +
      request.changeRows.length +
      request.destructiveRows.length +
      request.results.length >
    0;

  // A component read from a file was not authored by the approver, so the row
  // has to say which file and carry its fingerprint.
  const provenance = (c: { sourcePath?: string; sourceSha256?: string }): string | undefined =>
    c.sourcePath ? `from ${c.sourcePath}  ·  sha256 ${(c.sourceSha256 ?? '').slice(0, 16)}…` : undefined;
  const rows = request.changes.length
    ? request.changes.map((c) => ({
        label: `${c.change.toUpperCase()}  ${c.type}:${c.apiName}`,
        warnings: c.warnings,
        detail: provenance(c),
      }))
    : request.changeRows;
  const destructiveRows = request.destructive.length
    ? request.destructive.map((c) => ({
        label: `DELETE  ${c.type}:${c.apiName}`,
        warnings: c.warnings,
        detail: provenance(c),
      }))
    : request.destructiveRows;

  return (
    <div className="panel">
      {/* THE TARGET — impossible to miss, impossible to mistake. */}
      <div className={`deploy-target env-${orgClass(request.orgType)}`}>
        <div className="deploy-target-alias">{request.alias}</div>
        <div className="deploy-target-org">
          {request.orgName ?? request.instanceUrl} · <strong>{request.orgType}</strong>
        </div>
        <div className="conn-detail meter-dim">
          {request.kind === 'deploy'
            ? 'Metadata deploy'
            : request.kind === 'apex'
              ? 'Anonymous Apex script'
              : 'Data change (DML)'}{' '}
          ·{' '}
          {stateLabel(request)} · expires {new Date(request.expiresAt).toLocaleTimeString()}
        </div>
      </div>

      {request.warnings.length > 0 && (
        <div className="notice">
          {request.warnings.map((w, i) => (
            <div key={i}>⚠ {w}</div>
          ))}
        </div>
      )}

      {destructiveRows.length > 0 && (
        <div className="deploy-section deploy-destructive">
          <h3>Destructive changes</h3>
          {destructiveRows.map((row, i) => (
            <div key={i} className="deploy-row">
              <div>{row.label}</div>
              {row.detail && <div className="deploy-source">{row.detail}</div>}
              {row.warnings.map((w, j) => (
                <div key={j} className="deploy-warning">
                  ⚠ {w}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {rows.length > 0 && (
        <div className="deploy-section">
          <h3>Changes</h3>
          {rows.map((row, i) => (
            <div key={i} className="deploy-row">
              <div>{row.label}</div>
              {row.detail && <div className="deploy-source">{row.detail}</div>}
              {row.warnings.map((w, j) => (
                <div key={j} className="deploy-warning">
                  ⚠ {w}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {request.results.length > 0 && (
        <div className="deploy-section">
          <h3>Validation</h3>
          {request.results.map((r, i) => (
            <div key={i} className={`deploy-result${r.bad ? ' bad' : ''}`}>
              <span>{r.label}</span>
              <span>{r.value}</span>
            </div>
          ))}
        </div>
      )}

      {request.blast.length > 0 && (
        <div className="deploy-section">
          <h3>Blast radius</h3>
          {request.blast.map((b, i) => (
            <div key={i} className="deploy-row">
              {b}
            </div>
          ))}
        </div>
      )}

      {request.approvedAt && (
        <p className="conn-detail meter-dim">
          {request.desktopState === 'rejected' ? 'Rejected' : 'Approved'}{' '}
          {new Date(request.approvedAt).toLocaleString()}
          {request.approvedComment && ` — “${request.approvedComment}”`}
        </p>
      )}

      {request.resultSummary && (
        <div className="deploy-section">
          <h3>Result</h3>
          <pre className="diff-raw">{request.resultSummary}</pre>
        </div>
      )}

      {error && (
        <div className="notice clickable" onClick={clearError}>
          {error}
        </div>
      )}

      {approvable && !describable && (
        <div className="notice">
          This request carries no reviewable detail in Contrail — it was created outside this app
          (or its summary could not be read). Approve it where it was created, or ask the agent to
          re-validate here so you can see exactly what would run.
        </div>
      )}

      {approvable && describable && (
        <>
          <div className="form-row">
            <label>
              {isProd
                ? 'Approval comment (REQUIRED for production)'
                : 'Approval comment (optional)'}
            </label>
            <textarea
              rows={2}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder={isProd ? 'Why this is going to production now' : ''}
            />
          </div>
          <div className="form-actions">
            <button
              className="primary"
              disabled={busy || (isProd && !comment.trim())}
              onClick={() => void approve(request.id, comment)}
            >
              {busy ? 'Executing…' : `Approve & execute on ${request.alias}`}
            </button>
            <button
              className="ghost-danger"
              disabled={busy}
              onClick={() => void reject(request.id, comment)}
            >
              Reject
            </button>
          </div>
          <p className="hint">
            Approving executes immediately through the same single-use machinery as always — the
            agent never sees a code, and this screen is the only place a write can be released.
          </p>
        </>
      )}
    </div>
  );
}

export function DeploysScreen() {
  const { requests, current, refresh, open, close } = useDeploys();
  const { deployId } = useNav();

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Chat's "Review & approve" lands here with a specific request.
  useEffect(() => {
    if (deployId) void open(deployId);
  }, [deployId, open]);

  return (
    <>
      <div className="screen-head">
        <h1>Deploys</h1>
      </div>
      {current ? (
        <>
          <button className="crumb" onClick={close}>
            ← All requests
          </button>
          <ReviewPanel request={current} />
        </>
      ) : requests === null ? (
        <div className="empty">Loading…</div>
      ) : requests.length === 0 ? (
        <div className="empty">
          No deploy requests yet. When an agent validates a deploy or proposes a data change, it
          lands here for your approval.
        </div>
      ) : (
        <div className="panel-list">
          {requests.map((r) => (
            <div key={r.id} className="row-card clickable" onClick={() => void open(r.id)}>
              <div className="conn-main">
                <div>
                  <span className={`env-badge env-${orgClass(r.orgType)}`}>{r.orgType}</span>{' '}
                  <span className="conn-alias">{r.alias}</span>{' '}
                  <span className="meter-dim">
                    {r.kind === 'deploy'
                      ? 'metadata deploy'
                      : r.kind === 'apex'
                        ? 'anonymous Apex'
                        : 'data change'}
                  </span>
                </div>
                <div className="conn-detail">
                  {stateLabel(r)} · {r.destructive.length + r.destructiveRows.length > 0 && '🔴 '}
                  {Math.max(r.changes.length, r.changeRows.length)} change
                  {Math.max(r.changes.length, r.changeRows.length) === 1 ? '' : 's'}
                  {Math.max(r.destructive.length, r.destructiveRows.length) > 0 &&
                    `, ${Math.max(r.destructive.length, r.destructiveRows.length)} destructive`}{' '}
                  · {new Date(r.createdAt).toLocaleString()}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
