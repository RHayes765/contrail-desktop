import fs from 'node:fs';
import {
  ContrailError,
  POLICY_LIMITS,
  STAMP_NOT_QUERIED_REASON,
  STAMP_NO_ROW_REASON,
  hhmm,
  isProbeable,
  omniStudioValidateText,
  policyChangedText,
  stampQueryFailedReason,
  unmatchedRuleText,
  type ApprovalPresentation,
  type ApprovalPresenter,
  type ApprovalRequestView,
  type ApprovalRowDiff,
  type ComponentPreImage,
  type ConnectionRecord,
  type DeployMovedMember,
  type DeployRequestKind,
  type DeployRequestRecord,
  type EngineDeps,
  type ExecuteSnapshotBlock,
  type GovernanceState,
  type LiveCheckSummary,
  type OmniStudioMetadataSetting,
  type RevertPlanComponent,
  type RevertPlanMember,
  type RevertPlanReason,
  type RevertTargetCheck,
  type SnapshotMember,
  type StoredGovernance,
} from '@contrail/engine';
import type {
  ChatEvent,
  DeployChangeView,
  DeployGovernanceView,
  DeployLiveCheckView,
  DeployPreImageView,
  DeployRequestView,
  DeployReviewRowView,
  DeployRevertPackageView,
  DeployRowDiffView,
  DeploySnapshotMemberView,
  DeploySnapshotRebaselineView,
  DeployTargetCheckView,
  DeployTargetMemberView,
  DeployTargetMovedView,
  ObjectAutomationView,
  PushChannel,
  PushEvents,
  SemanticChangeView,
  TextHunkView,
} from '@contrail/shared';

/**
 * Native deploy approval (spec §M5). The engine's claim machinery — code
 * generation, single-use claim, expiry, supersede, lockout — runs EXACTLY
 * as in Phase 0. What changes is who holds the code and who decides:
 *
 *   - The presenter receives the code and BURIES it: the row already stores
 *     it; the renderer gets a code-free review model; no push channel, view,
 *     event, or transcript ever carries it.
 *   - The renderer's decision is authoritative. Approve reads the code from
 *     the DB row IN MAIN and drives executeDeploy/executeDml through the
 *     normal claim path. The runtime physically lacks this IPC channel.
 *   - An agent's execute_deploy/dml_execute without a human-typed code is
 *     HELD as pending-approval and resolved by the human's decision.
 */

type PushFn = <C extends PushChannel>(channel: C, payload: PushEvents[C]) => void;

/** The Ultracode adversarial review persisted with a request (S28). */
export interface AgentReviewAttachment {
  verdict: 'pass' | 'concerns' | 'fail';
  findings: Array<{ severity: 'blocker' | 'concern' | 'note'; title: string; detail: string }>;
  model: string;
  at: string;
  notes: string | null;
}

export interface DeployAlert {
  requestId: string;
  kind: DeployRequestKind;
  connection: string;
  orgType: string;
}

/** Session-facing surface DeployService needs from AgentSessionManager. */
export interface SessionAnnouncer {
  announce(sessionId: string, event: ChatEvent): void;
}

interface HeldCall {
  sessionId: string;
  requestId: string;
  resolve: (result: { content: Array<{ type: 'text'; text: string }>; isError?: boolean }) => void;
  timer: NodeJS.Timeout;
}

const EXECUTE_POLL_MS = 2_500;
/** How long an agent's write call waits for the human before yielding. */
const HOLD_TIMEOUT_MS = 5 * 60_000;

