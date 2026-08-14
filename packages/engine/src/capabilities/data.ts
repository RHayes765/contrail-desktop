import { z } from 'zod';
import type { EngineDeps } from '../core/deps.js';
import type { ConnectionRecord } from '../core/types.js';
import type { Grant } from '../core/grants.js';
import { RestClient, stripAttributes } from '../salesforce/rest.js';
import type { Capability } from './types.js';
import { ok, fail, guarded } from './result.js';
import { requireConnection } from './metadata.js';

/**
 * data_read and diagnostics_read capabilities, ported verbatim from the
 * Phase 0 tool layer (tools/data.ts). Row-capped, count included; diagnostics
 * accepts incidental record data knowingly — the skill tells the agent to
 * treat it as client-confidential.
 */

/**
 * Setup sObjects that expose metadata or diagnostics content through the
 * plain data API. A query touching one requires the corresponding grant on
 * top of data_read — otherwise `SELECT Body FROM ApexClass` would read what
 * the grant model reserves for metadata_read.
 */
export const GRANT_GATED_SOBJECTS: Readonly<Record<string, Grant>> = {
  apexclass: 'metadata_read',
  apextrigger: 'metadata_read',
  apexpage: 'metadata_read',
  apexcomponent: 'metadata_read',
  emailtemplate: 'metadata_read',
  staticresource: 'metadata_read',
  flowdefinitionview: 'metadata_read',
  apexlog: 'diagnostics_read',
  flowinterview: 'diagnostics_read',
};

const DEFAULT_ROWS = 500;
const MAX_ROWS = 2000;
const MAX_RESPONSE_CHARS = 150_000;
const LOG_SLICE = 30_000;

function rest(deps: Pick<EngineDeps, 'tokenMgr' | 'config'>, conn: ConnectionRecord): RestClient {
  return new RestClient(deps.tokenMgr, conn, deps.config.salesforce.apiVersion);
}

