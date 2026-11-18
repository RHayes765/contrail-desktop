import type {
  DeployChangeView,
  DeployRequestView,
  DeployReviewRowView,
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
  r: Pick<DeployRequestView, 'kind' | 'status' | 'desktopState' | 'targetMoved' | 'deciding'>,
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
