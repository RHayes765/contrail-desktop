import type {
  DeployChangeView,
  DeployGovernanceView,
  DeployRequestView,
  DeployReviewRowView,
  DeploySnapshotRebaselineView,
  DeployTargetCheckView,
} from '@contrail/shared';

/**
 * The Deploy Review's composed text: state labels, the structured rows a
 * request validated outside this app is rebuilt with (no presenter rows,
 * no review_json), the target-check headline and the target-moved and
 * revert wording. Pure — no React — so every sentence is testable without
 * a renderer.
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

export function stateLabel(
  r: Pick<DeployRequestView, 'kind' | 'status' | 'desktopState' | 'targetMoved' | 'deciding'> & {
    expiresAt?: string;
  },
  now: number = Date.now(),
): string {
  if (r.desktopState === 'rejected') return 'Rejected';
  // S45 F2: the execute-time guard voided it — approved, but nothing ran.
  if (r.targetMoved) return 'Target moved — not executed';
  // An approval in flight in main: the row stays 'validated' while the
  // target is re-checked (deploy, DML, activation), before the claim.
  if (r.deciding && r.status === 'validated' && r.desktopState === 'approved') {
    return r.kind === 'deploy' || r.kind === 'dml' || r.kind === 'activation'
      ? 'Approved — re-checking the target…'
      : 'Approved — starting…';
  }
  // Past its expiry, the row stays 'validated' until the next validation's
  // sweep — it can no longer be approved.
  if (r.status === 'validated' && r.expiresAt && new Date(r.expiresAt).getTime() < now) {
    return 'Expired';
  }
  return STATE_LABEL[r.status] ?? r.status;
}

/**
 * The target-moved panel's lead. The guard also voids members whose stamp
 * falls within its ordering margin BEFORE validation began, so the lead
 * never says "after"; the engine's refusal below it says what and when.
 */
export const TARGET_MOVED_LEAD =
  'Contrail re-checked the org before executing and found the target had changed (or could ' +
  'not rule a change out), so it did NOT execute this and voided its code. The refusal below ' +
  'says what changed and when. Re-validate to see the current state and get a fresh approval.';

/** A revert package's delete line — conditional when the deploy's outcome is unknown. */
export function revertDeleteLabel(
  m: { type: string; apiName: string },
  outcome: 'executed' | 'unknown',
): string {
  return (
    `delete ${m.type}:${m.apiName} (this deploy added it` +
    `${outcome === 'unknown' ? ', if it committed' : ''})`
  );
}

/**
 * S45 F2: the target check's headline. 'ok' says what was compared, per
 * kind: a deploy's guard compared last-modified STAMPS (evidence, not
 * bytes; a change during the org's own processing is not caught); a DML's,
 * the approved before-values; an activation's, the version's status.
 */
export function targetCheckHeadline(
  kind: DeployRequestView['kind'],
  check: DeployTargetCheckView,
): string {
  if (check.status === 'unavailable') {
    return `NOT re-checked — ${check.reason ?? 'Contrail could not re-read the org'}`;
  }
  if (check.status === 'not_checked') return 'NOT re-checked — nothing could be compared';
  if (check.status !== 'ok') return 'Not applicable';
  const n = check.checked.length;
  if (n === 0 && check.unchecked.length > 0) {
    return kind === 'dml'
      ? 'Re-checked before executing — the records still exist, but no approved values were ' +
          'shown to compare'
      : 'Re-checked before executing — nothing could be compared';
  }
  const at = check.checkedAt ? ` at ${new Date(check.checkedAt).toLocaleTimeString()}` : '';
  return (
    `Re-checked before executing${at} — ` +
    (kind === 'deploy'
      ? deployCheckedText(check)
      : kind === 'dml'
        ? `values of ${n} record(s) unchanged`
        : kind === 'activation'
          ? 'status unchanged'
          : `${n} compared, none had changed`)
  );
}