export const dataCapabilities: Capability[] = [
  {
    name: 'soql_query',
    title: 'Run a SOQL query',
    description:
      'Run a read-only SOQL SELECT against a connection. Row-capped (default 500, max ' +
      '2000) with the org-side total count included so truncation is never silent.',
    grant: 'data_read',
    writeClass: false,
    inputSchema: {
      connection: z.string().describe('Connection alias (or id).'),
      query: z.string().min(8).describe('The SOQL SELECT statement.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_ROWS)
        .optional()
        .describe(`Row cap (default ${DEFAULT_ROWS}).`),
    },
    handler: (deps, rawArgs) =>
      guarded(async () => {
        const args = rawArgs as { connection: string; query: string; limit?: number };
        const conn = requireConnection(deps, args.connection, 'soql_query');
        const soql = args.query.trim();
        if (!/^select\s/i.test(soql)) return fail('Only SELECT queries are accepted.');
        // Structural checks run on the literal-stripped text so quoted values
        // can neither trip them nor hide from them.
        const structural = stripSoqlLiterals(soql);
        if (/\bfor\s+update\b/i.test(structural)) {
          return fail('FOR UPDATE locks rows — not available through soql_query.');
        }
        for (const m of structural.matchAll(/\bFROM\s+([A-Za-z0-9_]+)/gi)) {
          const required = GRANT_GATED_SOBJECTS[m[1]!.toLowerCase()];
          if (required && !conn.grants[required]) {
            deps.audit.record('grant.refused', {
              connectionId: conn.id,
              tool: 'soql_query',
              outcome: 'refused',
              detail: { required, sobject: m[1] },
            });
            return fail(
              `${m[1]} carries ${required === 'metadata_read' ? 'metadata' : 'diagnostics'} ` +
                `content, so querying it requires the "${required}" grant on "${conn.alias}" ` +
                `in addition to data_read. Grants are set on the connection management page ` +
                `(manage_connection).`,
            );
          }
        }
        const cap = args.limit ?? DEFAULT_ROWS;
        const { records, totalSize } = await rest(deps, conn).queryWithCount(soql, cap);
        const cleaned = records.map((r) => truncateDeep(stripAttributes(r)));
        const { kept, dropped } = fitToBudget(cleaned, MAX_RESPONSE_CHARS);
        const truncated =
          dropped > 0 || (totalSize !== null && kept.length > 0 && totalSize > kept.length);
        return ok({
          connection: conn.alias,
          total_size: totalSize,
          returned: kept.length,
          row_cap: cap,
          truncated,
          ...(kept.length === 0 && (totalSize ?? 0) > 0
            ? { note: 'Aggregate/COUNT query — total_size carries the result; there is no row payload.' }
            : dropped > 0
              ? { note: `${dropped} rows omitted to keep the response under the size budget.` }
              : {}),
          records: kept,
        });
      }),
  },
  {
    name: 'get_record',
    title: 'Get one record by id',
    description: 'Fetch a single record by object API name and record id.',
    grant: 'data_read',
    writeClass: false,
    inputSchema: {
      connection: z.string().describe('Connection alias (or id).'),
      object: z.string().describe('SObject API name, e.g. Account or Invoice__c.'),
      id: z.string().describe('15- or 18-character record id.'),
      fields: z
        .array(z.string())
        .optional()
        .describe('Specific fields to fetch (default: all accessible).'),
    },
    handler: (deps, rawArgs) =>
      guarded(async () => {
        const args = rawArgs as {
          connection: string;
          object: string;
          id: string;
          fields?: string[];
        };
        const conn = requireConnection(deps, args.connection, 'get_record');
        if (!/^[A-Za-z0-9_]+$/.test(args.object)) return fail('invalid object API name');
        if (!/^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(args.id)) return fail('invalid record id');
        if (args.fields?.some((f) => !/^[A-Za-z0-9_.]+$/.test(f))) {
          return fail('invalid field name');
        }
        const path =
          `/services/data/${deps.config.salesforce.apiVersion}/sobjects/` +
          `${encodeURIComponent(args.object)}/${encodeURIComponent(args.id)}` +
          (args.fields?.length ? `?fields=${encodeURIComponent(args.fields.join(','))}` : '');
        const res = await rest(deps, conn).request(path);
        const record = truncateDeep(stripAttributes((await res.json()) as Record<string, unknown>));
        return ok({ connection: conn.alias, object: args.object, record });
      }),
  },
  {
    name: 'get_debug_logs',
    title: 'List or read Apex debug logs',
    description:
      'Without log_id: list recent debug logs (user, operation, status, size, time). With ' +
      'log_id: fetch that log\'s body — head and tail slices for large logs. Log bodies ' +
      'can contain record data; treat as client-confidential.',
    grant: 'diagnostics_read',
    writeClass: false,
    inputSchema: {
      connection: z.string().describe('Connection alias (or id).'),
      log_id: z.string().optional().describe('ApexLog id to fetch the body of.'),
      limit: z.number().int().min(1).max(50).optional().describe('Max logs to list (default 10).'),
    },
    handler: (deps, rawArgs) =>
      guarded(async () => {
        const args = rawArgs as { connection: string; log_id?: string; limit?: number };
        const conn = requireConnection(deps, args.connection, 'get_debug_logs');
        const client = rest(deps, conn);
        if (args.log_id) {
          if (!/^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(args.log_id)) {
            return fail('invalid log id');
          }
          const res = await client.request(
            `/services/data/${deps.config.salesforce.apiVersion}/tooling/sobjects/ApexLog/` +
              `${encodeURIComponent(args.log_id)}/Body`,
          );
          const body = await res.text();
          if (body.length <= LOG_SLICE * 2) {
            return ok({ connection: conn.alias, log_id: args.log_id, length: body.length, body });
          }
          return ok({
            connection: conn.alias,
            log_id: args.log_id,
            length: body.length,
            note: `Log is ${body.length} chars; returning head and tail slices.`,
            head: body.slice(0, LOG_SLICE),
            tail: body.slice(-LOG_SLICE),
          });
        }
        const rows = await client.toolingQuery<Record<string, unknown>>(
          `SELECT Id, LogUser.Name, Operation, Request, Status, LogLength, StartTime, ` +
            `DurationMilliseconds FROM ApexLog ORDER BY StartTime DESC LIMIT ${args.limit ?? 10}`,
        );
        return ok({
          connection: conn.alias,
          count: rows.length,
          logs: rows.map((r) => stripAttributes(r)),
        });
      }),
  },
  {
    name: 'get_flow_errors',
    title: 'List flow interview problems',
    description:
      'List recent persisted flow interviews (paused/errored) with their stuck element. ' +
      'Honest limitation: Salesforce does not persist most failed interviews queryably — ' +
      'full failure detail lives in flow error emails and debug logs (get_debug_logs).',
    grant: 'diagnostics_read',
    writeClass: false,
    inputSchema: {
      connection: z.string().describe('Connection alias (or id).'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('Max interviews to list (default 20).'),
    },
    handler: (deps, rawArgs) =>
      guarded(async () => {
        const args = rawArgs as { connection: string; limit?: number };
        const conn = requireConnection(deps, args.connection, 'get_flow_errors');
        const client = rest(deps, conn);
        const n = args.limit ?? 20;
        let rows: Array<Record<string, unknown>>;
        let statusFieldAvailable = true;
        try {
          rows = await client.query(
            `SELECT Id, InterviewLabel, InterviewStatus, CurrentElement, PauseLabel, ` +
              `CreatedDate, CreatedBy.Name FROM FlowInterview ORDER BY CreatedDate DESC LIMIT ${n}`,
          );
        } catch {
          // InterviewStatus is not queryable in every org/API version.
          statusFieldAvailable = false;
          rows = await client.query(
            `SELECT Id, InterviewLabel, CurrentElement, PauseLabel, CreatedDate, ` +
              `CreatedBy.Name FROM FlowInterview ORDER BY CreatedDate DESC LIMIT ${n}`,
          );
        }
        return ok({
          connection: conn.alias,
          count: rows.length,
          interviews: rows.map((r) => stripAttributes(r)),
          status_field_available: statusFieldAvailable,
          note:
            'Persisted interviews are the paused/errored ones Salesforce keeps. Most runtime ' +
            'flow failures are only delivered via error emails and debug logs — use ' +
            'get_debug_logs around the failure time for the full story.',
        });
      }),
  },
];

function fitToBudget(records: unknown[], budget: number): { kept: unknown[]; dropped: number } {
  let total = 0;
  const kept: unknown[] = [];
  for (const r of records) {
    total += JSON.stringify(r).length + 2;
    if (total > budget) break;
    kept.push(r);
  }
  return { kept, dropped: records.length - kept.length };
}

/** Blank out quoted literals (keeping length illusions out of structural regexes). */
function stripSoqlLiterals(soql: string): string {
  return soql.replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

const MAX_STRING_FIELD = 10_000;

/** Cap individual string fields — one giant rich-text field must not eat the response. */
function truncateDeep(value: unknown): unknown {
  if (typeof value === 'string' && value.length > MAX_STRING_FIELD) {
    return `${value.slice(0, MAX_STRING_FIELD)}… [truncated ${value.length - MAX_STRING_FIELD} chars]`;
  }
  if (Array.isArray(value)) return value.map((v) => truncateDeep(v));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = truncateDeep(v);
    return out;
  }
  return value;
}
