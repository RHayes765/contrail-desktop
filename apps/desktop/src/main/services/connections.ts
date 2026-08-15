import { shell } from 'electron';
import {
  grantDependencyViolations,
  type ConnectionRecord,
  type EngineDeps,
  type GrantSet,
} from '@contrail/engine';
import type { ConnectionView, ConnectOutcomeView, PingResultView } from '@contrail/shared';

/**
 * Connection lifecycle, rehosted from the plugin's connect_org/disconnect_org
 * tools onto IPC. The engine's ConnectFlowManager runs UNCHANGED — same PKCE
 * flow, same localhost grants page, same audit records; the only difference
 * is who starts it (a button instead of an agent) and how the browser opens
 * (Electron's shell instead of the `open` package — set via the FlowOps seam
 * at bootstrap).
 *
 * The authorize URL never crosses IPC: main opens the system browser itself,
 * and the renderer only ever sees status + message.
 */

/** Token-free renderer view of a connection. */
export function connectionView(rec: ConnectionRecord): ConnectionView {
  return {
    id: rec.id,
    alias: rec.alias,
    orgId: rec.orgId,
    orgName: rec.orgName,
    orgType: rec.orgType,
    isSandbox: rec.isSandbox,
    instanceUrl: rec.instanceUrl,
    username: rec.username,
    grants: rec.grants,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    lastUsedAt: rec.lastUsedAt,
  };
}

/** FlowOps browser override for Electron: the OS default browser, no child processes. */
export async function openBrowserViaShell(url: string): Promise<void> {
  await shell.openExternal(url);
}

export class ConnectionService {
  constructor(
    private readonly deps: EngineDeps,
    private readonly notify: (reason: 'connected' | 'updated' | 'removed') => void,
    /** Fired for every completed connect (fresh or re-auth) — auto-baseline hook. */
    private readonly onConnected: (connectionId: string) => void = () => undefined,
  ) {}

  list(): ConnectionView[] {
    return this.deps.db.listConnections().map(connectionView);
  }

  /** Same-org-same-user connections that would duplicate `rec`. */
  private duplicatesOf(rec: ConnectionRecord): ConnectionRecord[] {
    return this.deps.db
      .listConnections()
      .filter(
        (c) =>
          c.id !== rec.id &&
          c.orgId === rec.orgId &&
          c.username != null &&
          c.username === rec.username,
      );
  }

  async connect(opts: { login?: string; label?: string }): Promise<ConnectOutcomeView> {
    const outcome = await this.deps.flows.connectOrg({ login: opts.login, label: opts.label });

    if (outcome.status === 'connected') {
      this.notify('connected');
      this.onConnected(outcome.connection.id);
      const dupe = this.duplicatesOf(outcome.connection)[0];
      const dupeNote = dupe
        ? ` Note: this is the same org and user as existing connection "${dupe.alias}".`
        : '';
      return {
        status: 'connected',
        message: `Connected ${outcome.connection.alias}.${dupeNote}`,
        connection: connectionView(outcome.connection),
      };
    }

    if (outcome.status === 'pending') {
      // The browser flow keeps running; when it actually finishes, tell the
      // renderer so the list refreshes without polling.
      const final = this.deps.flows.activeConnectOutcome();
      if (final) {
        void final.then((o) => {
          if (o.status === 'connected') {
            this.notify('connected');
            this.onConnected(o.connection.id);
          }
        });
      }
      return {
        status: 'pending',
        message: 'Browser opened — finish logging in and set grants on the Contrail page.',
        connection: null,
      };
    }

    return { status: outcome.status, message: outcome.message, connection: null };
  }

  async remove(id: string): Promise<{ ok: boolean; detail: string | null }> {
    const result = await this.deps.flows.disconnectOrg(id);
    this.notify('removed');
    return {
      ok: true,
      detail: result.revoked
        ? `Disconnected ${result.alias} and revoked its token.`
        : `Disconnected ${result.alias}; token revocation ${result.detail ?? 'did not confirm'}.`,
    };
  }

  /**
   * The native grants editor — same rules and audit trail as the Phase 0
   * localhost page, reached ONLY over renderer IPC (a human surface; the
   * agent runtime has no path here). Grant changes apply to live sessions on
   * their very next call: minting is UX, the engine's assertGrant reads the
   * connection row at call time.
   */
  setGrants(id: string, grants: GrantSet): ConnectionView {
    const rec = this.deps.db.resolveConnection(id);
    if (!rec) throw new Error(`Connection ${id} not found.`);
    const violations = grantDependencyViolations(grants);
    if (violations.length > 0) {
      throw new Error(`Invalid grant combination: ${violations.join('; ')}.`);
    }
    const before = rec.grants;
    this.deps.db.updateGrants(rec.id, grants);
    this.deps.audit.record('connection.grants_changed', {
      connectionId: rec.id,
      tool: 'desktop_connections_screen',
      outcome: 'success',
      detail: { before, after: grants },
    });
    this.notify('updated');
    const updated = this.deps.db.resolveConnection(rec.id);
    if (!updated) throw new Error('connection vanished during grant update');
    return connectionView(updated);
  }

  /**
   * Liveness check = an actual token refresh. 'expired' means the human needs
   * to re-auth (Connect again with the same label); 'unreachable' means the
   * org may be fine but we could not talk to it.
   */
  async ping(id: string): Promise<PingResultView> {
    const rec = this.deps.db.resolveConnection(id);
    if (!rec) throw new Error(`Connection ${id} not found.`);
    try {
      await this.deps.tokenMgr.getAccessToken(rec);
      return { status: 'ok', detail: null };
    } catch (err) {
      const text = String(err);
      const expired =
        /invalid_grant|expired|revoked|refresh token/i.test(text) || /401|403/.test(text);
      return {
        status: expired ? 'expired' : 'unreachable',
        detail: text.slice(0, 300),
      };
    }
  }
}
