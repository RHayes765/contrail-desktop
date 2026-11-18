import { useEffect, useState } from 'react';
import type {
  DeployGovernanceView,
  DeployRequestView,
  DeployReviewRowView,
  DeployRowDiffView,
  DeployTargetCheckView,
  ObjectAutomationView,
} from '@contrail/shared';
import {
  EMERGENCY_REASON_LABEL,
  TARGET_MOVED_LEAD,
  approveDisabled,
  blockedAlsoFrozen,
  blockedClosingText,
  commentHint,
  commentLabel,
  commentPrefill,
  executeCheckText,
  expiredReviewText,
  freezeReviewNote,
  localStamp,
  overrideRecordedText,
  policyHeading,
  rejectComment,
  revertDeleteLabel,
  snapshotRebaselineLines,
  stateLabel,
  structuredRow,
  targetCheckHeadline,
} from '../lib/deployReview.js';
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

function orgClass(orgType: string): string {
  return orgType === 'production' ? 'prod' : orgType === 'sandbox' ? 'dev' : 'other';
}

/** Same rendering of an XML side as the Diff screen's drill panel. */
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

/**
 * S45 F1: one review row's diff — against the live org retrieved at
 * validate, or the snapshot when that retrieve failed (the summary line
 * says which). Collapsed by default, in the Diff screen's drill-panel
 * classes. The text is raw org text: React renders it as text, never markup.
 */