function okJson(payload: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function refusal(text: string): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  return { content: [{ type: 'text', text }], isError: true };
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

/** The agent's text for an approved request whose execution failed. */
function executionFailedText(kind: DeployRequestKind, detail: unknown): string {
  return (
    `The user approved this ${kind}, but execution failed:\n` +
    JSON.stringify(detail, null, 2).slice(0, 3000)
  );
}

/**
 * S46 (B): the codes of the engine's execute-time policy refusals
 * (assertPolicyAtExecute; the engine's own set is module-private). Such a
 * refusal leaves the request 'validated' and its code unused.
 */
const POLICY_REFUSAL_CODES: ReadonlySet<string> = new Set([
  'policy_freeze',
  'policy_refused',
  'policy_unreadable',
]);

function isPolicyRefusal(err: unknown): boolean {
  return err instanceof ContrailError && POLICY_REFUSAL_CODES.has(err.code);
}

/**
 * S46 (B): how long after an approved deploy's first execute call its job
 * can still be re-checking the target ahead of the claim — the engine bounds
 * that org read at 15 s (TARGET_CHECK_DEADLINE_MS); the rest is margin.
 */
const GUARD_SETTLE_MS = 20_000;

/**
 * S46 (B): Deploy Review's error when the policy check at the claim refused
 * a request just approved there — the policies or a freeze window changed
 * after the approval's own check. Nothing ran and the request is pending
 * again. What the policies require now follows, from the engine's live
 * gate: the engine's refusal itself is written for the agent.
 */
export function executePolicyRefusalText(g: GovernanceState | null): string {
  const lead =
    "Not executed — as execution started, Contrail checked this connection's policies again " +
    'and they refused this request. Nothing ran, and the request is awaiting approval again.';
  if (g?.gate === 'frozen') {
    return (
      `${lead} ${g.freezeLine ?? 'A change freeze is in effect on this connection.'} ` +
      'Approving it during the freeze needs an emergency reason.'
    );
  }
  if (g?.gate === 'blocked') {
    return g.blockedBy === 'unreadable'
      ? `${lead} Contrail could not read the policies in config.json: ${g.blockedLines.join(' ')}`
      : `${lead} What blocks it now: ${g.blockedLines.join('; ')}`;
  }
  return `${lead} The policies allow it now — approve it again to run it.`;
}

/**
 * S45 F2: ONE text for "approved, but the target moved". The held call
 * (approve) and the decided-before-execute replay (interceptAgentExecute)
 * both use it, so the two surfaces cannot drift. `engineRefusal` is the
 * engine's verbatim refusal — member names, who and when, never a code.
 */
export function targetMovedRefusal(kind: DeployRequestKind, engineRefusal: string): string {
  return (
    `The user approved this ${kind}, but Contrail did NOT execute it — the target changed in ` +
    `the org after validation:\n` +
    engineRefusal
  );
}

/**
 * The refusal of a target-moved result (the call's own, or the one stored
 * on the voided row) — null for anything else.
 */
function movedRefusalOf(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;
  if (r.target_moved !== true) return null;
  return typeof r.refusal === 'string' && r.refusal
    ? r.refusal
    : 'TARGET MOVED — not executed, and this code is now void (the engine recorded no ' +
        'further detail). Re-validate to see the current state of the org and get a fresh code.';
}

/**
 * What the agent is told about a request the human already approved, when
 * its codeless execute arrives after the decision. An EXPLICIT switch on
 * the row's status, the same for every kind: only an 'executed' row whose
 * result did not fail reports "executed" — a voided, superseded, expired or
 * locked row did not run, whatever the desktop decision says.
 */
function replayApproved(kind: DeployRequestKind, status: string, result: unknown): ToolResult {
  switch (status) {
    case 'executed':
      return outcomeFailed(result)
        ? refusal(executionFailedText(kind, result))
        : okJson({ approved: true, outcome: 'executed', detail: result });
    case 'execution_failed':
      return refusal(executionFailedText(kind, result));
    case 'superseded': {
      const moved = movedRefusalOf(result);
      if (moved !== null) return refusal(targetMovedRefusal(kind, moved));
      break;
    }
  }
  return refusal(notExecutedText(kind, status));
}

/**
 * An approved request that did not run and is now superseded, expired or
 * locked. ONE text for the replay and approve()'s live held call, so the
 * agent hears the same account of the same row from both.
 */
function notExecutedText(kind: DeployRequestKind, status: string): string {
  return (
    `The user approved this ${kind}, but it did not execute — the request is now ${status}. ` +
    'Re-validate for a fresh code.'
  );
}

/**
 * S46 (C): an approved deploy whose re-read into the local snapshot is still
 * running in this app: the row is stored 'executed' with snapshot.status
 * "pending" while the approval (`deciding`) waits for the engine's final
 * result. Replaying that row would hand the agent a non-final answer.
 */
function rebaselineRunning(row: DeployRequestRecord, deciding: boolean): boolean {
  if (!deciding || row.kind !== 'deploy' || row.status !== 'executed') return false;
  const result = record(row.resultJson ? parseJson(row.resultJson) : null);
  return record(result?.snapshot)?.status === 'pending';
}

/**
 * The agent's text for a request this session's codeless execute cannot be
 * held on (nothing is pending): the human's decision replayed, or — for a
 * request nobody decided in Deploy Review — that it did not execute. null
 * means the engine answers for itself. `deciding`: an approval of this row
 * is still in flight in this app.
 */
function replayRow(
  kind: DeployRequestKind,
  row: DeployRequestRecord,
  deciding: boolean,
): ToolResult | null {
  if (row.desktopState !== 'approved' && row.desktopState !== 'rejected') {
    // Never decided in Deploy Review. Expired or superseded: say so — it did
    // not execute. Anything else (e.g. executed with a code the human typed
    // elsewhere) is the engine's to answer.
    return row.status === 'expired' || row.status === 'superseded'
      ? refusal(neverApprovedText(kind, row.status))
      : null;
  }
  if (row.desktopState === 'rejected') {
    return refusal(
      `The user REJECTED this ${kind}${row.approvedComment ? ` — reason: ${row.approvedComment}` : ''}. ` +
        'Do not retry it as-is; ask the user what should change.',
    );
  }
  if (row.status === 'executing') {
    return okJson({
      status: 'executing',
      request_id: row.id,
      note: 'The user approved it and execution is running. Call again shortly for the outcome.',
    });
  }
  // S46 (C): the deploy committed, but the approval still waits for the
  // re-read — the stored "pending" block is not the outcome (design C,
  // decision 7: a poll in that window re-attaches; the replay waits too).
  if (rebaselineRunning(row, deciding)) {
    return okJson({
      status: 'executing',
      request_id: row.id,
      note:
        'The user approved it and the deploy has completed in the org; Contrail is still ' +
        're-reading the deployed components into the local snapshot. Call again shortly for ' +
        'the final outcome.',
    });
  }
  // S45 F2: an explicit status switch — a target-moved void (or any other
  // non-executed status) must never replay as "executed".
  const result = row.resultJson ? parseJson(row.resultJson) : null;
  return replayApproved(kind, row.status, result);
}

/** A request the human never decided, now expired or superseded: it did not run. */
function neverApprovedText(kind: DeployRequestKind, status: string): string {
  return (
    `Your latest ${kind} request was never approved in Deploy Review and did not execute — it ` +
    `is now ${status}. ${kind === 'deploy' ? 'Validate' : 'Propose'} again for a fresh request.`
  );
}

/**
 * The hold timer's answer when the held request left 'validated' while the
 * call waited (a lapse past expires_at arrives as 'expired'). A Deploy Review
 * decision replays as usual. Undecided, it says what the row is now — never
 * "stays valid" — and while a NEWER request of this (connection, kind) awaits
 * the user (the validation that superseded this one, say) it points the agent
 * there instead of "validate again", which would supersede the request the
 * human may be reviewing. `deciding`: an approval of this row is still in
 * flight in this app.
 */
function lapsedHoldAnswer(
  kind: DeployRequestKind,
  row: DeployRequestRecord,
  awaiting: DeployRequestRecord | null,
  deciding: boolean,
): ToolResult {
  if (row.desktopState === 'approved' || row.desktopState === 'rejected') {
    return replayRow(kind, row, deciding) ?? refusal(notExecutedText(kind, row.status));
  }
  const result = row.resultJson ? parseJson(row.resultJson) : null;
  const elsewhere = 'with a confirmation code entered outside Deploy Review';
  if (row.status === 'executing') {
    return okJson({
      status: 'executing',
      request_id: row.id,
      note: `This ${kind} is executing ${elsewhere}, not by this call — do not execute it again.`,
    });
  }
  if (row.status === 'executed' && !outcomeFailed(result)) {
    return okJson({
      status: 'executed',
      request_id: row.id,
      note: `This ${kind} was executed ${elsewhere} while this call waited — do not execute it again.`,
      detail: result,
    });
  }
  if (row.status === 'executed' || row.status === 'execution_failed') {
    return refusal(
      `This ${kind} was run ${elsewhere} while this call waited, but execution failed:\n` +
        JSON.stringify(result, null, 2).slice(0, 3000),
    );
  }
  const verb = kind === 'deploy' ? 'Validate' : 'Propose';
  const moved = row.status === 'superseded' ? movedRefusalOf(result) : null;
  const what =
    moved !== null
      ? `This ${kind} was never approved in Deploy Review and did not execute — a confirmation ` +
        'code entered outside Deploy Review was refused because the target changed in the org ' +
        `after validation:\n${moved}`
      : row.status === 'superseded'
        ? `A newer ${kind} validation replaced this request before the user decided in Deploy ` +
          'Review, so it did not execute.'
        : `This ${kind} request was never approved in Deploy Review and did not execute — it is ` +
          `now ${row.status}${row.status === 'locked' ? ' (too many wrong confirmation codes)' : ''}.`;
  if (awaiting) {
    return okJson({
      status: row.status,
      request_id: row.id,
      awaiting_request_id: awaiting.id,
      note:
        `${what}\nA newer ${kind} request on this connection is awaiting the user’s decision in ` +
        `Deploy Review — do not ${verb.toLowerCase()} again (that would replace it); call again ` +
        'to wait on it.',
    });
  }
  if (moved !== null) return refusal(what);
  if (row.status === 'expired') return refusal(neverApprovedText(kind, row.status));
  return refusal(
    row.status === 'superseded'
      ? `${what} No ${kind} request on this connection is awaiting a decision now — ` +
          `${verb.toLowerCase()} again only if the user still wants this change.`
      : `${what} ${verb} again for a fresh request.`,
  );
}

/**
 * The engine-facing presenter. Constructed at bootstrap (before services
 * exist), so the service attaches late; a present() before attachment still
 * approves the CONTRACT (native mode, no URL) — but by construction every
 * validate flows through the executor, which requires the service.
 */
export class NativeApprovalPresenter implements ApprovalPresenter {
  /**
   * S46 (B): the surface every mint records as governance.surface, and what
   * the phone push reads — native review keeps the code off the push.
   */
  readonly mode = 'native' as const;
  private service: DeployService | null = null;

  attach(service: DeployService): void {
    this.service = service;
  }

  present(view: ApprovalRequestView): Promise<ApprovalPresentation> {
    this.service?.onPresented(view);
    // No URL, nothing opened in a browser — the review lives in the app.
    return Promise.resolve({ url: null, opened: true, mode: 'native' });
  }

  close(): void {
    // Native review dismisses itself from request state; nothing to tear down.
  }
}

/** One component row as the stored validation summary writes it. */
interface DeploySummaryRow {
  type: string;
  api_name: string;
  change: string;
  warnings: string[];
  source_path?: string;
  source_sha256?: string;
  /** S45 F1: the member's live pre-image summary (ComponentPreImage). */
  pre_image?: unknown;
}

/** One review row as review_json stores it (the presenter's row, code-free). */
interface StoredReviewRow {
  label: string;
  warnings: string[];
  detail?: string;
  /** S45 F1: the engine's ApprovalRowDiff, stored as-is. */
  diff?: unknown;
}

export class DeployService {
  /**
   * Which session asked for a presentation, PER CONNECTION. A single global
   * slot cross-paired approvals under concurrent sessions (validate is a
   * long round-trip); keying by connection means A's approval can never be
   * stamped with B's session unless they share the connection — where
   * supersede already collapses them to one pending request anyway.
   */
  private readonly expectations = new Map<
    string,
    { sessionId: string; at: number; agentReview?: AgentReviewAttachment | null }
  >();
  /** Held agent calls, keyed requestId → sessionId → call (never displaced silently). */
  private readonly held = new Map<string, Map<string, HeldCall>>();
  /**
   * Requests with an approve()/reject() in flight. Since S45 the
   * execute-time guard's org read (up to 15 s) sits between the recorded
   * decision and the claim while the row is still 'validated', so the row's
   * status alone no longer stops a second decision on the same id.
   */
  private readonly deciding = new Set<string>();

  constructor(
    private readonly deps: EngineDeps,
    private readonly push: PushFn,
    private readonly alertApproval: (info: DeployAlert) => void = () => undefined,
    private sessions: SessionAnnouncer | null = null,
  ) {}

  attachSessions(sessions: SessionAnnouncer): void {
    this.sessions = sessions;
  }

  /**
   * Execution now lives in the app's lifetime: a quit or crash between the
   * claim and the finish would strand a row at 'executing' forever (eternal
   * "Executing…", no re-approve, no agent path). Sweep those at startup and
   * tell the human to check the org — we cannot know whether it committed.
   * A stranded DEPLOY is S45's outcome-unknown case: its validate-time
   * pre-images are finalized with outcome:'unknown' BEFORE the flip, since
   * the engine's revert sweep removes an execution_failed row's
   * staging/_reverts/<id> when it holds no revert-plan.json. The engine
   * reads the execute-time target check it persisted at the claim, so the
   * README states it and the result carries it as target_check.
   */
  reconcileStrandedExecutions(maxAgeMs = 30 * 60_000): number {
    const cutoff = Date.now() - maxAgeMs;
    let swept = 0;
    for (const rec of this.deps.db.listDeployRequests({ limit: 200 })) {
      if (rec.status !== 'executing') continue;
      if (new Date(rec.createdAt).getTime() > cutoff) continue;
      // Never throws; null (nothing written) for any other kind.
      const revert =
        rec.kind === 'deploy'
          ? this.deps.deploys.finalizeStrandedRevert(
              rec.id,
              'Contrail closed while this deploy was executing; its outcome was not recorded',
            )
          : null;
      const kept = revert?.revert_package?.dir;
      this.deps.db.finishDeployRequest(
        rec.id,
        'execution_failed',
        JSON.stringify({
          error: 'Contrail closed while this execution was running.',
          note:
            'The change may or may not have committed — check Setup → Deployment Status (or the ' +
            'records) in the target org before retrying.' +
            (typeof kept === 'string'
              ? ` If it committed, what the org held when this package was validated is kept ` +
                `under ${kept} (revert-plan.json, outcome "unknown").`
              : ''),
          stranded: true,
          ...revert,
        }),
      );
      // A stranded row never reaches finishExecution, so its frozen payload
      // (a zip, or a bulk payload DIRECTORY) would leak — sweep it here.
      if (rec.payloadPath) {
        try {
          fs.rmSync(rec.payloadPath, { recursive: true, force: true });
        } catch {
          // Best-effort: a locked file is not worth failing startup over.
        }
      }
      this.deps.audit.record('deploy.stranded', {
        connectionId: rec.connectionId,
        tool: 'startup_reconcile',
        outcome: 'error',
        detail: { requestId: rec.id, kind: rec.kind },
      });
      swept++;
    }
    if (swept > 0) this.push('deploys:changed', { requestId: null });
    return swept;
  }

  /**
   * Executor marks which session's tool call is about to present, for a
   * connection. In Ultracode sessions the matched content-addressed review
   * rides along, to be persisted into review_json at presentation — the
   * human then reads the adversarial verdict beside the change.
   */
  expectPresentation(
    sessionId: string,
    connectionId: string,
    agentReview?: AgentReviewAttachment | null,
  ): void {
    this.expectations.set(connectionId, { sessionId, at: Date.now(), agentReview });
  }

  /**
   * Expectations OUTLIVE the tool call deliberately: validate_deploy is a
   * soft-wait job (the engine returns in_progress and finishes in the
   * background), so clearing on return would orphan the pairing. They are
   * consumed on presentation and swept by age.
   */
  clearExpectation(): void {
    const cutoff = Date.now() - 30 * 60_000;
    for (const [key, exp] of this.expectations) {
      if (exp.at < cutoff) this.expectations.delete(key);
    }
  }

  /** Called by the presenter, inside the engine's validate/propose flow. */
  onPresented(view: ApprovalRequestView): void {
    const rec = this.deps.db.getDeployRequest(view.requestId);
    const connectionId = rec?.connectionId ?? null;
    const expectation = connectionId ? this.expectations.get(connectionId) : undefined;
    if (connectionId) this.expectations.delete(connectionId);
    const sessionId = expectation?.sessionId ?? null;
    // The CODE-FREE review model. view.code exists on the input — it is
    // deliberately never copied here, and every field below is copied by
    // NAME (rows and automation sections included), so nothing the engine
    // adds to the view rides into review_json unreviewed.
    const rows = (list: ApprovalRequestView['changes']): StoredReviewRow[] =>
      (list ?? []).map((r) => ({
        label: r.label,
        warnings: r.warnings ?? [],
        ...(r.detail !== undefined ? { detail: r.detail } : {}),
        // S45 F1: the row's diff (live org or snapshot baseline), already
        // budgeted by the engine; list() omits it, get(id) carries it.
        ...(r.diff ? { diff: r.diff } : {}),
      }));
    const review = {
      kind: view.kind,
      org: view.org,
      changeRows: rows(view.changes),
      destructiveRows: rows(view.destructive),
      results: view.results,
      blast: view.blast,
      warnings: view.warnings ?? [],
      expiresAt: view.expiresAt,
      // S45 F3: the snapshot's automation card — the engine hands the full
      // ObjectAutomation; only the lines the card renders are kept.
      automation: (view.automation ?? []).map((a) => ({
        object: a.object,
        snapshot_at: a.snapshot_at,
        summary_lines: a.summary_lines,
        notes: a.notes,
        not_covered: a.not_covered,
      })),
      // S45 D6: an Apex script naming no object still shows the card.
      automationNotCovered: view.automationNotCovered ?? [],
      // The Ultracode adversarial review of this exact content, when one
      // gated the propose (null otherwise).
      agentReview: expectation?.agentReview ?? null,
    };
    this.deps.db.setDeployRequestDesktopFields(view.requestId, {
      sessionId,
      origin: 'desktop',
      desktopState: 'awaiting_approval',
      reviewJson: JSON.stringify(review),
    });
    this.push('deploys:changed', { requestId: view.requestId });
    const info: DeployAlert = {
      requestId: view.requestId,
      kind: view.kind,
      connection: view.org.alias,
      orgType: view.org.orgType,
    };
    if (sessionId) {
      this.sessions?.announce(sessionId, {
        type: 'approval_required',
        requestId: view.requestId,
        kind: view.kind,
        connection: view.org.alias,
        orgType: view.org.orgType,
      });
    }
    this.alertApproval(info);
  }

  /**
   * Every request, WITHOUT row diffs (S45 R4): the list refreshes on every
   * deploys:changed push — the execution poll fires one every 2.5 s — and
   * must not ship every request's diffs each time. get(id) carries them.
   */
  list(connectionId?: string): DeployRequestView[] {
    return this.deps.db
      .listDeployRequests({ connectionId })
      .map((rec) => this.view(rec, { withDiff: false }))
      .filter((v): v is DeployRequestView => v !== null);
  }

  get(id: string): DeployRequestView {
    const rec = this.deps.db.getDeployRequest(id);
    if (!rec) throw new Error('Deploy request not found.');
    const view = this.view(rec, { withDiff: true });
    if (!view) throw new Error('Deploy request references a removed connection.');
    return view;
  }

  /**
   * THE human decision. Renderer-only path: reads the confirmation code from
   * the row in main and drives the engine's normal claim machinery. Waits
   * for the terminal outcome (long deploys poll via re-invocation).
   * S46 (B): `comment` is also the request's justification (prefilled with
   * the agent's draft), and `emergencyReason` — typed only on this screen —
   * releases a request held by a change freeze, for this request only.
   */
  async approve(id: string, comment?: string, emergencyReason?: string): Promise<DeployRequestView> {
    this.beginDeciding(id);
    try {
      await this.runApproval(id, comment, emergencyReason);
    } finally {
      this.deciding.delete(id);
      // The last push inside runApproval fired while the id was still
      // deciding; a renderer that refreshed then must see it clear.
      this.push('deploys:changed', { requestId: id });
    }
    return this.get(id);
  }

  /**
   * One decision per request at a time — checked before any await or write
   * (a reloaded renderer, or a window closed and reopened on macOS, starts
   * with its own in-memory busy flag cleared). A refused second call changes
   * nothing. Only an in-flight decision blocks: a decision recorded by an
   * approval that an app quit interrupted can still be retried or rejected.
   */
  private beginDeciding(id: string): void {
    if (this.deciding.has(id)) {
      throw new Error('This request is already being decided — wait for its outcome.');
    }
    this.deciding.add(id);
  }

  private async runApproval(id: string, comment?: string, emergencyReason?: string): Promise<void> {
    const rec = this.deps.db.getDeployRequest(id);
    if (!rec) throw new Error('Deploy request not found.');
    if (rec.status !== 'validated') {
      throw new Error(`This request is ${rec.status} — only a validated request can be approved.`);
    }
    if (new Date(rec.expiresAt).getTime() < Date.now()) {
      throw new Error('This request has expired — re-validate to get a fresh one.');
    }
    const conn = this.deps.db.resolveConnection(rec.connectionId);
    if (!conn) throw new Error('The target connection no longer exists.');
    const trimmed = comment?.trim() || null;
    if (conn.orgType === 'production' && !trimmed) {
      throw new Error('Production deploys require an approval comment.');
    }
    // Grants are LIVE law here too: revoking metadata_write/data_write must
    // stop a pending request from executing, exactly as it stops the agent's
    // classic path (this screen bypasses the capability layer's assertGrant).
    // S34: activation is org configuration — metadata_write, like deploys.
    const needed =
      rec.kind === 'deploy' || rec.kind === 'activation' ? 'metadata_write' : 'data_write';
    if (!conn.grants[needed]) {
      this.deps.audit.record('grant.refused', {
        connectionId: conn.id,
        tool: 'deploy_review_screen',
        outcome: 'refused',
        detail: { requestId: id, required: needed },
      });
      throw new Error(
        `${conn.alias} no longer grants ${needed} — re-enable it on the SF Orgs screen, ` +
          'then re-validate.',
      );
    }

    // S46 (B): the change record — validated first, written once, by the
    // engine (DeployEngine.reviewGovernance). The approval comment becomes
    // the request's justification: the agent's draft approved unchanged, a
    // text the human typed earlier left as it is, or the human's own words.
    // During a change freeze the emergency reason typed on this screen is
    // recorded as a freeze override for this request only. The request is
    // evaluated against the policies as they stand now: a policy block, or a
    // freeze with no valid reason, refuses here with nothing written and no
    // decision recorded — the held agent call stays held.
    const gov = this.deps.deploys.reviewGovernance(id, {
      comment: trimmed,
      emergencyReason: emergencyReason?.trim() || null,
    });
    if (!gov.ok) throw new Error(gov.message);

    this.deps.db.recordDeployDecision(id, 'approved', trimmed);
    this.deps.audit.record('deploy.approved', {
      connectionId: conn.id,
      tool: 'deploy_review_screen',
      outcome: 'success',
      detail: {
        requestId: id,
        kind: rec.kind,
        comment: trimmed,
        // Whether the approval comment is the agent's draft approved
        // unchanged, a text the human typed earlier on the approval page,
        // or typed here (now, or on an earlier attempt that did not run).
        ...(trimmed !== null ? { comment_source: gov.commentSource } : {}),
      },
    });
    this.push('deploys:changed', { requestId: id });

    // The code goes row → engine, entirely inside this process.
    const code = rec.confirmationCode;
    // When the first execute call started: a deploy's job re-checks the
    // target ahead of its claim for up to the engine's deadline from here.
    const startedAt = Date.now();
    let detail: unknown;
    let failed = false;
    try {
      if (rec.kind === 'deploy') {
        // Re-invoking with the same code re-attaches to the running job —
        // the claim machinery guarantees exactly one dispatch.
        let outcome = await this.deps.deploys.executeDeploy(conn, code);
        while (outcome.status === 'in_progress') {
          this.push('deploys:changed', { requestId: id });
          await new Promise((r) => setTimeout(r, EXECUTE_POLL_MS));
          outcome = await this.pollDeploy(id, conn, code, startedAt);
        }
        if (outcome.status === 'failed') {
          failed = true;
          detail = { error: outcome.error };
        } else {
          detail = outcome.result;
          // The engine reports deploy outcomes as `deployed`, DML as
          // `executed` — there is no `success` key. Getting this wrong
          // told the agent "executed" for a failed deploy.
          failed = outcomeFailed(outcome.result);
        }
      } else if (rec.kind === 'bulk') {
        // Bulk loads are long-running like deploys: the same soft-wait poll
        // loop, re-attaching by code. This branch MUST precede the DML
        // fallthrough or a bulk row would silently call executeDml.
        let outcome = await this.deps.deploys.executeBulkLoad(conn, code);
        while (outcome.status === 'in_progress') {
          this.push('deploys:changed', { requestId: id });
          await new Promise((r) => setTimeout(r, EXECUTE_POLL_MS));
          outcome = await this.deps.deploys.executeBulkLoad(conn, code);
        }
        if (outcome.status === 'failed') {
          failed = true;
          detail = { error: outcome.error };
        } else {
          detail = outcome.result;
          failed = outcomeFailed(outcome.result);
        }
      } else if (rec.kind === 'apex') {
        const result = await this.deps.deploys.executeApex(conn, code);
        failed = outcomeFailed(result);
        detail = result;
      } else if (rec.kind === 'activation') {
        // Synchronous like apex: one Connect POST + a confirming re-GET.
        const result = await this.deps.deploys.executeActivation(conn, code);
        failed = outcomeFailed(result);
        detail = result;
      } else {
        const result = await this.deps.deploys.executeDml(conn, code);
        failed = outcomeFailed(result);
        detail = result;
      }
    } catch (err) {
      // S46 (B): the policy check at the claim refused it — a freeze window
      // that began, or config.json edited or unreadable, after
      // reviewGovernance passed (for deploy, DML and activation that span
      // includes the target guard's org read). The engine left the row
      // 'validated' and its code unused: nothing ran, so this is no
      // execution outcome. As when reviewGovernance refuses, the held agent
      // call stays held and nothing is announced; the decision is withdrawn
      // (the deploy.approved and policy.refused audit rows stay — both are
      // true history) and Deploy Review shows the refusal.
      if (isPolicyRefusal(err) && this.deps.db.getDeployRequest(id)?.status === 'validated') {
        this.deps.db.clearDeployDecision(
          id,
          rec.desktopState === 'awaiting_approval' ? 'awaiting_approval' : null,
        );
        this.push('deploys:changed', { requestId: id });
        throw new Error(executePolicyRefusalText(this.deps.deploys.governanceState(id)));
      }
      failed = true;
      detail = {
        error: err instanceof ContrailError ? `${err.code}: ${err.message}` : String(err).slice(0, 800),
      };
    }

    // S45 F2: the execute-time guard found the target changed since
    // validation — the request is voided and NOTHING ran. Every kind returns
    // that as its result ({executed:false, target_moved:true, refusal}); a
    // call that lost the race to a concurrent void is refused by the claim
    // instead, so the voided row's stored result is read back for it.
    // A fail-open result (target_check 'unavailable' / 'not_checked') is NOT
    // this: it executed, resolves below as executed with target_check in its
    // detail, and the request view carries the "NOT re-checked" notice.
    // A claim refused because the row left 'validated' during the guard's
    // org read (expired, superseded by a newer validation, locked) did not
    // run either: it gets the replay's own "did not execute" text, never
    // "execution failed".
    let moved = movedRefusalOf(detail);
    let notRun: string | null = null;
    if (moved === null && failed) {
      const after = this.deps.db.getDeployRequest(id);
      if (after?.status === 'superseded' && after.resultJson) {
        moved = movedRefusalOf(parseJson(after.resultJson));
      }
      if (
        moved === null &&
        after &&
        (after.status === 'superseded' || after.status === 'expired' || after.status === 'locked')
      ) {
        notRun = after.status;
      }
    }

    this.push('deploys:changed', { requestId: id });
    this.resolveHeld(
      id,
      moved !== null
        ? refusal(targetMovedRefusal(rec.kind, moved))
        : notRun !== null
          ? refusal(notExecutedText(rec.kind, notRun))
          : failed
            ? refusal(executionFailedText(rec.kind, detail))
            : okJson({ approved: true, outcome: 'executed', detail }),
      moved !== null || failed ? 'execution_failed' : 'executed',
      rec.sessionId,
    );
  }

  /**
   * S46 (B): one poll of an approved deploy. The engine re-checks the
   * policies on a poll before it re-attaches while the row is still
   * 'validated' — that is, while the job the first call started may still be
   * re-checking the target. Such a refusal does not stop that job, whose
   * claim checks the policies once more, so it is the outcome only once that
   * claim has been decided: wait out the guard's deadline, then re-read the
   * row. Still 'validated': the claim was refused too, and nothing ran.
   * Otherwise (claimed, or voided by the guard) this call re-attaches.
   */
  private async pollDeploy(
    id: string,
    conn: ConnectionRecord,
    code: string,
    startedAt: number,
  ): ReturnType<EngineDeps['deploys']['executeDeploy']> {
    try {
      return await this.deps.deploys.executeDeploy(conn, code);
    } catch (err) {
      if (!isPolicyRefusal(err) || this.deps.db.getDeployRequest(id)?.status !== 'validated') {
        throw err;
      }
      const wait = startedAt + GUARD_SETTLE_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (this.deps.db.getDeployRequest(id)?.status === 'validated') throw err;
      return this.deps.deploys.executeDeploy(conn, code);
    }
  }

  /** Reject: the pending code dies with the decision — nothing can execute it later. */
  async reject(id: string, comment?: string): Promise<DeployRequestView> {
    this.beginDeciding(id);
    try {
      this.runRejection(id, comment);
    } finally {
      this.deciding.delete(id);
      this.push('deploys:changed', { requestId: id });
    }
    return this.get(id);
  }

  private runRejection(id: string, comment?: string): void {
    const rec = this.deps.db.getDeployRequest(id);
    if (!rec) throw new Error('Deploy request not found.');
    if (rec.status !== 'validated') {
      throw new Error(`This request is ${rec.status} — only a validated request can be rejected.`);
    }
    let trimmed = comment?.trim() || null;
    // S46 (B): the comment box is prefilled with the request's justification
    // (the agent's draft). That draft is never recorded, or relayed to the
    // held agent call, as the human's rejection reason — only words typed
    // over it are.
    if (trimmed !== null && storedJustificationTexts(rec.summaryJson).includes(folded(trimmed))) {
      trimmed = null;
    }
    this.deps.db.recordDeployDecision(id, 'rejected', trimmed);
    this.deps.db.updateDeployRequestStatus(id, 'superseded');
    this.deps.audit.record('deploy.rejected', {
      connectionId: rec.connectionId,
      tool: 'deploy_review_screen',
      outcome: 'refused',
      detail: { requestId: id, kind: rec.kind, comment: trimmed },
    });
    this.push('deploys:changed', { requestId: id });
    this.resolveHeld(
      id,
      refusal(
        `The user REJECTED this ${rec.kind}${trimmed ? ` — reason: ${trimmed}` : ''}. ` +
          'Do not retry it as-is; ask the user what should change.',
      ),
      'rejected',
      rec.sessionId,
    );
  }

  /**
   * The executor's interception for an agent write call with no human-typed
   * code: hold the tool call on the pending request until the human decides
   * (or the hold times out — the session continues honestly either way).
   * Returns null when there is nothing to intercept (engine speaks for itself).
   */
  interceptAgentExecute(
    sessionId: string,
    kind: DeployRequestKind,
    connectionId: string,
  ): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> | null {
    // Whole history for this (connection, kind) — NOT a 10-row window that a
    // busy connection can push the pending request out of. Prefer the row
    // this very session presented; otherwise the newest pending one.
    const rows = this.deps.db
      .listDeployRequests({ connectionId, limit: 200 })
      .filter((r) => r.kind === kind);
    const pending =
      rows.find((r) => r.status === 'validated' && r.sessionId === sessionId) ??
      rows.find((r) => r.status === 'validated');

    if (!pending) {
      // The human may have already decided — REPLAY the terminal outcome
      // instead of telling the agent to re-validate (which would deploy
      // twice). Only this session's own request is replayed, and only its
      // NEWEST one of this (connection, kind): an older decided row is never
      // replayed past a newer one the human never decided. S45's eager
      // expiry sweep (every real validate) moves undecided rows of every
      // kind and connection to 'expired', so that newer row can be gone
      // from 'validated' without anyone having looked at it.
      const recent = rows.find((r) => r.sessionId === sessionId);
      if (!recent) return null;
      const replay = replayRow(kind, recent, this.deciding.has(recent.id));
      return replay ? Promise.resolve(replay) : null;
    }

    if (new Date(pending.expiresAt).getTime() < Date.now()) return null;
    if (pending.desktopState === 'rejected') {
      return Promise.resolve(refusal('The user rejected this request. Do not retry it as-is.'));
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.held.get(pending.id)?.delete(sessionId);
        // The row may have changed while this call waited — expired (by
        // S45's sweep, or lapsed past expires_at), superseded by a newer
        // validation, locked, run with a code entered elsewhere, or approved
        // and executing. Say what it is now, never "stays valid". An
        // approval counts as starting only while it is in flight here: a
        // decision an app quit interrupted is still awaiting the human.
        const now = this.deps.db.getDeployRequest(pending.id);
        const lapsed =
          now !== null &&
          (now.status !== 'validated' || new Date(now.expiresAt).getTime() < Date.now());
        const answer = !now
          ? null
          : lapsed
            ? lapsedHoldAnswer(
                kind,
                now.status === 'validated' ? { ...now, status: 'expired' } : now,
                this.awaitingRequest(connectionId, kind, now.id),
                this.deciding.has(now.id),
              )
            : now.desktopState === 'approved' && this.deciding.has(now.id)
              ? okJson({
                  status: 'executing',
                  request_id: now.id,
                  note:
                    'The user approved it and execution is starting. Call again shortly for ' +
                    'the outcome.',
                })
              : null;
        resolve(
          answer ??
            okJson({
              status: 'awaiting_approval',
              request_id: pending.id,
              note:
                'Still awaiting the user’s decision in the Deploy Review screen. ' +
                'The request stays valid until it expires; call again after the user decides.',
            }),
        );
      }, HOLD_TIMEOUT_MS);
      const bySession = this.held.get(pending.id) ?? new Map<string, HeldCall>();
      // A second call from the SAME session (SDK retry) resolves the older
      // one honestly instead of orphaning it — an unsettled tool call would
      // wedge that turn forever (the bridge has no timeout).
      const prior = bySession.get(sessionId);
      if (prior) {
        clearTimeout(prior.timer);
        prior.resolve(
          okJson({
            status: 'superseded_by_retry',
            request_id: pending.id,
            note: 'A newer call for the same request is now waiting for the user’s decision.',
          }),
        );
      }
      bySession.set(sessionId, { sessionId, requestId: pending.id, resolve, timer });
      this.held.set(pending.id, bySession);
      this.push('deploys:changed', { requestId: pending.id });
    });
  }

  /**
   * The request of this (connection, kind) other than `exceptId` that still
   * awaits a decision — at most one, since every validate supersedes the
   * pending ones, so it is newer than any row it left behind.
   */
  private awaitingRequest(
    connectionId: string,
    kind: DeployRequestKind,
    exceptId: string,
  ): DeployRequestRecord | null {
    const nowMs = Date.now();
    return (
      this.deps.db
        .listDeployRequests({ connectionId, limit: 200 })
        .find(
          (r) =>
            r.kind === kind &&
            r.id !== exceptId &&
            r.status === 'validated' &&
            new Date(r.expiresAt).getTime() >= nowMs,
        ) ?? null
    );
  }

  /** Session teardown must never leave a held tool call unsettled. */
  releaseHeldForSession(sessionId: string): void {
    for (const [requestId, bySession] of this.held) {
      const held = bySession.get(sessionId);
      if (!held) continue;
      clearTimeout(held.timer);
      bySession.delete(sessionId);
      if (bySession.size === 0) this.held.delete(requestId);
      held.resolve(
        okJson({
          status: 'awaiting_approval',
          request_id: requestId,
          note: 'The session ended while awaiting approval; the request is still in Deploy Review.',
        }),
      );
    }
  }

  private resolveHeld(
    requestId: string,
    result: { content: Array<{ type: 'text'; text: string }>; isError?: boolean },
    outcome: 'executed' | 'execution_failed' | 'rejected',
    sessionId: string | null,
  ): void {
    const bySession = this.held.get(requestId);
    const announced = new Set<string>();
    if (bySession) {
      for (const held of bySession.values()) {
        clearTimeout(held.timer);
        held.resolve(result);
        announced.add(held.sessionId);
      }
      this.held.delete(requestId);
    }
    // Announce to every waiting session AND to the presenting session, so a
    // chat whose call already timed out still sees the decision land.
    if (sessionId) announced.add(sessionId);
    for (const target of announced) {
      this.sessions?.announce(target, { type: 'approval_resolved', requestId, outcome });
    }
  }

  /**
   * The code-free review model of one row. `withDiff` false (list) omits
   * every row's diff — a real omission: rows are rebuilt field by field,
   * so nothing parsed from review_json rides along unnamed.
   */
  private view(rec: DeployRequestRecord, opts: { withDiff: boolean }): DeployRequestView | null {
    const conn = this.deps.db.resolveConnection(rec.connectionId);
    if (!conn) return null;
    const summary = parseJson(rec.summaryJson) as {
      changes?: Array<DeploySummaryRow>;
      destructive?: Array<DeploySummaryRow>;
      blast?: string[];
      // S45 F1: the validate-time live check (deploys).
      live_check?: unknown;
      // S46 (B): the change record minted with the request (absent before 0.40).
      governance?: unknown;
      // S47: the Omnistudio Metadata setting validate read (Data Mapper packages only).
      omnistudio_metadata?: unknown;
      // DML summaries are a preview object, not component lists.
      operation?: string;
      object?: string;
      row_count?: number;
      rows?: unknown[];
    } | null;
    const review = parseJson(rec.reviewJson ?? '') as {
      changeRows?: StoredReviewRow[];
      destructiveRows?: StoredReviewRow[];
      results?: Array<{ label: string; value: string; bad?: boolean }>;
      blast?: string[];
      warnings?: string[];
      agentReview?: AgentReviewAttachment | null;
      automation?: unknown;
      automationNotCovered?: unknown;
    } | null;
    const structured = (rows?: Array<DeploySummaryRow>) =>
      (rows ?? []).map((c) => {
        const preImage = preImageView(c.pre_image);
        return {
          type: c.type,
          apiName: c.api_name,
          change: c.change as DeployRequestView['changes'][number]['change'],
          warnings: c.warnings ?? [],
          ...(c.source_path
            ? { sourcePath: c.source_path, sourceSha256: c.source_sha256 }
            : {}),
          ...(preImage ? { preImage } : {}),
        };
      });
    let resultSummary: string | null = null;
    let result: Record<string, unknown> | null = null;
    if (rec.resultJson) {
      const parsed = parseJson(rec.resultJson);
      result = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
      resultSummary = parsed
        ? JSON.stringify(parsed, null, 2).slice(0, 4000)
        : rec.resultJson.slice(0, 4000);
    }
    // A row with NO renderable content must never present an approvable
    // blank screen (plugin-era rows have no review_json; DML summaries are
    // previews). Synthesize honest rows from whatever the row does carry.
    let changeRows = reviewRows(review?.changeRows, opts.withDiff);
    let destructiveRows = reviewRows(review?.destructiveRows, opts.withDiff);
    const hasStructured =
      (summary?.changes?.length ?? 0) + (summary?.destructive?.length ?? 0) > 0;
    if (changeRows.length === 0 && destructiveRows.length === 0) {
      // A multi-step DML plan (S14) or a bulk load plan (S27) proposed
      // OUTSIDE this app (plugin path) has no review_json, but its summary
      // carries per-step preview rows in the same shape — use them rather
      // than the raw-JSON fallback below.
      const planRows = summary?.rows as
        | Array<{ label?: string; warnings?: string[]; detail?: string; destructive?: boolean }>
        | undefined;
      if (
        (rec.kind === 'dml' || rec.kind === 'bulk' || rec.kind === 'activation') &&
        Array.isArray(planRows) &&
        planRows.some((r) => r?.label)
      ) {
        for (const r of planRows.slice(0, 50)) {
          if (!r?.label) continue;
          const row = {
            label: r.label,
            warnings: r.warnings ?? [],
            ...(r.detail ? { detail: r.detail } : {}),
          };
          if (r.destructive) destructiveRows = [...destructiveRows, row];
          else changeRows = [...changeRows, row];
        }
      } else if (rec.kind === 'apex') {
        // An apex request proposed OUTSIDE this app (plugin path, shared DB)
        // has no review_json — synthesize the script row from payload_json so
        // the screen never shows an approvable blank for a script.
        const payload = parseJson(rec.payloadJson ?? '') as { apex?: boolean; code?: string } | null;
        const script = typeof payload?.code === 'string' ? payload.code : null;
        changeRows = [
          {
            label: `Execute anonymous Apex (${script ? script.split(/\r?\n/).length : '?'} lines)`,
            warnings: [
              'ANONYMOUS APEX — runs with the approving user\'s permissions; DML it performs COMMITS on success.',
            ],
            ...(script ? { detail: script } : {}),
          },
        ];
      } else if (rec.kind === 'dml' && summary?.operation) {
        const label =
          `${String(summary.operation).toUpperCase()} ${summary.row_count ?? summary.rows?.length ?? '?'}` +
          ` row(s) on ${summary.object ?? 'unknown object'}`;
        if (String(summary.operation).toLowerCase() === 'delete') destructiveRows = [{ label, warnings: [] }];
        else changeRows = [{ label, warnings: [] }];
      } else if (rec.reviewJson === null && rec.summaryJson && !hasStructured) {
        // A plugin-era deploy whose summary parses into structured
        // components needs no raw row — the review rebuilds from those (it
        // prefers changeRows, so a raw row here would hide them).
        changeRows = [
          {
            label: `(request created outside this app — raw summary below)`,
            warnings: [rec.summaryJson.slice(0, 500)],
          },
        ];
      }
    }
    const warnings = review?.warnings ?? [];
    const liveCheck = liveCheckView(summary?.live_check);
    // S45 F2: a request the execute-time guard voided — it did NOT execute.
    const targetMoved =
      rec.status === 'superseded' && result?.target_moved === true
        ? targetMovedView(result)
        : null;
    const targetCheck = targetCheckView(result?.target_check);
    const changes = structured(summary?.changes);
    const destructive = structured(summary?.destructive);
    // S47: the setting a Data Mapper validation read, as stored — its page
    // line is the engine's own sentence, never stored in summary_json.
    const omniSetting = omniStudioSettingView(summary?.omnistudio_metadata);
    return {
      id: rec.id,
      kind: rec.kind,
      connectionId: conn.id,
      alias: conn.alias,
      orgName: conn.orgName,
      orgType: conn.orgType,
      instanceUrl: conn.instanceUrl,
      status: rec.status,
      desktopState: rec.desktopState,
      origin: rec.origin,
      sessionId: rec.sessionId,
      createdAt: rec.createdAt,
      expiresAt: rec.expiresAt,
      executedAt: rec.executedAt,
      approvedAt: rec.approvedAt,
      approvedComment: rec.approvedComment,
      deciding: this.deciding.has(rec.id),
      changes,
      destructive,
      changeRows,
      destructiveRows,
      results: review?.results ?? [],
      blast: review?.blast ?? summary?.blast ?? [],
      warnings,
      automation: automationView(review?.automation),
      automationNotCovered: stringList(review?.automationNotCovered),
      liveCheck,
      targetMoved,
      targetCheck,
      revertPackage: revertPackageView(result?.revert_package),
      revertNote: typeof result?.revert_note === 'string' ? result.revert_note : null,
      notices: reviewNotices(rec.status, liveCheck, targetCheck, warnings, {
        kind: rec.kind,
        outsideApp: rec.reviewJson === null,
        // Components then deletions, in the order validate named them — the
        // order the engine's own dates line lists members in.
        members: [...changes, ...destructive],
        omnistudioLine: omniSetting
          ? omniStudioValidateText(conn.alias, omniSetting, 'page')
          : null,
      }),
      agentReview: review?.agentReview ?? null,
      // S46 (B): read live from summary_json and the policies — never copied
      // into review_json, so an edit or an override shows on the next fetch.
      governance:
        rec.status === 'validated' || record(summary?.governance)
          ? governanceView(
              this.deps.deploys.governanceState(rec.id),
              record(summary?.governance) as Loose<StoredGovernance> | null,
            )
          : null,
      // S46 (C): the post-deploy snapshot re-read. A row stored 'executed'
      // reads `pending` until the engine amends it; `deciding` (above) tells
      // the panel whether that is still in flight in this app.
      snapshotRebaseline: snapshotRebaselineView(result),
      resultSummary,
    };
  }
}

