import http from 'node:http';
import { randomUUID } from 'node:crypto';
import openBrowserDefault from 'open';
import { hostAllowed, listen, readBody, redirect, safeRespond } from '../core/localhttp.js';
import { renderApprovalPage, renderErrorPage, type ApprovalPageOptions } from '../connect/pages.js';
import { log } from '../core/log.js';
import { APPROVAL_NOTICES, type ApprovalNoticeCode } from '../core/policy.js';

/**
 * Write-approval presentation. The presenter is the only channel carrying the
 * confirmation code to the human; the tool result deliberately never includes
 * it, so a prompt-injected agent cannot approve its own write.
 *
 * `ApprovalPageServer` is the localhost-page implementation (Phase 0 model:
 * human reads the code off the page and speaks it back in chat). A desktop
 * app substitutes its own `ApprovalPresenter` that renders the same view
 * model natively — stripping the code from anything an agent-visible surface
 * can see — via the `approvals` seam in `createEngineDeps`.
 *
 * S46 (B): a page presented with a `live` hook set is re-rendered on every
 * GET, so it shows the request's change record as it stands now, and takes
 * two POSTs — the human's own justification and, during a change freeze, the
 * emergency reason. Both follow the Settings page's rules (connect/
 * settings.ts): the Host header must be this loopback port, the session id
 * travels in the POST body, a 64 KB body cap. Each POST answers 302 → GET,
 * so the page keeps its `?s=` address (its /status poll reads it) and a
 * reload never re-submits. A refusal reaches the audit log as a reason and a
 * route label only: never the URL, its query string, the path text or the
 * body — get_audit_log hands audit detail to the agent, and a session id
 * there would address this human-only page. Approval itself still happens by
 * the human speaking the code back — nothing on the page approves anything.
 * A native presenter (the desktop's Deploy Review) ignores `live`: the app
 * reaches the same engine methods through its own human-only surface.
 */

export type { ApprovalNoticeCode };

/** The four routes the page answers; anything else is 'other'. */
export type ApprovalRoute = 'approve' | 'status' | 'justification' | 'override' | 'other';

/**
 * S46 (B): what a live page asks of the engine. Every method is bound to one
 * request; the session id is the page server's own and is handed to render
 * only, so the forms can carry it.
 */
export interface ApprovalLivePage {
  render(ctx: { sessionId: string; notice: ApprovalNoticeCode | null }): string;
  saveJustification(text: string): ApprovalNoticeCode;
  recordFreezeOverride(reason: string): ApprovalNoticeCode;
  refused(
    reason: 'bad_host_header' | 'invalid_session_token' | 'body_too_large',
    route: ApprovalRoute,
  ): void;
}

/** The live status of a request, polled by the page; `rev` changes whenever the page should reload. */
export type ApprovalStatusCheck = () => { active: boolean; status: string; rev?: string };

/** The structured view model for one approval request. */
export interface ApprovalRequestView extends ApprovalPageOptions {
  /** The deploy_requests row this approval belongs to. */
  requestId: string;
}

export interface ApprovalPresentation {
  /** Page URL when the presenter is the localhost page; null for native UIs. */
  url: string | null;
  opened: boolean;
  mode: 'page' | 'native';
}

export interface ApprovalPresenter {
  /**
   * S46 (B): where the human approves — required, so every presenter (each
   * test fake included) states its surface. The engine reads it at mint, for
   * the stored governance.surface and the phone push, before present() runs.
   */
  readonly mode: 'page' | 'native';
  present(
    view: ApprovalRequestView,
    statusCheck?: ApprovalStatusCheck,
    ttlMs?: number,
    /** S46 (B): the live page's hooks — a native presenter ignores them. */
    live?: ApprovalLivePage,
  ): Promise<ApprovalPresentation>;
  close(sessionId: string): void;
}

interface ApprovalSession {
  server: http.Server;
  html: string;
  hardTimeout: NodeJS.Timeout;
  /** Live status of the underlying request, so the page can self-invalidate. */
  statusCheck?: ApprovalStatusCheck;
  /** S46 (B): set → GET re-renders and the POST routes exist. */
  live?: ApprovalLivePage;
}

/** Fallback lifetime when the caller doesn't specify one. */
const DEFAULT_SESSION_TTL_MS = 20 * 60 * 1000;

const ROUTES = new Map<string, ApprovalRoute>([
  ['/approve', 'approve'],
  ['/status', 'status'],
  ['/justification', 'justification'],
  ['/override', 'override'],
]);

function isNoticeCode(value: string | null): value is ApprovalNoticeCode {
  return value !== null && Object.prototype.hasOwnProperty.call(APPROVAL_NOTICES, value);
}