/**
 * A deploy's 'ok' headline body. S46 D4: a checked member marked 'absent'
 * was one the approval assumed absent, and the execute-time read returned
 * nothing for it — no stamp was compared, so it is never counted among the
 * unchanged stamps. "The approval assumed absent", never "absent at
 * validate": with no live baseline validate did not read the org, and the
 * assumption is the local snapshot's ADD. "Returned nothing", never "the org
 * has none": for some types the read is a filtered query.
 */
function deployCheckedText(check: DeployTargetCheckView): string {
  const a = check.checked.filter((m) => m.state === 'absent').length;
  const s = check.checked.length - a;
  if (a === 0) {
    return (
      `last-modified stamps of ${s} member(s) unchanged (stamps, not bytes; a change ` +
      "during the org's own processing is not caught)"
    );
  }
  if (s === 0) {
    return (
      `${a} member(s) the approval assumed absent: the execute-time read returned nothing for ` +
      "them (no stamp was compared; a change during the org's own processing is not caught)"
    );
  }
  return (
    `last-modified stamps of ${s} member(s) unchanged, and the execute-time read returned ` +
    `nothing for ${a} member(s) the approval assumed absent (stamps, not bytes; a change ` +
    "during the org's own processing is not caught)"
  );
}

/** Local "YYYY-MM-DD HH:MM", as the approval page prints its dates. */
export function localStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/**
 * A component read from a file was not authored by the approver, so the row
 * has to say which file and carry its fingerprint.
 */
export function provenance(
  c: Pick<DeployChangeView, 'sourcePath' | 'sourceSha256'>,
): string | undefined {
  return c.sourcePath
    ? `from ${c.sourcePath}  ·  sha256 ${(c.sourceSha256 ?? '').slice(0, 16)}…`
    : undefined;
}

/**
 * S45: who and when for the live copy validate read — the approval page put
 * this in the row's detail, which only the summary's pre_image keeps for a
 * request validated outside this app. Nothing when the org gave no stamp.
 */
export function preImageDetail(c: Pick<DeployChangeView, 'preImage'>): string | undefined {
  const p = c.preImage;
  if (!p) return undefined;
  if (p.present === false) return 'not in the org at validate';
  if (!p.lastModifiedDate) return undefined;
  return (
    `live copy last modified by ${p.lastModifiedBy ?? 'an unknown user'} at ` +
    localStamp(p.lastModifiedDate)
  );
}

/** One structured row: label, the summary's warnings, provenance + live who/when. */
export function structuredRow(c: DeployChangeView, label: string): DeployReviewRowView {
  const detail = [provenance(c), preImageDetail(c)].filter(Boolean).join('  ·  ');
  return { label, warnings: c.warnings, ...(detail ? { detail } : {}) };
}

// ── S46 (B): the change record and the policy gate ──────────────────────

/** CR LF and lone CR folded to LF, then trimmed — how main compares texts. */
function foldedText(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim();
}

/**
 * What the comment box starts with: the request's justification (the
 * agent's draft, or a text typed earlier on the approval page), or nothing.
 */
export function commentPrefill(g: DeployGovernanceView | null): string {
  return g?.justification?.text ?? '';
}

/** The approval comment's label: production first, then a policy that requires one. */
export function commentLabel(isProd: boolean, g: DeployGovernanceView | null): string {
  if (isProd) return 'Approval comment (REQUIRED for production)';
  if (g?.justificationRequired) return 'Approval comment (REQUIRED by policy)';
  return 'Approval comment (optional)';
}

/**
 * The hint under the comment box: whose words it holds. Approving records
 * the comment as the request's justification; Reject never sends the
 * prefilled text as the human's reason.
 */
export function commentHint(g: DeployGovernanceView | null, comment: string): string | null {
  const j = g?.justification ?? null;
  const prefill = j && j.text !== '' ? j : null;
  if (prefill && foldedText(comment) === foldedText(prefill.text)) {
    return prefill.source === 'agent'
      ? 'Drafted by the agent — edit it if it is not what you would say. Approving records it ' +
          'as your approval comment; Reject sends a reason only if you type one over it.'
      : `${prefill.provenance} Reject sends a reason only if you type one over it.`;
  }
  if (foldedText(comment) === '') return null;
  return 'Edited — recorded as typed in Deploy Review.';
}