function DeployRowDiff({ diff }: { diff: DeployRowDiffView }) {
  if (diff.identical) return <div className="deploy-source deploy-diff">{diff.summary}</div>;
  const filesAdded = diff.counts?.filesAdded ?? [];
  const filesRemoved = diff.counts?.filesRemoved ?? [];
  return (
    <details className="deploy-diff">
      <summary className="deploy-source">{diff.summary}</summary>
      {diff.changes && diff.changes.length > 0 && (
        <div className="diff-changes">
          {diff.changes.map((change, i) => (
            <div key={i} className="diff-change">
              {change.kind === 'scalar' ? (
                <>
                  <span className="diff-path">{change.path || '(root)'}</span>
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
        </div>
      )}
      {filesAdded.length > 0 && (
        <div className="deploy-source">added: {filesAdded.join(', ')}</div>
      )}
      {filesRemoved.length > 0 && (
        <div className="deploy-source">removed: {filesRemoved.join(', ')}</div>
      )}
      {diff.hunks && diff.hunks.length > 0 && (
        <div className="diff-hunks">
          {diff.hunks.map((hunk, i) => (
            <div key={i} className="diff-hunk">
              <div className="conn-detail">
                {hunk.file ? `${hunk.file} · ` : ''}@@ −{hunk.a_line} +{hunk.b_line} @@
              </div>
              {hunk.removed.map((line, j) => (
                <div key={`r${j}`} className="hunk-line removed">
                  - {line}
                </div>
              ))}
              {hunk.removed_truncated && (
                <div className="hunk-line removed meter-dim">⋯ more removed lines</div>
              )}
              {hunk.added.map((line, j) => (
                <div key={`a${j}`} className="hunk-line added">
                  + {line}
                </div>
              ))}
              {hunk.added_truncated && (
                <div className="hunk-line added meter-dim">⋯ more added lines</div>
              )}
            </div>
          ))}
        </div>
      )}
      {diff.note ? (
        <div className="deploy-source">{diff.note}</div>
      ) : (
        diff.truncated && (
          <div className="deploy-source">
            … truncated — more differences than this review shows
          </div>
        )
      )}
    </details>
  );
}

/** One review row: label, provenance/detail, warnings, then (S45) its diff. */
function ReviewRow({ row }: { row: DeployReviewRowView }) {
  return (
    <div className="deploy-row">
      <div>{row.label}</div>
      {row.detail && <div className="deploy-source">{row.detail}</div>}
      {row.warnings.map((w, j) => (
        <div key={j} className="deploy-warning">
          ⚠ {w}
        </div>
      ))}
      {row.diff && <DeployRowDiff diff={row.diff} />}
    </div>
  );
}


/**
 * S45 F3: the automation card, worded as the approval page's
 * (pages.ts renderAutomationCard): read from the LOCAL SNAPSHOT, never the
 * org, with the mandatory not-covered list. An Apex script naming no object
 * still shows the card (D6) — with a dateless heading, since no snapshot row
 * was read.
 */
function AutomationSection({
  kind,
  list,
  extraNotCovered,
}: {
  kind: DeployRequestView['kind'];
  list: ObjectAutomationView[];
  extraNotCovered: string[];
}) {
  const dates = [
    ...new Set(list.flatMap((a) => (a.snapshot_at ? [localStamp(a.snapshot_at)] : []))),
  ];
  const heading =
    (list.length
      ? `AUTOMATION IN YOUR SNAPSHOT (from ${dates.length ? dates.join(', ') : 'an unknown date'})`
      : 'AUTOMATION IN YOUR SNAPSHOT') + ' — read from the local snapshot, not the live org';
  const notCovered = [...new Set([...list.flatMap((a) => a.not_covered), ...extraNotCovered])];
  return (
    <div className="deploy-section">
      <h3>{heading}</h3>
      {kind === 'apex' && (
        <div className="deploy-row">
          Objects this script MAY touch (parsed from the text; dynamic SOQL and called Apex hide
          more): {list.length ? list.map((a) => a.object).join(', ') : 'none found in the text'}
        </div>
      )}
      {list.map((a, i) => (
        <div key={i} className="deploy-row">
          <div>{a.object}</div>
          {a.summary_lines.map((line, j) => (
            <div key={`l${j}`} className="deploy-source">
              {line}
            </div>
          ))}
          {a.notes.map((note, j) => (
            <div key={`n${j}`} className="deploy-warning">
              {note}
            </div>
          ))}
        </div>
      ))}
      {notCovered.length > 0 && (
        <div className="deploy-row">
          <div className="meter-dim">Not visible in the snapshot:</div>
          <ul className="deploy-nc">
            {notCovered.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** S45 F2: what the execute-time target check reported on the result. */
function TargetCheckSection({
  kind,
  check,
}: {
  kind: DeployRequestView['kind'];
  check: DeployTargetCheckView;
}) {
  return (
    <div className="deploy-section">
      <h3>Target check</h3>
      <div className="deploy-row">{targetCheckHeadline(kind, check)}</div>
      {check.note && <div className="deploy-source">{check.note}</div>}
      {check.unchecked.length > 0 && (
        <div className="deploy-row">
          <div className="meter-dim">Could not be re-checked:</div>
          {check.unchecked.map((u, i) => (
            <div key={i} className="deploy-source">
              {u.label}
              {u.state ? ` — ${u.state}` : ''}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * S46 (B): the emergency-reason field — the human's break-glass for this
 * request only. Rendered by the frozen card, and by the blocked card when
 * the only thing missing is a justification while a freeze is also in effect.
 */
function EmergencyReasonField({
  reasonMin,
  reason,
  setReason,
}: {
  reasonMin: number;
  reason: string;
  setReason: (value: string) => void;
}) {
  return (
    <div className="form-row">
      <label>{EMERGENCY_REASON_LABEL}</label>
      <textarea
        rows={3}
        maxLength={1000}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Why this cannot wait until the freeze ends"
      />
      <p className="hint">
        At least {reasonMin} characters. Kept with this request in the audit log and the
        change-evidence dossier.
      </p>
    </div>
  );
}

/**
 * S46 (B): the gate card under the target — a change freeze (with the
 * emergency-reason field, the human's break-glass for this request only),
 * a freeze overridden for this request, or a policy block. A request
 * blocked only for a missing justification while a freeze is also in
 * effect asks for the emergency reason in its blocked card too: once the
 * justification is typed, the freeze holds it. Nothing for an open gate.
 * `approvable`: the comment form is on the screen — the cards point at its
 * fields only then. Every value renders as text.
 */
function GateSection({
  governance,
  approvable,
  reason,
  setReason,
}: {
  governance: DeployGovernanceView;
  approvable: boolean;
  reason: string;
  setReason: (value: string) => void;
}) {
  if (governance.gate === 'frozen') {
    const note = freezeReviewNote(approvable);
    return (
      <div className="deploy-section deploy-destructive deploy-freeze">
        <h3>CHANGE FREEZE</h3>
        {governance.freezeLine && <div className="deploy-row">{governance.freezeLine}</div>}
        {note && <div className="deploy-row">{note}</div>}
        {approvable && (
          <EmergencyReasonField
            reasonMin={governance.reasonMin}
            reason={reason}
            setReason={setReason}
          />
        )}
      </div>
    );
  }
  if (governance.gate === 'overridden') {
    return (
      <div className="deploy-section deploy-destructive deploy-freeze">
        <h3>CHANGE FREEZE — OVERRIDDEN FOR THIS REQUEST</h3>
        {governance.freezeLine && <div className="deploy-row">{governance.freezeLine}</div>}
        {governance.override && (
          <div className="deploy-row">{overrideRecordedText(governance.override)}</div>
        )}
      </div>
    );
  }
  if (governance.gate === 'blocked') {
    const alsoFrozen = blockedAlsoFrozen(governance);
    return (
      <div className={`deploy-section deploy-destructive${alsoFrozen ? ' deploy-freeze' : ''}`}>
        <h3>BLOCKED BY POLICY</h3>
        {governance.blockedLines.map((line, i) => (
          <div key={i} className="deploy-warning">
            ⚠ {line}
          </div>
        ))}
        <div className="deploy-row">{blockedClosingText(governance, approvable)}</div>
        {alsoFrozen && governance.freezeLine && (
          <div className="deploy-row">{governance.freezeLine}</div>
        )}
        {alsoFrozen && approvable && (
          <EmergencyReasonField
            reasonMin={governance.reasonMin}
            reason={reason}
            setReason={setReason}
          />
        )}
      </div>
    );
  }
  return null;
}

/**
 * S46 (B): the Change record — the policies-changed sentence, the ticket
 * (read-only), the justification and whose words it is, and the policies
 * that apply to this connection now. A pending request edits its
 * justification through the approval comment below; a decided one shows
 * what was recorded.
 */
function ChangeRecordSection({
  governance,
  pending,
  editable,
}: {
  governance: DeployGovernanceView;
  /** The request is still 'validated': the policies are evaluated now. */
  pending: boolean;
  /** The approval comment below holds the justification (the form is shown). */
  editable: boolean;
}) {
  const j = governance.justification;
  return (
    <div className="deploy-section">
      <h3>Change record</h3>
      {governance.policyChangedLine && (
        <div className="deploy-warning">⚠ {governance.policyChangedLine}</div>
      )}
      <div className="deploy-row">Ticket: {governance.ticket ?? 'none given'}</div>
      {!editable && (
        <div className="deploy-row">
          <div>Justification: {j && j.text !== '' ? j.text : 'none given'}</div>
          {j && <div className="deploy-source">{j.provenance}</div>}
        </div>
      )}
      {!pending && executeCheckText(governance) && (
        <div className="deploy-source">{executeCheckText(governance)}</div>
      )}
      {pending && governance.blockedBy !== 'unreadable' && (
        <div className="deploy-row">
          <div className="meter-dim">{policyHeading(governance.policySource)}</div>
          {governance.policyLines.length > 0 ? (
            <ul className="deploy-nc">
              {governance.policyLines.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          ) : (
            <div className="deploy-source">No policy rule applies to this connection.</div>
          )}
        </div>
      )}
      {pending &&
        governance.unmatchedRuleLines.map((line, i) => (
          <div key={i} className="deploy-source">
            {line}
          </div>
        ))}
    </div>
  );
}

function ReviewPanel({ request }: { request: DeployRequestView }) {
  const { approve, reject, deciding, error, clearError } = useDeploys();
  // S46 (B): the comment box starts with the request's justification — the
  // agent's draft — so approving it unchanged confirms the draft; the panel
  // is keyed by request id, so the prefill is per request.
  const governance = request.governance;
  const prefill = commentPrefill(governance);
  const [comment, setComment] = useState(prefill);
  const [reason, setReason] = useState('');
  const isProd = request.orgType === 'production';
  const expired = new Date(request.expiresAt).getTime() < Date.now();
  // `deciding`: an approve/reject is already in flight in main — a reloaded
  // renderer must not offer a second one.
  const approvable =
    request.status === 'validated' &&
    request.desktopState !== 'rejected' &&
    !expired &&
    !request.deciding;
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

  // S45: the presenter's rows are the approval page's own rows — label,
  // provenance, warnings and the diff — so they win. A plugin-era row has
  // none and is rebuilt from the structured validation summary: provenance
  // plus the live copy's who/when (its diff was never stored — the notice
  // above says so).
  const fromPresenter = request.changeRows.length + request.destructiveRows.length > 0;
  const rows: DeployReviewRowView[] = fromPresenter
    ? request.changeRows
    : request.changes.map((c) =>
        structuredRow(c, `${c.change.toUpperCase()}  ${c.type}:${c.apiName}`),
      );
  const destructiveRows: DeployReviewRowView[] = fromPresenter
    ? request.destructiveRows
    : request.destructive.map((c) => structuredRow(c, `DELETE  ${c.type}:${c.apiName}`));
  const showAutomation =
    request.automation.length > 0 ||
    (request.kind === 'apex' && request.automationNotCovered.length > 0);
  const revert = request.revertPackage;
  const hint = commentHint(governance, comment);
  // S46 (C): the post-deploy snapshot re-read; `pending` reads by whether
  // this app's approval is still in flight.
  const snapshotLines = snapshotRebaselineLines(request.snapshotRebaseline, request.deciding);

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
              : request.kind === 'bulk'
                ? 'Bulk data load'
                : request.kind === 'activation'
                  ? 'Agent activation change'
                  : 'Data change (DML)'}{' '}
          ·{' '}
          {stateLabel(request)} · expires {new Date(request.expiresAt).toLocaleTimeString()}
        </div>
      </div>

      {governance && (
        <GateSection
          governance={governance}
          approvable={approvable && describable}
          reason={reason}
          setReason={setReason}
        />
      )}

      {request.warnings.length > 0 && (
        <div className="notice">
          {request.warnings.map((w, i) => (
            <div key={i}>⚠ {w}</div>
          ))}
        </div>
      )}

      {/* S45: the live check was unavailable at validate, or the write ran
          without a target check — composed in main from the stored result. */}
      {request.notices.map((n, i) => (
        <div key={i} className="notice">
          ⚠ {n}
        </div>
      ))}

      {request.agentReview && (
        <div
          className={`deploy-section${request.agentReview.verdict === 'fail' ? ' deploy-destructive' : ''}`}
        >
          <h3>
            Adversarial review:{' '}
            <span
              className={`env-chip ${
                request.agentReview.verdict === 'pass'
                  ? 'dev'
                  : request.agentReview.verdict === 'fail'
                    ? 'prod'
                    : 'uat'
              }`}
            >
              {request.agentReview.verdict.toUpperCase()}
            </span>{' '}
            <span className="meter-dim">
              {request.agentReview.model} · {new Date(request.agentReview.at).toLocaleString()}
            </span>
          </h3>
          {request.agentReview.findings.length === 0 ? (
            <div className="deploy-row">No findings — the reviewer looked and found nothing material.</div>
          ) : (
            request.agentReview.findings.map((f, i) => (
              <div key={i} className="deploy-row">
                <div>
                  <strong>[{f.severity}]</strong> {f.title}
                </div>
                {f.detail && <div className="deploy-source">{f.detail}</div>}
              </div>
            ))
          )}
          {request.agentReview.notes && (
            <div className="deploy-row">
              <div className="meter-dim">Agent&apos;s notes: {request.agentReview.notes}</div>
            </div>
          )}
        </div>
      )}

      {destructiveRows.length > 0 && (
        <div className="deploy-section deploy-destructive">
          <h3>Destructive changes</h3>
          {destructiveRows.map((row, i) => (
            <ReviewRow key={i} row={row} />
          ))}
        </div>
      )}

      {rows.length > 0 && (
        <div className="deploy-section">
          <h3>Changes</h3>
          {rows.map((row, i) => (
            <ReviewRow key={i} row={row} />
          ))}
        </div>
      )}

      {showAutomation && (
        <AutomationSection
          kind={request.kind}
          list={request.automation}
          extraNotCovered={request.automationNotCovered}
        />
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

      {governance && (
        <ChangeRecordSection
          governance={governance}
          pending={request.status === 'validated'}
          editable={approvable && describable}
        />
      )}

      {request.approvedAt && (
        <p className="conn-detail meter-dim">
          {request.desktopState === 'rejected' ? 'Rejected' : 'Approved'}{' '}
          {new Date(request.approvedAt).toLocaleString()}
          {request.approvedComment && ` — “${request.approvedComment}”`}
        </p>
      )}

      {request.targetMoved && (
        <div className="deploy-section deploy-destructive">
          <h3>Target moved — not executed</h3>
          <div className="deploy-row">{TARGET_MOVED_LEAD}</div>
          {request.targetMoved.moved.map((m, i) => (
            <div key={i} className="deploy-row">
              <div>
                {m.label}
                {m.state ? ` — ${m.state}` : ''}
              </div>
              {m.detail && <div className="deploy-source">{m.detail}</div>}
            </div>
          ))}
          {request.targetMoved.unchecked.length > 0 && (
            <div className="deploy-row">
              <div className="meter-dim">Could not be re-checked:</div>
              {request.targetMoved.unchecked.map((u, i) => (
                <div key={i} className="deploy-source">
                  {u.label}
                  {u.state ? ` — ${u.state}` : ''}
                </div>
              ))}
            </div>
          )}
          {request.targetMoved.refusal && (
            <div className="deploy-source">{request.targetMoved.refusal}</div>
          )}
        </div>
      )}

      {request.resultSummary && (
        <div className="deploy-section">
          <h3>Result</h3>
          {snapshotLines &&
            (snapshotLines.notice ? (
              <div className="notice">⚠ {snapshotLines.text}</div>
            ) : (
              <div className="deploy-row">{snapshotLines.text}</div>
            ))}
          {snapshotLines?.rows.map((row, i) => (
            <div key={i} className="deploy-source">
              {row}
            </div>
          ))}
          <pre className="diff-raw">{request.resultSummary}</pre>
        </div>
      )}

      {request.targetCheck && (
        <TargetCheckSection kind={request.kind} check={request.targetCheck} />
      )}

      {(revert || request.revertNote) && (
        <div className="deploy-section">
          <h3>Revert package</h3>
          {revert ? (
            <>
              {revert.outcome === 'unknown' && (
                <div className="deploy-warning">Outcome unknown — revert files kept</div>
              )}
              {revert.dir && <div className="deploy-source">{revert.dir}</div>}
              <div className="deploy-row">
                {revert.restores.length} to restore · {revert.deletes.length} to delete ·{' '}
                {revert.notRestorable.length} not restorable
              </div>
              {revert.restores.map((m, i) => (
                <div key={`r${i}`} className="deploy-source">
                  restore {m.type}:{m.apiName}
                  {m.contentFile ? ` ← ${m.contentFile}` : ''}
                </div>
              ))}
              {revert.deletes.map((m, i) => (
                <div key={`d${i}`} className="deploy-source">
                  {revertDeleteLabel(m, revert.outcome)}
                </div>
              ))}
              {revert.notRestorable.map((m, i) => (
                <div key={`n${i}`} className="deploy-warning">
                  not restorable: {m.type}:{m.apiName} — {m.reason}
                </div>
              ))}
              {revert.plan && <div className="deploy-source">plan: {revert.plan}</div>}
              {revert.note && <div className="deploy-source">{revert.note}</div>}
            </>
          ) : (
            <div className="deploy-source">{request.revertNote}</div>
          )}
        </div>
      )}

      {error && (
        <div className="notice clickable" onClick={clearError}>
          {error}
        </div>
      )}

      {/* Past its expiry but not yet closed by the engine: no form below. */}
      {request.status === 'validated' && request.desktopState !== 'rejected' && expired && (
        <div className="notice">{expiredReviewText(request.kind)}</div>
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
            <label>{commentLabel(isProd, governance)}</label>
            <textarea
              rows={2}
              maxLength={1000}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder={
                isProd || governance?.justificationRequired
                  ? 'Why this change is being made now'
                  : ''
              }
            />
            {hint && <p className="hint">{hint}</p>}
          </div>
          <div className="form-actions">
            <button
              className="primary"
              disabled={approveDisabled({ busy, isProd, governance, comment, reason })}
              onClick={() => void approve(request.id, comment, reason)}
            >
              {busy ? 'Executing…' : `Approve & execute on ${request.alias}`}
            </button>
            <button
              className="ghost-danger"
              disabled={busy}
              // S46 (B): the prefilled draft is never sent as the reason.
              onClick={() => void reject(request.id, rejectComment(comment, prefill))}
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
          {/* Keyed by request: the comment prefill and the emergency reason
              belong to one request and never carry over to the next. */}
          <ReviewPanel key={current.id} request={current} />
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
                        : r.kind === 'bulk'
                          ? 'bulk data load'
                          : r.kind === 'activation'
                            ? 'agent activation'
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
