import { z } from 'zod';
import type { ConnectionRecord } from '../core/types.js';
import { grantedList, notGrantedList } from '../core/grants.js';
import { log } from '../core/log.js';
import type { Capability } from './types.js';
import { ok, fail, guarded } from './result.js';

/**
 * Connection lifecycle + audit capabilities, ported from the Phase 0 tool
 * layer (tools/register.ts). Descriptions are prompt assets. One deliberate
 * divergence: the plugin's list_connections returns (and describes) a
 * staging_dir field so file-authoring agents learn where deploy bytes live;
 * the desktop's sealed runtime has no file tools, so this port omits it.
 */

const PERMISSION_NOTES = [
  'Every metadata deploy and every DML write requires explicit human approval via a confirmation code — in every environment, without exception.',
  'Grants are set by a human on the localhost management page only (manage_connection); they can never be changed through the agent or tool arguments.',
] as const;

/** Public, token-free view of a connection. */
export function connectionSummary(rec: ConnectionRecord) {
  return {
    alias: rec.alias,
    id: rec.id,
    org_id: rec.orgId,
    org_name: rec.orgName,
    org_type: rec.orgType,
    is_sandbox: rec.isSandbox,
    instance_url: rec.instanceUrl,
    username: rec.username,
    grants: rec.grants,
    created_at: rec.createdAt,
    updated_at: rec.updatedAt,
    last_used_at: rec.lastUsedAt,
  };
}

function permissionsView(rec: ConnectionRecord) {
  return {
    connection: rec.alias,
    org_type: rec.orgType,
    granted: grantedList(rec.grants),
    not_granted: notGrantedList(rec.grants),
  };
}