/** Reject never sends the prefilled text: only words typed over it are a reason. */
export function rejectComment(comment: string, prefill: string): string {
  return comment.trim() === prefill.trim() ? '' : comment;
}

/**
 * Blocked only because a required justification is missing, while a change
 * freeze is also in effect and no emergency reason is recorded. Once the
 * human types the justification, main re-evaluates with it and the freeze
 * then holds the request — so the blocked card also asks for the emergency
 * reason, and Approve needs both.
 */
export function blockedAlsoFrozen(g: DeployGovernanceView | null): boolean {
  return (
    g !== null &&
    g.gate === 'blocked' &&
    g.blockedOnlyByJustification &&
    g.freezeActive &&
    g.override === null
  );
}

/**
 * Approve stays disabled while: a decision is in flight; production or a
 * policy needs a comment and there is none; a change freeze holds the
 * request and no emergency reason long enough is typed; a policy blocks it —
 * unless the only thing missing is a justification and one is typed (main
 * re-evaluates with that text), with an emergency reason too when a change
 * freeze is also in effect.
 */
export function approveDisabled(input: {
  busy: boolean;
  isProd: boolean;
  governance: DeployGovernanceView | null;
  comment: string;
  reason: string;
}): boolean {
  const g = input.governance;
  const hasComment = input.comment.trim() !== '';
  if (input.busy) return true;
  if ((input.isProd || g?.justificationRequired === true) && !hasComment) return true;
  if (!g) return false;
  if (g.gate === 'frozen' && input.reason.trim().length < g.reasonMin) return true;
  if (g.gate === 'blocked' && !(g.blockedOnlyByJustification && hasComment)) return true;
  if (blockedAlsoFrozen(g) && input.reason.trim().length < g.reasonMin) return true;
  return false;
}

/** The policy list's heading — the approval page's two variants. */
export function policyHeading(source: DeployGovernanceView['policySource']): string {
  return source === 'config'
    ? 'Policies on this connection (from config.json):'
    : "Policies on this connection (Contrail's built-in default — config.json has no policies section):";
}

/**
 * The CHANGE FREEZE banner's note in Deploy Review. It points at the
 * emergency-reason field and Approve, so it is shown only when those are
 * (`approvable`: the comment form is on the screen); otherwise null.
 */
export function freezeReviewNote(approvable: boolean): string | null {
  return approvable
    ? 'While the freeze lasts, Approve stays disabled until you type an emergency reason. It is ' +
        'recorded in the audit log as a freeze override for this request only; the freeze itself ' +
        'stays configured.'
    : null;
}

/**
 * A request past its expiry that the engine has not yet closed (it stays
 * 'validated' until the next validation's sweep): no form is shown for it.
 */
export function expiredReviewText(kind: DeployRequestView['kind']): string {
  return (
    'This request has expired and can no longer be approved — ask the agent to ' +
    `${kind === 'deploy' ? 'validate it again' : 'propose it again'}.`
  );
}

/** The emergency-reason field's label. */
export const EMERGENCY_REASON_LABEL = 'Emergency reason (REQUIRED to approve during the freeze)';

/** The overridden banner's line: the reason the human recorded, and when. */
export function overrideRecordedText(o: { reason: string; at: string }): string {
  const d = new Date(o.at);
  const pad = (n: number) => String(n).padStart(2, '0');
  const at = Number.isNaN(d.getTime()) ? '--:--' : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return (
    `Emergency reason recorded at ${at}: “${o.reason}”. The override applies to this request ` +
    'only and is in the audit log; the freeze stays configured.'
  );
}

/**
 * The BLOCKED BY POLICY banner's closing line, by what blocks the request.
 * `approvable`: the comment form is on the screen — only then does the line
 * point at fields below.
 */