/**
 * S46 (B): the engine's code-free GovernanceState → the review's change
 * record. The two live lines are built here with the engine's own sentence
 * builders, so Deploy Review prints the approval page's words; neither is
 * ever written to summary_json.
 */
function governanceView(
  g: GovernanceState | null,
  stored: Loose<StoredGovernance> | null,
): DeployGovernanceView | null {
  if (!g) return null;
  // The execute-time record (the claim's policy check), read from the
  // stored record by name: the connection identity it also carries is the
  // dossier's, not the review's.
  const check = record(stored?.execute_check) as Loose<
    NonNullable<StoredGovernance['execute_check']>
  > | null;
  return {
    ticket: g.ticket,
    justification: g.justification
      ? { text: g.justification.text, source: g.justification.source, provenance: g.provenance }
      : null,
    justificationRequired: g.required,
    policySource: g.policySource,
    policyLines: g.policyLines,
    unmatchedRuleLines: g.unmatchedRules.map((name) => unmatchedRuleText(name)),
    policyChangedLine: g.policyChangedAt ? policyChangedText(g.policyChangedAt) : null,
    gate: g.gate,
    blockedBy: g.blockedBy,
    blockedOnlyByJustification:
      g.blockedBy === 'violations' &&
      g.violationCodes.length > 0 &&
      g.violationCodes.every((code) => code === 'justification_required'),
    freezeLine: g.freezeLine,
    // Blocked: the engine fills `freeze` from the live verdict, so this says
    // whether a freeze is in effect now behind the block.
    freezeActive: g.freeze !== null,
    override: g.override,
    blockedLines: g.blockedLines,
    reasonMin: POLICY_LIMITS.freezeReasonMin,
    executeCheck:
      check && typeof check.at === 'string'
        ? {
            at: check.at,
            rules: stringList(check.rules),
            freezeActive: check.freeze_active === true,
            overridden: check.overridden === true,
          }
        : null,
  };
}

