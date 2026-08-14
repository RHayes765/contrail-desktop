import { z } from 'zod';
import type { ConnectionRecord } from '../core/types.js';
import { grantedList, notGrantedList } from '../core/grants.js';
import type { Capability } from './types.js';
import { ok, fail, guarded } from './result.js';

/**
 * Connection lifecycle + audit capabilities, ported verbatim from the Phase 0
 * tool layer (tools/register.ts). Descriptions are prompt assets — unchanged.
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
      'is returned only if the browser could not be opened automatically. After the human ' +
      'saves, call get_permissions to see the updated grants.',
    grant: null,
    writeClass: false,
    inputSchema: {
      connection: z.string().describe('Connection alias (or id) to manage.'),
    },
    handler: (deps, rawArgs) =>
      guarded(async () => {
        const args = rawArgs as { connection: string };
        const { url, opened, connection } = await deps.flows.manageConnection(args.connection);
        if (opened) {
          // The URL carries the session token that authorizes the grants
          // save; it stays out of model context on purpose. The human
          // already has the page open in their browser.
          return ok(
            { connection: connection.alias, page_opened_in_browser: true },
            'Management page opened in the human\'s browser. They set grants there; call ' +
              'get_permissions afterwards to see the result.',
          );
        }
        return ok(
          { connection: connection.alias, page_opened_in_browser: false, management_url: url },
          'The browser could not be opened automatically. Give the human this URL to open ' +
            'themselves — do not fetch it. Call get_permissions after they save.',
        );
      }),
  },
  {
    name: 'list_connections',
    title: 'List connected orgs',
    description:
      'List every connected org with its alias, org identity, type, and grants. Zero-cost ' +
      'local read — call this instead of guessing which orgs exist.',
    grant: null,
    writeClass: false,
    inputSchema: {},
    handler: (deps) =>
      guarded(() => {
        const list = deps.db.listConnections().map(connectionSummary);
        return ok({ connections: list, count: list.length });
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
      'Query the local audit log: connection lifecycle, OAuth flows, grant refusals, and ' +
      '(from later milestones) every deploy and DML decision. Local and exportable.',
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
      limit: z.number().int().min(1).max(1000).optional().describe('Max events (default 100).'),
    },
    handler: (deps, rawArgs) =>
      guarded(() => {
        const args = rawArgs as { connection?: string; since?: string; limit?: number };
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
        const events = deps.audit.query({ connectionId, since: args.since, limit: args.limit });
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