export function blockedClosingText(g: DeployGovernanceView, approvable: boolean): string {
  if (g.blockedBy === 'unreadable') {
    return (
      'Contrail could not read the policies in config.json — the line above says why. Nothing ' +
      'can be approved until the file is fixed; open this request again once it is.'
    );
  }
  if (g.blockedOnlyByJustification) {
    const needs =
      "This request does not satisfy this connection's policies as they stand now: it needs a " +
      'justification.';
    if (!approvable) {
      return blockedAlsoFrozen(g)
        ? `${needs} A change freeze is also in effect on this connection.`
        : needs;
    }
    const text = `${needs} Type it as the approval comment below — Approve records it with the request.`;
    return blockedAlsoFrozen(g)
      ? `${text} A change freeze is also in effect on this connection, so Approve also needs an ` +
          'emergency reason, typed below. It is recorded in the audit log as a freeze override ' +
          'for this request only; the freeze itself stays configured.'
      : text;
  }
  return (
    "This request does not satisfy this connection's policies as they stand now — the lines " +
    'above say what is missing. Ask the agent to propose the change again.'
  );
}

/**
 * The policy check recorded when the request executed — when, which rules
 * applied, and whether a freeze held it (released by an emergency reason).
 * null when none was recorded (not executed, or executed before 0.40).
 */
export function executeCheckText(g: DeployGovernanceView | null): string | null {
  const c = g?.executeCheck;
  if (!c) return null;
  const rules = c.rules.length ? `rules ${c.rules.map((r) => `"${r}"`).join(', ')}` : 'no rule applied';
  const freeze = c.freezeActive
    ? c.overridden
      ? '; a change freeze was in effect, released for this request by the emergency reason'
      : '; a change freeze was in effect'
    : '';
  return `Policies re-checked when it executed (${localStamp(c.at)}): ${rules}${freeze}.`;
}

// ── S46 (C): the snapshot re-baseline after an executed deploy ──────────

/**
 * The result panel's snapshot lines. `notice` lines render as a warning.
 * `pending` is keyed on `deciding`: while this app's approval is still in
 * flight nothing has failed — the row is stored 'executed' with a pending
 * block until the engine amends it. null: nothing to say (`disabled`, or no
 * block).
 */
export function snapshotRebaselineLines(
  s: DeploySnapshotRebaselineView | null,
  deciding: boolean,
): { notice: boolean; text: string; rows: string[] } | null {
  if (!s) return null;
  const done = s.rebaselined.length + s.removed.length;
  const rows = s.skipped.map((m) => `${m.type} ${m.apiName} — ${m.reason}`);
  switch (s.status) {
    case 'complete':
      return { notice: false, text: `Local snapshot updated for ${done} component(s).`, rows: [] };
    case 'partial':
      return {
        notice: false,
        text: `Local snapshot updated for ${done} of ${done + s.skipped.length} component(s). Not updated:`,
        rows,
      };
    case 'none':
      // A parent document or folder re-read for skipped members was still
      // written: "not updated" would contradict the rows below it.
      return s.wroteDocuments
        ? {
            notice: false,
            text:
              'No component in this deploy was re-baselined, but Contrail re-wrote in the local ' +
              'snapshot a parent document or folder it re-read for them:',
            rows,
          }
        : { notice: false, text: 'Local snapshot not updated for this deploy:', rows };
    case 'unavailable':
      return {
        notice: true,
        text:
          s.reason === 'failed_after_write'
            ? `Local snapshot may be only partly updated — ${s.note}`
            : `Local snapshot NOT updated — ${s.note}`,
        rows: [],
      };
    case 'pending':
      return deciding
        ? { notice: false, text: 'Updating the local snapshot for this deploy…', rows: [] }
        : {
            notice: true,
            text:
              'No finished snapshot update is recorded for this deploy — the snapshot may be ' +
              'stale for its components.',
            rows: [],
          };
    case 'disabled':
      return null;
  }
}