export class ApprovalPageServer implements ApprovalPresenter {
  readonly mode = 'page' as const;
  private readonly sessions = new Map<string, ApprovalSession>();

  constructor(
    private readonly openBrowser: (url: string) => Promise<void> = async (url) => {
      await openBrowserDefault(url);
    },
  ) {}

  /**
   * Render the approval view at a fresh session URL and open the human's
   * browser at it. `view` is the first render; with `live`, every later GET
   * re-renders.
   */
  async present(
    view: ApprovalRequestView,
    statusCheck?: ApprovalStatusCheck,
    ttlMs: number = DEFAULT_SESSION_TTL_MS,
    live?: ApprovalLivePage,
  ): Promise<ApprovalPresentation> {
    const html = renderApprovalPage(view);
    const sessionId = randomUUID();
    const server = http.createServer((req, res) => {
      this.handle(sessionId, req, res).catch((err) => {
        // The error's name only: a message could quote a body or a path.
        log('error', 'approval page request handler failed', {
          err: err instanceof Error ? err.name : typeof err,
        });
        safeRespond(res, 500, renderErrorPage('Internal error; see server log.'));
      });
    });
    await listen(server, 0);
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const url = `http://localhost:${port}/approve?s=${sessionId}`;

    const session: ApprovalSession = {
      server,
      html,
      statusCheck,
      ...(live ? { live } : {}),
      // Keep the page's status endpoint reachable at least as long as the code
      // can be valid, so the self-invalidation poll can observe it going dead.
      hardTimeout: setTimeout(() => this.close(sessionId), ttlMs),
    };
    session.hardTimeout.unref?.();
    this.sessions.set(sessionId, session);

    let opened = true;
    try {
      await this.openBrowser(url);
    } catch (err) {
      opened = false;
      log('warn', 'could not open browser for approval page', { err: String(err) });
    }
    return { url, opened, mode: 'page' };
  }

  private async handle(
    sessionId: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      safeRespond(res, 410, renderErrorPage('This approval page has expired.'));
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      url = new URL('http://localhost/');
    }
    // A label from a fixed list — the path text itself is never recorded.
    const route: ApprovalRoute = ROUTES.get(url.pathname) ?? 'other';
    const live = session.live;
    if (!hostAllowed(req, session.server)) {
      live?.refused('bad_host_header', route);
      safeRespond(res, 403, renderErrorPage('Request refused: unexpected Host header.'));
      return;
    }
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }
    // Same-origin poll so a stale tab self-invalidates instead of showing a
    // dead code as if it were live.
    if (req.method === 'GET' && route === 'status' && url.searchParams.get('s') === sessionId) {
      const state = session.statusCheck ? session.statusCheck() : { active: true, status: 'unknown' };
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(JSON.stringify(state));
      return;
    }
    if (req.method === 'GET' && route === 'approve' && url.searchParams.get('s') === sessionId) {
      if (!live) {
        safeRespond(res, 200, session.html);
        return;
      }
      // A live page that cannot be rendered is an error page — never the
      // first render, whose code and state may no longer be true.
      let html: string;
      try {
        const n = url.searchParams.get('n');
        html = live.render({ sessionId, notice: isNoticeCode(n) ? n : null });
      } catch (err) {
        log('error', 'approval page could not be rendered', {
          err: err instanceof Error ? err.name : typeof err,
        });
        safeRespond(res, 500, renderErrorPage('This approval page could not be rendered.'));
        return;
      }
      safeRespond(res, 200, html);
      return;
    }
    if (req.method === 'POST' && (route === 'justification' || route === 'override')) {
      if (!live) {
        safeRespond(res, 404, renderErrorPage('Not found.'));
        return;
      }
      let raw: string;
      try {
        raw = await readBody(req);
      } catch (err) {
        // readBody destroyed the socket on overflow, so no answer can reach
        // the browser: record the refusal and write nothing.
        if (err instanceof Error && err.message === 'request body too large') {
          live.refused('body_too_large', route);
        }
        return;
      }
      const body = new URLSearchParams(raw);
      if (body.get('session') !== sessionId) {
        live.refused('invalid_session_token', route);
        safeRespond(res, 403, renderErrorPage('Invalid session token.'));
        return;
      }
      const notice =
        route === 'justification'
          ? live.saveJustification(body.get('justification') ?? '')
          : live.recordFreezeOverride(body.get('reason') ?? '');
      redirect(res, `/approve?s=${encodeURIComponent(sessionId)}&n=${encodeURIComponent(notice)}`);
      return;
    }
    safeRespond(res, 404, renderErrorPage('Not found.'));
  }

  close(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    clearTimeout(session.hardTimeout);
    this.sessions.delete(sessionId);
    setTimeout(() => session.server.close(), 250).unref?.();
  }
}