/** CR LF and lone CR folded to LF, then trimmed — how the engine compares texts. */
function folded(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim();
}

/**
 * S46 (B): the texts Deploy Review prefills its comment box with — the
 * stored justification and the agent's draft kept beside an edited one —
 * folded. A rejection whose comment is one of them was not typed by the human.
 */
function storedJustificationTexts(summaryJson: string): string[] {
  const governance = record(record(parseJson(summaryJson))?.governance) as Loose<StoredGovernance> | null;
  const j = record(governance?.justification);
  return [j?.text, j?.agent_draft]
    .filter((t): t is string => typeof t === 'string' && t.trim() !== '')
    .map(folded);
}

// ── S45 view parsing (review_json / summary_json / result_json → views) ──
// Every mapper tolerates any stored shape (older rows, plugin-era rows):
// an unexpected value yields null/[] rather than a throw, and fields are
// copied by name only. Each parsed record is read through Loose<EngineType>
// — every key optional and `unknown`, so the runtime stays tolerant, while
// `pnpm typecheck` rejects a key the engine's own type no longer has (an
// engine-side rename cannot silently blank a panel here).

type Loose<T> = { [K in keyof T]?: unknown };

/** One `target_check.checked[]` entry of a deploy result (S46 D4: may carry `absent`). */
type CheckedMember = Extract<RevertTargetCheck, { checked: unknown }>['checked'][number];

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** A `{key: string}` record, own keys only; a non-string value is dropped. */
function stringRecord(value: unknown): Record<string, string> {
  const r = record(value);
  if (!r) return {};
  return Object.fromEntries(
    Object.entries(r).filter((e): e is [string, string] => typeof e[1] === 'string'),
  );
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** review_json rows → view rows; the diff only when asked for (deploys:get). */
function reviewRows(rows: unknown, withDiff: boolean): DeployReviewRowView[] {
  if (!Array.isArray(rows)) return [];
  const out: DeployReviewRowView[] = [];
  for (const raw of rows) {
    const r = record(raw);
    if (!r || typeof r.label !== 'string') continue;
    const diff = withDiff ? rowDiffView(r.diff) : null;
    out.push({
      label: r.label,
      warnings: stringList(r.warnings),
      ...(typeof r.detail === 'string' ? { detail: r.detail } : {}),
      ...(diff ? { diff } : {}),
    });
  }
  return out;
}

function semanticChangeView(raw: unknown): SemanticChangeView[] {
  const c = record(raw) as Loose<NonNullable<ApprovalRowDiff['xml_changes']>[number]> | null;
  if (!c) return [];
  const path = str(c.path) ?? '';
  switch (c.kind) {
    case 'scalar':
      return [{ kind: 'scalar', path, a: c.a, b: c.b }];
    case 'added':
      return [{ kind: 'added', path, key: str(c.key) ?? '' }];
    case 'removed':
      return [{ kind: 'removed', path, key: str(c.key) ?? '' }];
    default:
      return [{ kind: 'unkeyed', path, note: str(c.note) ?? '' }];
  }
}

function hunkView(raw: unknown): Array<TextHunkView & { file?: string }> {
  const h = record(raw) as Loose<NonNullable<ApprovalRowDiff['text_hunks']>[number]> | null;
  if (!h) return [];
  return [
    {
      ...(typeof h.file === 'string' ? { file: h.file } : {}),
      a_line: typeof h.a_line === 'number' ? h.a_line : 0,
      b_line: typeof h.b_line === 'number' ? h.b_line : 0,
      removed: stringList(h.removed),
      added: stringList(h.added),
      ...(h.removed_truncated === true ? { removed_truncated: true } : {}),
      ...(h.added_truncated === true ? { added_truncated: true } : {}),
    },
  ];
}

/** The engine's ApprovalRowDiff (snake_case) → the renderer's row diff. */
function rowDiffView(raw: unknown): DeployRowDiffView | null {
  const d = record(raw) as Loose<ApprovalRowDiff> | null;
  if (!d || typeof d.summary !== 'string') return null;
  const counts = record(d.counts) as Loose<NonNullable<ApprovalRowDiff['counts']>> | null;
  const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
  const list = (v: unknown) => (Array.isArray(v) ? stringList(v) : undefined);
  return {
    format: d.format === 'xml' || d.format === 'bundle' ? d.format : 'text',
    identical: d.identical === true,
    baselineLabel: str(d.baseline_label) ?? '',
    summary: d.summary,
    changes: Array.isArray(d.xml_changes) ? d.xml_changes.flatMap(semanticChangeView) : null,
    hunks: Array.isArray(d.text_hunks) ? d.text_hunks.flatMap(hunkView) : null,
    counts: counts
      ? {
          changes: num(counts.changes),
          linesAdded: num(counts.lines_added),
          linesRemoved: num(counts.lines_removed),
          filesChanged: list(counts.files_changed),
          filesAdded: list(counts.files_added),
          filesRemoved: list(counts.files_removed),
        }
      : null,
    truncated: d.truncated === true,
    note: str(d.note),
  };
}

/** summary.changes[].pre_image (ComponentPreImage) → view. */
function preImageView(raw: unknown): DeployPreImageView | null {
  const p = record(raw) as Loose<ComponentPreImage> | null;
  if (!p) return null;
  return {
    present: typeof p.present === 'boolean' ? p.present : null,
    source: p.source === 'list' ? 'list' : 'retrieve',
    // S46 D1: null on a pre-S46 pre-image (every stamp from listMetadata).
    stampSource: str(p.stamp_source),
    ...(typeof p.sha256 === 'string' ? { sha256: p.sha256 } : {}),
    lastModifiedDate: str(p.last_modified_date),
    lastModifiedBy: str(p.last_modified_by),
    comparable: p.comparable === true,
    restorable: p.restorable === true,
  };
}

/** S47: summary.omnistudio_metadata → the engine's setting; anything else → null. */
function omniStudioSettingView(raw: unknown): OmniStudioMetadataSetting | null {
  const s = record(raw) as Loose<OmniStudioMetadataSetting> | null;
  if (!s || (s.state !== 'on' && s.state !== 'off' && s.state !== 'unknown')) return null;
  const reason = str(s.reason);
  return { state: s.state, ...(reason !== null ? { reason } : {}) };
}

/** summary.live_check (LiveCheckSummary) → view. */
function liveCheckView(raw: unknown): DeployLiveCheckView | null {
  const l = record(raw) as Loose<LiveCheckSummary> | null;
  if (!l || (l.status !== 'ok' && l.status !== 'unavailable')) return null;
  const clock = record(l.org_clock) as Loose<
    NonNullable<LiveCheckSummary['org_clock']>
  > | null;
  return {
    status: l.status,
    reason: str(l.reason),
    startedAt: str(l.started_at),
    at: str(l.at),
    orgClock:
      clock && typeof clock.created_date === 'string'
        ? { createdDate: clock.created_date, completedDate: str(clock.completed_date) }
        : null,
    datesUnavailableTypes: stringList(l.dates_unavailable_types),
    datesUnavailable: str(l.dates_unavailable),
    probeFailures: stringRecord(l.probe_failures),
    // S46 D1f: carried for the request's raw detail only — reviewNotices
    // never shows it (the org's "cannot be found" for an ADD would read as a
    // verdict beside the Approve button).
    retrieveNote: str(l.retrieve_note),
    members: typeof l.members === 'number' ? l.members : null,
  };
}

/**
 * One member a target check or a refusal names: a deploy member
 * ({type, api_name}), a DML record ({object, id, field?}) — never a field
 * value (the engine keeps those out of these lists; the refusal text is
 * the human-facing account).
 */
function targetMemberView(raw: unknown, stateKey: 'state' | 'reason'): DeployTargetMemberView[] {
  const m = record(raw);
  if (!m) return [];
  // A deploy member (moved, or a checked/unchecked RevertPlanMember): its
  // keys read through the engine's type. The DML member's keys
  // ({object, id, field}) have no exported engine type.
  const d = m as Loose<DeployMovedMember>;
  const label =
    typeof d.type === 'string'
      ? `${d.type} ${str(d.api_name) ?? ''}`.trim()
      : typeof m.object === 'string'
        ? [m.object, str(m.id), str(m.field)].filter(Boolean).join(' ')
        : null;
  if (!label) return [];
  const by = str(d.last_modified_by);
  const at = str(d.last_modified_date);
  return [
    {
      label,
      state: str(m[stateKey]) ?? (stateKey === 'state' ? 'changed' : null),
      detail:
        by || at ? `last modified${by ? ` by ${by}` : ''}${at ? ` at ${at}` : ''}` : null,
    },
  ];
}

function memberList(raw: unknown, stateKey: 'state' | 'reason'): DeployTargetMemberView[] {
  return Array.isArray(raw) ? raw.flatMap((m) => targetMemberView(m, stateKey)) : [];
}

/** result_json of a voided request → the target-moved view (refusal verbatim). */
function targetMovedView(result: Record<string, unknown>): DeployTargetMovedView {
  const moved = memberList(result.moved, 'state');
  // An activation's refusal names no member list — name the version.
  if (moved.length === 0 && typeof result.version === 'string') {
    const agent = typeof result.agent === 'string' ? `${result.agent}.` : '';
    moved.push({
      label: `BotVersion ${agent}${result.version}`,
      state: 'changed',
      detail:
        `status is now ${str(result.current_status) ?? 'not reported (see the refusal below)'}; ` +
        `the approval was for ` +
        `a change from ${str(result.approved_from_status) ?? 'an unrecorded status'}`,
    });
  }
  return {
    checkedAt: str(result.checked_at),
    refusal: movedRefusalOf(result) ?? '',
    moved,
    unchecked: memberList(result.unchecked, 'reason'),
  };
}

/** result_json.target_check → view (D1: every shape carries a status). */
function targetCheckView(raw: unknown): DeployTargetCheckView | null {
  const t = record(raw);
  if (!t) return null;
  const status =
    t.status === 'ok' ||
    t.status === 'unavailable' ||
    t.status === 'not_checked' ||
    t.status === 'not_applicable'
      ? t.status
      : null;
  if (status === null) return null;
  // S46 D4: a checked member the approval assumed absent, for which the
  // execute-time read returned nothing, carries `absent: true` — no stamp
  // was compared for it, and the headline counts it apart.
  const checked = Array.isArray(t.checked)
    ? t.checked.flatMap((raw) => {
        const absent = (record(raw) as Loose<CheckedMember> | null)?.absent === true;
        return targetMemberView(raw, 'reason').map((m) =>
          absent ? { ...m, state: 'absent' } : m,
        );
      })
    : [];
  return {
    status,
    checkedAt: str(t.checked_at),
    reason: str(t.reason),
    note: str(t.note),
    checked,
    unchecked: memberList(t.unchecked, 'reason'),
  };
}

/** result_json.revert_package → view; 'unknown' when Contrail lost track of the deploy. */
function revertPackageView(raw: unknown): DeployRevertPackageView | null {
  const p = record(raw);
  if (!p) return null;
  const members = (v: unknown) =>
    Array.isArray(v)
      ? v.flatMap((m) => {
          const r = record(m);
          const member = r as Loose<RevertPlanMember> | null;
          return r && member && typeof member.type === 'string'
            ? [{ r, type: member.type, apiName: str(member.api_name) ?? '' }]
            : [];
        })
      : [];
  return {
    dir: str(p.dir),
    outcome: p.outcome === 'unknown' ? 'unknown' : 'executed',
    restores: members(p.restores).map(({ r, type, apiName }) => ({
      type,
      apiName,
      contentFile: str((r as Loose<RevertPlanComponent>).content_file),
    })),
    deletes: members(p.deletes).map(({ type, apiName }) => ({ type, apiName })),
    notRestorable: members(p.not_restorable).map(({ r, type, apiName }) => ({
      type,
      apiName,
      reason: str((r as Loose<RevertPlanReason>).reason) ?? '',
    })),
    plan: str(p.plan),
    note: str(p.note),
  };
}

const SNAPSHOT_STATUSES: ReadonlyArray<DeploySnapshotRebaselineView['status']> = [
  'complete',
  'partial',
  'none',
  'unavailable',
  'disabled',
  'pending',
];

/** One `{type, api_name}` of a snapshot block's member list → view. */
function snapshotMembers(raw: unknown): Array<DeploySnapshotMemberView & { r: Record<string, unknown> }> {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((m) => {
    const r = record(m);
    const member = r as Loose<SnapshotMember> | null;
    return r && member && typeof member.type === 'string'
      ? [{ r, type: member.type, apiName: str(member.api_name) ?? '' }]
      : [];
  });
}

/**
 * The engine's result note (executeSnapshotResult) when every member was
 * skipped yet a unit was written — the one stored field that tells this
 * `none` apart from the one that wrote nothing.
 */
const NONE_WROTE_DOCUMENTS = 'Contrail did write to the local snapshot';

/**
 * S46 (C): result_json.snapshot (ExecuteSnapshotBlock) → view, from the
 * whole result: `reason` is the `unavailable` reason only, and a `none` that
 * still wrote a document is read from the result's note. A row executed
 * before 0.40 has no block.
 */
function snapshotRebaselineView(
  result: Record<string, unknown> | null,
): DeploySnapshotRebaselineView | null {
  const s = record(result?.snapshot) as Loose<ExecuteSnapshotBlock> | null;
  if (!s) return null;
  const status = SNAPSHOT_STATUSES.find((v) => v === s.status);
  if (!status) return null;
  const note = str(result?.note);
  const plain = (list: unknown) => snapshotMembers(list).map(({ type, apiName }) => ({ type, apiName }));
  return {
    status,
    reason: status === 'unavailable' ? str(s.reason) : null,
    rebaselined: plain(s.rebaselined),
    removed: plain(s.removed),
    skipped: snapshotMembers(s.skipped).map(({ r, type, apiName }) => ({
      type,
      apiName,
      code: str(r.code) ?? '',
      reason: str(r.reason) ?? '',
    })),
    note: str(s.note) ?? '',
    wroteDocuments: status === 'none' && note !== null && note.includes(NONE_WROTE_DOCUMENTS),
  };
}

/** review_json.automation → the card's sections (the engine composed every line). */
function automationView(raw: unknown): ObjectAutomationView[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((a) => {
    const r = record(a);
    if (!r || typeof r.object !== 'string') return [];
    return [
      {
        object: r.object,
        snapshot_at: str(r.snapshot_at),
        summary_lines: stringList(r.summary_lines),
        notes: stringList(r.notes),
        not_covered: stringList(r.not_covered),
      },
    ];
  });
}

/**
 * Verbatim copy of the engine's datesUnavailableText (deploy/engine.ts,
 * module-private there): the page-top line a request validated outside this
 * app showed on its own approval page and did not persist. S46 D1: ONE line
 * however many reasons there are — each group is `${types or member names}
 * (${reason})`, joined with '; '.
 */
function datesUnavailableText(at: string, groups: string[]): string {
  return (
    `Live diff is against the org (retrieved ${at}); last-modified stamps were unavailable ` +
    `for ${groups.join('; ')}, so CHANGED-IN-TARGET detection for those members ` +
    `relies on content only and the execute-time check will report them as unchecked.`
  );
}

/** Copy of the engine's groupByReason: `{type: reason}` → reason → its types, in order. */
function groupByReason(failures: Record<string, string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [type, reason] of Object.entries(failures)) {
    const types = out.get(reason);
    if (types) types.push(type);
    else out.set(reason, [type]);
  }
  return out;
}

