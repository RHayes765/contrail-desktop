import {
  ContrailError,
  type ApprovalPresentation,
  type ApprovalPresenter,
  type ApprovalRequestView,
  type DeployRequestRecord,
  type EngineDeps,
} from '@contrail/engine';
import type { ChatEvent, DeployRequestView, PushChannel, PushEvents } from '@contrail/shared';

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

export interface DeployAlert {
  requestId: string;
  kind: 'deploy' | 'dml';
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

/**
 * The engine-facing presenter. Constructed at bootstrap (before services
 * exist), so the service attaches late; a present() before attachment still
 * approves the CONTRACT (native mode, no URL) — but by construction every
 * validate flows through the executor, which requires the service.
 */
export class NativeApprovalPresenter implements ApprovalPresenter {
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

export class DeployService {
  /**
   * Which session asked for a presentation, PER CONNECTION. A single global
   * slot cross-paired approvals under concurrent sessions (validate is a
   * long round-trip); keying by connection means A's approval can never be
   * stamped with B's session unless they share the connection — where
   * supersede already collapses them to one pending request anyway.
   */
  private readonly expectations = new Map<string, { sessionId: string; at: number }>();
  /** Held agent calls, keyed requestId → sessionId → call (never displaced silently). */
  private readonly held = new Map<string, Map<string, HeldCall>>();

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
   */
  reconcileStrandedExecutions(maxAgeMs = 30 * 60_000): number {
    const cutoff = Date.now() - maxAgeMs;
    let swept = 0;
    for (const rec of this.deps.db.listDeployRequests({ limit: 200 })) {
      if (rec.status !== 'executing') continue;
      if (new Date(rec.createdAt).getTime() > cutoff) continue;
      this.deps.db.finishDeployRequest(
        rec.id,
        'execution_failed',
        JSON.stringify({
          error: 'Contrail closed while this execution was running.',
          note:
            'The change may or may not have committed — check Setup → Deployment Status (or the ' +
            'records) in the target org before retrying.',
          stranded: true,
        }),
      );
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

  /** Executor marks which session's tool call is about to present, for a connection. */
  expectPresentation(sessionId: string, connectionId: string): void {
    this.expectations.set(connectionId, { sessionId, at: Date.now() });
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
    // deliberately never copied here.
    const review = {
      kind: view.kind,
      org: view.org,
      changeRows: view.changes,
      destructiveRows: view.destructive,
      results: view.results,
      blast: view.blast,
      warnings: view.warnings ?? [],
      expiresAt: view.expiresAt,
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

  list(connectionId?: string): DeployRequestView[] {
    return this.deps.db
      .listDeployRequests({ connectionId })
      .map((rec) => this.view(rec))
      .filter((v): v is DeployRequestView => v !== null);
  }

  get(id: string): DeployRequestView {
    const rec = this.deps.db.getDeployRequest(id);
    if (!rec) throw new Error('Deploy request not found.');
    const view = this.view(rec);
    if (!view) throw new Error('Deploy request references a removed connection.');
    return view;
  }

  /**
   * THE human decision. Renderer-only path: reads the confirmation code from
   * the row in main and drives the engine's normal claim machinery. Waits
   * for the terminal outcome (long deploys poll via re-invocation).
   */
  async approve(id: string, comment?: string): Promise<DeployRequestView> {
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
    const needed = rec.kind === 'deploy' ? 'metadata_write' : 'data_write';
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

    this.deps.db.recordDeployDecision(id, 'approved', trimmed);
    this.deps.audit.record('deploy.approved', {
      connectionId: conn.id,
      tool: 'deploy_review_screen',
      outcome: 'success',
      detail: { requestId: id, kind: rec.kind, comment: trimmed },
    });
    this.push('deploys:changed', { requestId: id });

    // The code goes row → engine, entirely inside this process.
    const code = rec.confirmationCode;
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
          outcome = await this.deps.deploys.executeDeploy(conn, code);
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
      } else {
        const result = await this.deps.deploys.executeDml(conn, code);
        failed = outcomeFailed(result);
        detail = result;
      }
    } catch (err) {
      failed = true;
      detail = {
        error: err instanceof ContrailError ? `${err.code}: ${err.message}` : String(err).slice(0, 800),
      };
    }

    this.push('deploys:changed', { requestId: id });
    this.resolveHeld(
      id,
      failed
        ? refusal(
            `The user approved this ${rec.kind}, but execution failed:\n` +
              JSON.stringify(detail, null, 2).slice(0, 3000),
          )
        : okJson({ approved: true, outcome: 'executed', detail }),
      failed ? 'execution_failed' : 'executed',
      rec.sessionId,
    );
    return this.get(id);
  }

  /** Reject: the pending code dies with the decision — nothing can execute it later. */
  async reject(id: string, comment?: string): Promise<DeployRequestView> {
    const rec = this.deps.db.getDeployRequest(id);
    if (!rec) throw new Error('Deploy request not found.');
    if (rec.status !== 'validated') {
      throw new Error(`This request is ${rec.status} — only a validated request can be rejected.`);
    }
    const trimmed = comment?.trim() || null;
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
    return this.get(id);
  }

  /**
   * The executor's interception for an agent write call with no human-typed
   * code: hold the tool call on the pending request until the human decides
   * (or the hold times out — the session continues honestly either way).
   * Returns null when there is nothing to intercept (engine speaks for itself).
   */
  interceptAgentExecute(
    sessionId: string,
    kind: 'deploy' | 'dml',
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
      // twice). Only this session's own request is replayed.
      const recent = rows.find(
        (r) =>
          r.sessionId === sessionId &&
          (r.desktopState === 'approved' || r.desktopState === 'rejected'),
      );
      if (!recent) return null;
      if (recent.desktopState === 'rejected') {
        return Promise.resolve(
          refusal(
            `The user REJECTED this ${kind}${recent.approvedComment ? ` — reason: ${recent.approvedComment}` : ''}. ` +
              'Do not retry it as-is; ask the user what should change.',
          ),
        );
      }
      if (recent.status === 'executing') {
        return Promise.resolve(
          okJson({
            status: 'executing',
            request_id: recent.id,
            note: 'The user approved it and execution is running. Call again shortly for the outcome.',
          }),
        );
      }
      const result = recent.resultJson ? parseJson(recent.resultJson) : null;
      return Promise.resolve(
        recent.status === 'execution_failed'
          ? refusal(
              `The user approved this ${kind}, but execution failed:\n` +
                JSON.stringify(result, null, 2).slice(0, 3000),
            )
          : okJson({ approved: true, outcome: 'executed', detail: result }),
      );
    }

    if (new Date(pending.expiresAt).getTime() < Date.now()) return null;
    if (pending.desktopState === 'rejected') {
      return Promise.resolve(refusal('The user rejected this request. Do not retry it as-is.'));
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.held.get(pending.id)?.delete(sessionId);
        resolve(
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

  private view(rec: DeployRequestRecord): DeployRequestView | null {
    const conn = this.deps.db.resolveConnection(rec.connectionId);
    if (!conn) return null;
    const summary = parseJson(rec.summaryJson) as {
      changes?: Array<{ type: string; api_name: string; change: string; warnings: string[] }>;
      destructive?: Array<{ type: string; api_name: string; change: string; warnings: string[] }>;
      blast?: string[];
      // DML summaries are a preview object, not component lists.
      operation?: string;
      object?: string;
      row_count?: number;
      rows?: unknown[];
    } | null;
    const review = parseJson(rec.reviewJson ?? '') as {
      changeRows?: Array<{ label: string; warnings: string[] }>;
      destructiveRows?: Array<{ label: string; warnings: string[] }>;
      results?: Array<{ label: string; value: string; bad?: boolean }>;
      blast?: string[];
      warnings?: string[];
    } | null;
    const structured = (
      rows?: Array<{ type: string; api_name: string; change: string; warnings: string[] }>,
    ) =>
      (rows ?? []).map((c) => ({
        type: c.type,
        apiName: c.api_name,
        change: c.change as DeployRequestView['changes'][number]['change'],
        warnings: c.warnings ?? [],
      }));
    let resultSummary: string | null = null;
    if (rec.resultJson) {
      const parsed = parseJson(rec.resultJson) as Record<string, unknown> | null;
      resultSummary = parsed
        ? JSON.stringify(parsed, null, 2).slice(0, 4000)
        : rec.resultJson.slice(0, 4000);
    }
    // A row with NO renderable content must never present an approvable
    // blank screen (plugin-era rows have no review_json; DML summaries are
    // previews). Synthesize honest rows from whatever the row does carry.
    let changeRows = review?.changeRows ?? [];
    let destructiveRows = review?.destructiveRows ?? [];
    if (changeRows.length === 0 && destructiveRows.length === 0) {
      if (rec.kind === 'dml' && summary?.operation) {
        const label =
          `${String(summary.operation).toUpperCase()} ${summary.row_count ?? summary.rows?.length ?? '?'}` +
          ` row(s) on ${summary.object ?? 'unknown object'}`;
        if (String(summary.operation).toLowerCase() === 'delete') destructiveRows = [{ label, warnings: [] }];
        else changeRows = [{ label, warnings: [] }];
      } else if (rec.reviewJson === null && rec.summaryJson) {
        changeRows = [
          {
            label: `(request created outside this app — raw summary below)`,
            warnings: [rec.summaryJson.slice(0, 500)],
          },
        ];
      }
    }
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
      changes: structured(summary?.changes),
      destructive: structured(summary?.destructive),
      changeRows,
      destructiveRows,
      results: review?.results ?? [],
      blast: review?.blast ?? summary?.blast ?? [],
      warnings: review?.warnings ?? [],
      resultSummary,
    };
  }
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