export const connectionCapabilities: Capability[] = [
  {
    name: 'connect_org',
    title: 'Connect a Salesforce org',
    description:
      'Start the browser OAuth flow to connect a Salesforce org. The human logs in as ' +
      'themselves and sets the five capability grants on a local completion page — grants ' +
      'can never be chosen here. Re-running with an existing connection label re-authorizes ' +
      'that connection (the recovery path after a sandbox refresh).',
    grant: null,
    writeClass: false,
    inputSchema: {
      login: z
        .string()
        .optional()
        .describe(
          'Which Salesforce login endpoint to open. Pass this explicitly — it defaults to ' +
            '"production" (login.salesforce.com), and sandbox credentials do NOT work there, ' +
            'so guessing wrong wastes the human\'s login attempt. Use "sandbox" for any ' +
            'sandbox (UAT/QA/staging/full copy) to open test.salesforce.com; "production" for ' +
            'production, developer edition, scratch, and trial orgs; or a My Domain host such ' +
            'as acme--uat.sandbox.my.salesforce.com when the user names one (preferred — ' +
            'unambiguous). Ignored in favor of the stored login host when re-authorizing an ' +
            'existing label.',
        ),
      label: z
        .string()
        .optional()
        .describe(
          'Suggested connection label. If it matches an existing connection, the flow ' +
            're-authorizes that connection. The human can change the label on the page.',
        ),
    },
    handler: (deps, rawArgs) =>
      guarded(async () => {
        const args = rawArgs as { login?: string; label?: string };
        const outcome = await deps.flows.connectOrg({ login: args.login, label: args.label });
        switch (outcome.status) {
          case 'connected':
            return ok(
              connectionSummary(outcome.connection),
              `Connected. The human saved this connection with the grants below.`,
            );
          case 'pending':
            return ok({ authorize_url: outcome.authorizeUrl }, outcome.message);
          case 'timeout':
          case 'superseded':
          case 'error':
            return fail(outcome.message);
        }
      }),
  },
  {
    name: 'disconnect_org',
    title: 'Disconnect a Salesforce org',
    description:
      'Revoke the stored refresh token and remove a connection. Confirm with the human ' +
      'before calling this — it cannot be undone without re-running the OAuth flow.',
    grant: null,
    writeClass: false,
    inputSchema: {
      connection: z.string().describe('Connection alias (or id) to remove.'),
    },
    handler: (deps, rawArgs) =>
      guarded(async () => {
        const args = rawArgs as { connection: string };
        const result = await deps.flows.disconnectOrg(args.connection);
        deps.tokenMgr.invalidate(result.connectionId);
        deps.store.removeConnection(result.connectionId);
        return ok({
          removed: result.alias,
          token_revoked: result.revoked,
          detail: result.detail ?? null,
        });
      }),
  },
  {
    name: 'manage_connection',
    title: 'Open the connection management page',
    description:
      'Open the localhost page where the human can change a connection\'s grants. Grants ' +
      'are only ever set there. The page opens directly in the human\'s browser; its URL ' +
      'is never returned to you — if the browser cannot be opened, the URL goes to ' +
      'Contrail\'s server log for the human. After the human saves, call get_permissions ' +
      'to see the updated grants.',
    grant: null,
    writeClass: false,
    inputSchema: {
      connection: z.string().describe('Connection alias (or id) to manage.'),
    },
    handler: (deps, rawArgs) =>
      guarded(async () => {
        const args = rawArgs as { connection: string };
        const { url, opened, connection } = await deps.flows.manageConnection(args.connection);
        // The URL carries the session token that authorizes the grants save,
        // so — exactly like the approval and settings pages — it never
        // reaches model context on any path. The human already has the page
        // open, or finds its URL in the server log (stderr, and the app's log
        // file).
        if (opened) {
          return ok(
            { connection: connection.alias, page_opened_in_browser: true },
            'Management page opened in the human\'s browser. They set grants there; call ' +
              'get_permissions afterwards to see the result.',
          );
        }
        log(
          'warn',
          'connection management page could not auto-open — open it yourself to change grants',
          { url },
        );
        return ok(
          {
            connection: connection.alias,
            page_opened_in_browser: false,
            note:
              'The management page could not be opened automatically. Its URL was written to the ' +
              'Contrail server log (stderr) for the human to open — it is deliberately NOT ' +
              'provided to you, because the page saves grants. Ask the human to open the page ' +
              'from the Contrail log, and call get_permissions after they save.',
          },
          'The browser could not be opened automatically; the human can find the page URL in ' +
            'the Contrail server log.',
        );
      }),
  },
  {
    name: 'list_connections',
    title: 'List connected orgs',
    description:
      'List every connected org with its alias, org identity, type, and grants. Zero-cost ' +
      'local read — call this instead of guessing which orgs exist. ' +
      'Also reports, per connection, policy: the rules that apply to it — from the ' +
      "human's config.json, or Contrail's built-in default when that file has no policies " +
      'section (policies_status.source says which) — whether a justification or ticket is ' +
      'required (and the ticket pattern), what is denied, the minimum test_level, its ' +
      'freeze windows and whether one is in effect right now — so a proposal can comply ' +
      'the first time; policies_status.unmatched_rules names rules whose label or org id ' +
      'matches no connection on this machine — tell the human, a re-created connection may ' +
      'have left a rule behind; policies_status also says whether the rules could be read, ' +
      'and when they could not, every write proposal is refused until the human fixes the ' +
      'file.',
    grant: null,
    writeClass: false,
    inputSchema: {},
    handler: (deps) =>
      guarded(() => {
        // S46 (B): each connection carries the policy that applies to it now
        // (null when the policies cannot be read — policies_status says why),
        // all from ONE read of the policies over ONE listing of connections.
        const conns = deps.db.listConnections();
        const policy = deps.deploys.policyListing(conns);
        const list = conns.map((rec, i) => ({
          ...connectionSummary(rec),
          policy: policy.reports[i] ?? null,
        }));
        return ok({
          connections: list,
          count: list.length,
          // S46 (B): whether the policies could be read, where they came
          // from, and any rule that matches no connection on this machine.
          policies_status: policy.status,
        });
      }),
  },
  {
    name: 'get_permissions',
    title: 'Get the grants matrix',
    description:
      'Full permission matrix for one or all connections, including what is NOT granted, ' +
      'so capabilities are never discovered by trial and error. Zero-cost local read.',
    grant: null,
    writeClass: false,
    inputSchema: {
      connection: z
        .string()
        .optional()
        .describe('Connection alias (or id). Omit for all connections.'),
    },
    handler: (deps, rawArgs) =>
      guarded(() => {
        const args = rawArgs as { connection?: string };
        if (args.connection) {
          const rec = deps.db.resolveConnection(args.connection);
          if (!rec) {
            return fail(
              `No connection matches "${args.connection}". Call list_connections to see what exists.`,
            );
          }
          return ok({ ...permissionsView(rec), notes: PERMISSION_NOTES });
        }
        return ok({
          connections: deps.db.listConnections().map(permissionsView),
          notes: PERMISSION_NOTES,
        });
      }),
  },
  {
    name: 'get_audit_log',
    title: 'Read the local audit log',
    description:
      'Query the local audit log: connection lifecycle, OAuth flows, grant and policy ' +
      'refusals, freeze overrides, and every deploy, data, Apex, bulk and agent-activation ' +
      'decision. Local; export_change_evidence writes a per-request dossier from it.',
    grant: null,
    writeClass: false,
    inputSchema: {
      connection: z
        .string()
        .optional()
        .describe('Filter to one connection by alias (or id).'),
      since: z
        .string()
        .optional()
        .describe('ISO 8601 timestamp; only events at or after this instant.'),
      // S46 (B): the rows that name one request, one event type or family, and an end bound.
      request_id: z
        .string()
        .optional()
        .describe(
          'Only events that name this request id (the request_id a validate or propose result ' +
            'returned) — among them its proposal, phone push, refusals (an execute refused by a ' +
            'policy included), freeze override, justification edits, execution, and the sweep ' +
            'that expired it. Supersession by a newer validation is recorded per connection and ' +
            'is not included; a policy check that passes is recorded on the request, not in the log.',
        ),
      event_type: z
        .string()
        .optional()
        .describe(
          'Only this event type (for example policy.refused), or every type under a prefix ' +
            'ending in a dot (for example policy.).',
        ),
      until: z
        .string()
        .optional()
        .describe('ISO 8601 timestamp; only events at or before this instant.'),
      limit: z.number().int().min(1).max(1000).optional().describe('Max events (default 100).'),
    },
    handler: (deps, rawArgs) =>
      guarded(() => {
        const args = rawArgs as {
          connection?: string;
          since?: string;
          request_id?: string;
          event_type?: string;
          until?: string;
          limit?: number;
        };
        let connectionId: string | undefined;
        if (args.connection) {
          const rec = deps.db.resolveConnection(args.connection);
          if (!rec) {
            return fail(
              `No connection matches "${args.connection}". Call list_connections to see what exists.`,
            );
          }
          connectionId = rec.id;
        }
        // A request_id that is not a request id, or a malformed event_type, is
        // refused by the query itself — never matched loosely.
        const events = deps.audit.query({
          connectionId,
          since: args.since,
          until: args.until,
          requestId: args.request_id,
          eventType: args.event_type,
          limit: args.limit,
        });
        // Snake_case for model consistency with every other capability's output.
        return ok({
          events: events.map((e) => ({
            id: e.id,
            ts: e.ts,
            event_type: e.eventType,
            connection_id: e.connectionId,
            tool: e.tool,
            outcome: e.outcome,
            detail: e.detail,
          })),
          count: events.length,
        });
      }),
  },
];