/** Copy of the engine's memberNames: the first ten as `Type api_name`, then how many more. */
function memberNames(members: Array<{ type: string; apiName: string }>): string {
  const shown = members.slice(0, 10).map((m) => `${m.type} ${m.apiName}`);
  return (
    shown.join(', ') + (members.length > shown.length ? ` and ${members.length - 10} more` : '')
  );
}

/**
 * S46 D1: the member's validate-time stamp came from a per-member stamp
 * query. A pre-S46 pre-image (no stampSource), or none at all, was listed.
 */
function probeSourced(p: DeployPreImageView | undefined): boolean {
  return p !== undefined && p.stampSource !== null && p.stampSource !== 'listMetadata';
}

/**
 * S45: the notices the review panel shows. The live check's own banner
 * already rides `warnings` for rows this app presented; it is repeated here
 * only when it is missing (a plugin-era row). A request validated or
 * proposed outside this app (no review_json) says what its own approval
 * page showed that is not stored here: per-row diffs (their warnings point
 * at "the diff below"), an automation card. The target-check notice is the
 * desktop's half of the fail-open disclosure: the write ran, but nothing
 * confirmed the org still held what the approval showed.
 * S46: the dates-unavailable line mirrors the engine's liveCheckWarnings
 * and, like it, is ONE line at most. The org's retrieve messages
 * (`liveCheck.retrieveNote`) are never a notice.
 * S47: a Data Mapper request validated outside this app gets the engine's
 * Omnistudio Metadata line (off, or not read) rebuilt from its stored
 * setting, first — as it leads the approval page's warnings. A row this app
 * presented stored that line in `warnings` already.
 */
function reviewNotices(
  status: string,
  liveCheck: DeployLiveCheckView | null,
  targetCheck: DeployTargetCheckView | null,
  warnings: string[],
  origin: {
    kind: DeployRequestKind;
    outsideApp: boolean;
    /** Components then deletions, each with its frozen pre-image when one exists. */
    members: Array<Pick<DeployChangeView, 'type' | 'apiName' | 'preImage'>>;
    /**
     * S47: the engine's page line for the stored Omnistudio Metadata
     * setting; null when it is on or none was stored.
     */
    omnistudioLine: string | null;
  },
): string[] {
  const out: string[] = [];
  if (origin.outsideApp && origin.omnistudioLine) out.push(origin.omnistudioLine);
  if (
    liveCheck?.status === 'unavailable' &&
    !warnings.some((w) => w.startsWith('LIVE COMPARISON UNAVAILABLE'))
  ) {
    out.push(
      `Live comparison unavailable at validate (${liveCheck.reason ?? 'no reason recorded'}) — ` +
        'the org was not re-read; classifications and diffs came from the local snapshot only.',
    );
  }
  if (origin.outsideApp && liveCheck) {
    // An S45 page existed (live_check is written beside it); its diffs
    // were never persisted (they would ride every execute result).
    out.push(
      'Validated outside the app — its per-row diffs were shown on its own approval page and ' +
        'are not stored here; warnings that mention "the diff below" refer to that page. ' +
        'Re-validate here to see them.',
    );
  } else if (
    origin.outsideApp &&
    (origin.kind === 'dml' || origin.kind === 'bulk' || origin.kind === 'apex')
  ) {
    // The automation card lives only on the page (nothing persisted marks
    // whether one was shown), so this stays conditional.
    out.push(
      'Proposed outside the app — if its own approval page showed an automation card (what the ' +
        'local snapshot says fires on the objects it touches), that card is not stored here. ' +
        'Re-propose here to see it.',
    );
  }
  if (
    liveCheck?.status === 'ok' &&
    !warnings.some((w) => w.startsWith('Live diff is against the org'))
  ) {
    // The engine's groups, in its order: the listing (a thrown listing nulls
    // the dates of every listing-sourced member; INVALID_TYPE names the
    // types it could not list), one group per distinct stamp-query failure,
    // then the members a stamp query never named and those it named but gave
    // no usable stamp.
    const at = hhmm(liveCheck.at ?? '');
    const failures = liveCheck.probeFailures;
    const probeFailed = (type: string): boolean => Object.hasOwn(failures, type);
    const groups: string[] = [];
    if (liveCheck.datesUnavailable !== null) {
      // The LISTING threw: it says nothing about a stamp query, so only the
      // listing-sourced member types are named with its reason.
      const listedTypes = [
        ...new Set(origin.members.filter((m) => !probeSourced(m.preImage)).map((m) => m.type)),
      ];
      if (listedTypes.length > 0) {
        groups.push(`${listedTypes.join(', ')} (${liveCheck.datesUnavailable.slice(0, 160)})`);
      }
    } else {
      // A type whose stamp query failed is in datesUnavailableTypes too; its
      // reason is the query's, never INVALID_TYPE.
      const invalid = liveCheck.datesUnavailableTypes.filter((t) => !probeFailed(t));
      if (invalid.length > 0) {
        groups.push(`${invalid.join(', ')} (listMetadata reported INVALID_TYPE)`);
      }
    }
    for (const [reason, types] of groupByReason(failures)) {
      groups.push(`${types.join(', ')} (${stampQueryFailedReason(reason)})`);
    }
    // Members of a stamp-query type the org holds that carry no stamp.
    const undated = origin.members.filter(
      (m) =>
        probeSourced(m.preImage) &&
        m.preImage?.present === true &&
        m.preImage.lastModifiedDate === null,
    );
    const probeable = (m: { type: string; apiName: string }): boolean =>
      isProbeable({ type: m.type, api_name: m.apiName });
    // No query named them (a standard field, a name the grammar cannot
    // place) — said even when their type's query failed.
    const notQueried = undated.filter((m) => !probeable(m));
    // A query that succeeded named them: zero rows, two rows, an unparseable
    // date, or only a same-name row under another namespace.
    const noStamp = undated.filter((m) => probeable(m) && !probeFailed(m.type));
    if (notQueried.length > 0) {
      groups.push(`${memberNames(notQueried)} (${STAMP_NOT_QUERIED_REASON})`);
    }
    if (noStamp.length > 0) groups.push(`${memberNames(noStamp)} (${STAMP_NO_ROW_REASON})`);
    if (groups.length > 0) out.push(datesUnavailableText(at, groups));
  }
  if (targetCheck?.status === 'unavailable' || targetCheck?.status === 'not_checked') {
    const lead =
      status === 'executed'
        ? 'Executed'
        : status === 'execution_failed'
          ? 'Execution failed'
          : 'Ran';
    let why: string;
    if (targetCheck.status === 'unavailable') {
      why = targetCheck.reason ?? 'Contrail could not re-read the org';
    } else if (targetCheck.unchecked.length > 0) {
      const shown = targetCheck.unchecked
        .slice(0, 3)
        .map((u) => `${u.label}: ${u.state ?? 'unchecked'}`)
        .join('; ');
      const more = targetCheck.unchecked.length - 3;
      why = `nothing could be compared — ${shown}${more > 0 ? `; ${more} more` : ''}`;
    } else {
      why = 'nothing could be compared — no baseline was recorded';
    }
    out.push(`${lead} — the target was NOT re-checked before running (${why})`);
  }
  return out;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Did an engine execution actually fail? The engine's payload keys are
 * `deployed` (deploy) and `executed` (DML) — never `success`. Unknown
 * shapes (e.g. the concurrent "not re-applied" note) are NOT called
 * failures, but they are never called successes either: the caller shows
 * the raw payload alongside.
 */
function outcomeFailed(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  if (p.deployed === false || p.executed === false) return true;
  if (typeof p.error === 'string' && p.error) return true;
  return false;
}
