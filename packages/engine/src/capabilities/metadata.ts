import { z } from 'zod';
import type { EngineDeps } from '../core/deps.js';
import type { ConnectionRecord } from '../core/types.js';
import { ConnectionNotFoundError } from '../core/errors.js';
import { assertGrant } from '../core/gate.js';
import { RestClient } from '../salesforce/rest.js';
import { MetadataSoapClient } from '../salesforce/metadataSoap.js';
import { queryDependencies } from '../deps/graph.js';
import { fetchArtifactContent, truncateContent } from '../metadata/read.js';
import type { Capability } from './types.js';
import { ok, fail, guarded } from './result.js';

/**
 * The metadata_read capability surface, ported verbatim from the Phase 0
 * tool layer (tools/metadata.ts registrations). Every handler resolves its
 * target connection and passes the layer-2 grant gate before touching anything.
 */

const NAME_RE = /^[A-Za-z0-9_.\- ]+$/;
const TYPE_RE = /^[A-Za-z]+$/;

export function requireConnection(
  deps: Pick<EngineDeps, 'db' | 'audit'>,
  ref: string,
  tool: string,
): ConnectionRecord {
  const rec = deps.db.resolveConnection(ref);
  if (!rec) throw new ConnectionNotFoundError(ref);
  assertGrant(rec, tool, deps.audit);
  return rec;
}

export const metadataCapabilities: Capability[] = [
  {
    name: 'list_metadata',
    title: 'List metadata inventory',
    description:
      'List indexed metadata for a connection from the local snapshot: all type counts, or ' +
      'the artifacts of one type. Set live=true (with a type) to query the org directly ' +
      'via listMetadata instead of the snapshot.',
    grant: 'metadata_read',
    writeClass: false,
    inputSchema: {
      connection: z.string().describe('Connection alias (or id).'),
      type: z
        .string()
        .optional()
        .describe('Metadata type, e.g. ApexClass, Flow, CustomObject, CustomField.'),
      live: z
        .boolean()
        .optional()
        .describe('Query the org directly (requires type). Default: read the local index.'),
    },
    handler: (deps, rawArgs) =>
      guarded(async () => {
        const args = rawArgs as { connection: string; type?: string; live?: boolean };
        const { db, config, tokenMgr, engine: _engine } = deps;
        const conn = requireConnection(deps, args.connection, 'list_metadata');
        if (args.type && !TYPE_RE.test(args.type)) return fail('invalid metadata type');
        if (args.live) {
          if (!args.type) return fail('live=true requires a metadata type.');
          const soap = new MetadataSoapClient(tokenMgr, conn, config.salesforce.apiVersion);
          const props = await soap.listMetadata([args.type]);
          const items = new Map<string, Record<string, unknown>>(
            props.map((p) => [
              p.fullName.toLowerCase(),
              {
                api_name: p.fullName,
                last_modified: p.lastModifiedDate,
                last_modified_by: p.lastModifiedByName,
                source: 'metadata_api',
              },
            ]),
          );
          // Standard/feature-delivered flows are invisible to Metadata API
          // listMetadata AND Tooling FlowDefinition — FlowDefinitionView
          // (regular API) is the only complete inventory. Union it in.
          if (args.type === 'Flow') {
            const rest = new RestClient(tokenMgr, conn, config.salesforce.apiVersion);
            try {
              const views = await rest.query<{
                ApiName: string;
                ProcessType: string | null;
                NamespacePrefix: string | null;
              }>('SELECT ApiName, ProcessType, NamespacePrefix FROM FlowDefinitionView', 2000);
              for (const v of views) {
                if (!v.ApiName) continue;
                // Metadata API fullNames are namespace-qualified; FlowDefinitionView
                // splits the namespace out — qualify before matching, or every
                // managed flow double-lists.
                const qualified = v.NamespacePrefix ? `${v.NamespacePrefix}__${v.ApiName}` : v.ApiName;
                const existing = items.get(qualified.toLowerCase());
                if (existing) existing.source = 'both';
                else {
                  items.set(qualified.toLowerCase(), {
                    api_name: qualified,
                    process_type: v.ProcessType,
                    last_modified: null,
                    last_modified_by: null,
                    source: 'flow_definition_view',
                  });
                }
              }
            } catch {
              // FlowDefinitionView unavailable — Metadata API listing still stands.
            }
          }
          return ok({
            connection: conn.alias,
            source: 'org',
            type: args.type,
            count: items.size,
            items: [...items.values()].slice(0, 500),
            ...(args.type === 'Flow'
              ? {
                  note: 'source=flow_definition_view flows are standard/feature-delivered — invisible to the Metadata API, and their content is not exposed by any API. retrieve_metadata returns their descriptor.',
                }
              : {}),
          });
        }
        const counts = db.countArtifactsByType(conn.id);
        if (Object.keys(counts).length === 0) {
          return ok({
            connection: conn.alias,
            source: 'index',
            counts: {},
            note: 'No snapshot yet for this connection — run refresh_snapshot first.',
          });
        }
        if (!args.type) {
          return ok({ connection: conn.alias, source: 'index', counts });
        }
        const items = db.listArtifacts(conn.id, args.type);
        return ok({
          connection: conn.alias,
          source: 'index',
          type: args.type,
          count: items.length,
          items: items.slice(0, 500).map((a) => ({
            api_name: a.apiName,
            last_modified: a.lastModifiedDate,
            last_modified_by: a.lastModifiedBy,
          })),
          ...(args.type === 'Flow'
            ? {
                note: 'The snapshot only holds Metadata-API-visible flows; standard/feature-delivered flows appear with live=true (source=flow_definition_view).',
              }
            : {}),
        });
      }),
  },
  {
    name: 'retrieve_metadata',
    title: 'Retrieve metadata artifacts',
    description:
      'Retrieve the source of specific artifacts (Flow XML, Apex bodies, object/field ' +
      'definitions, validation rules, labels) with a one-hop dependency summary each. ' +
      'Apex bodies come live from the Tooling API; everything else reads the local ' +
      'snapshot (refresh_snapshot if stale or missing).',
    grant: 'metadata_read',
    writeClass: false,
    inputSchema: {
      connection: z.string().describe('Connection alias (or id).'),
      type: z
        .string()
        .describe(
          'Metadata type: ApexClass, ApexTrigger, Flow, CustomObject, CustomField, ' +
            'ValidationRule, CustomLabel, PermissionSet.',
        ),
      names: z
        .array(z.string())
        .min(1)
        .max(10)
        .describe('Full API names; children dotted (Account.MyField__c).'),
      include_dependencies: z
        .boolean()
        .optional()
        .describe('Attach one-hop uses/used_by summaries (default true).'),
    },
    handler: (deps, rawArgs) =>
      guarded(async () => {
        const args = rawArgs as {
          connection: string;
          type: string;
          names: string[];
          include_dependencies?: boolean;
        };
        const { db } = deps;
        const conn = requireConnection(deps, args.connection, 'retrieve_metadata');
        if (!TYPE_RE.test(args.type)) return fail('invalid metadata type');
        const includeDeps = args.include_dependencies !== false;
        const results: Array<Record<string, unknown>> = [];
        for (const name of args.names) {
          if (!NAME_RE.test(name)) {
            results.push({ api_name: name, error: 'invalid artifact name' });
            continue;
          }
          try {
            const content = await fetchArtifactContent(deps, conn, args.type, name);
            const entry: Record<string, unknown> = {
              api_name: name,
              type: args.type,
              content: truncateContent(content.body),
              source: content.source,
            };
            if (content.note) entry.note = content.note;
            if (includeDeps) {
              entry.uses = db
                .edgesFrom(conn.id, args.type, name)
                .slice(0, 15)
                .map((e) => `${e.toType}:${e.toName} (${e.source})`);
              entry.used_by = db
                .edgesTo(conn.id, args.type, name)
                .slice(0, 15)
                .map((e) => `${e.fromType}:${e.fromName} (${e.source})`);
            }
            results.push(entry);
          } catch (err) {
            results.push({
              api_name: name,
              error: String(err instanceof Error ? err.message : err),
            });
          }
        }
        return ok({ connection: conn.alias, type: args.type, artifacts: results });
      }),
  },
  {
    name: 'describe_schema',
    title: 'Describe an object schema',
    description:
      'Live object/field describe for one SObject: fields with types and references, ' +
      'record types, relationship counts. Compact by design; use retrieve_metadata for ' +
      'full field XML definitions.',
    grant: 'metadata_read',
    writeClass: false,
    inputSchema: {
      connection: z.string().describe('Connection alias (or id).'),
      object: z.string().describe('SObject API name, e.g. Account or Invoice__c.'),
    },
    handler: (deps, rawArgs) =>
      guarded(async () => {
        const args = rawArgs as { connection: string; object: string };
        const { config, tokenMgr } = deps;
        const conn = requireConnection(deps, args.connection, 'describe_schema');
        if (!/^[A-Za-z0-9_]+$/.test(args.object)) return fail('invalid object API name');
        const rest = new RestClient(tokenMgr, conn, config.salesforce.apiVersion);
        const d = (await rest.describeSObject(args.object)) as {
          name: string;
          label: string;
          custom: boolean;
          fields: Array<Record<string, unknown>>;
          recordTypeInfos?: Array<{ name: string; developerName?: string; active?: boolean }>;
          childRelationships?: unknown[];
        };
        const fields = (d.fields ?? []).slice(0, 300).map((f) => {
          const picklist = (f.picklistValues as Array<{ value: string }> | undefined) ?? [];
          return {
            name: f.name,
            label: f.label,
            type: f.type,
            ...(f.length && (f.type === 'string' || f.type === 'textarea')
              ? { length: f.length }
              : {}),
            ...((f.referenceTo as string[] | undefined)?.length
              ? { references: f.referenceTo }
              : {}),
            ...(picklist.length
              ? {
                  picklist_values: picklist.slice(0, 10).map((p) => p.value),
                  picklist_count: picklist.length,
                }
              : {}),
            ...(f.calculated ? { formula_field: true } : {}),
            required: f.nillable === false && f.defaultedOnCreate === false,
            updateable: f.updateable === true,
          };
        });
        return ok({
          connection: conn.alias,
          object: d.name,
          label: d.label,
          custom: d.custom,
          field_count: (d.fields ?? []).length,
          fields_truncated: (d.fields ?? []).length > 300,
          fields,
          record_types: (d.recordTypeInfos ?? []).map((r) => r.developerName ?? r.name),
          child_relationship_count: (d.childRelationships ?? []).length,
        });
      }),
  },
  {
    name: 'search_metadata',
    title: 'Search the metadata snapshot',
    description:
      'Name and full-text content search over the local snapshot index — find artifacts ' +
      'by name fragment or by what their source mentions (a field name, a label, a class).',
    grant: 'metadata_read',
    writeClass: false,
    inputSchema: {
      connection: z.string().describe('Connection alias (or id).'),
      query: z.string().min(2).describe('Search text.'),
      types: z.array(z.string()).optional().describe('Restrict to these metadata types.'),
      limit: z.number().int().min(1).max(50).optional().describe('Max results (default 20).'),
    },
    handler: (deps, rawArgs) =>
      guarded(() => {
        const args = rawArgs as {
          connection: string;
          query: string;
          types?: string[];
          limit?: number;
        };
        const { db } = deps;
        const conn = requireConnection(deps, args.connection, 'search_metadata');
        const results = db.searchArtifacts(conn.id, args.query, args.types, args.limit ?? 20);
        if (results.length === 0 && Object.keys(db.countArtifactsByType(conn.id)).length === 0) {
          return ok({
            connection: conn.alias,
            results: [],
            note: 'No snapshot yet for this connection — run refresh_snapshot first.',
          });
        }
        return ok({ connection: conn.alias, query: args.query, results });
      }),
  },
  {
    name: 'get_dependencies',
    title: 'Query the dependency graph',
    description:
      'Neighborhood, reverse dependencies, and blast radius for one artifact from the ' +
      'local dependency graph (org dependency API + Contrail\'s reference extractor). ' +
      '"used_by" answers: what breaks if I change this?',
    grant: 'metadata_read',
    writeClass: false,
    inputSchema: {
      connection: z.string().describe('Connection alias (or id).'),
      type: z.string().describe('Metadata type of the root artifact.'),
      name: z.string().describe('Full API name of the root artifact.'),
      direction: z
        .enum(['uses', 'used_by', 'both'])
        .optional()
        .describe('Traversal direction (default both).'),
      depth: z.number().int().min(1).max(3).optional().describe('Hops from the root (default 1).'),
    },
    handler: (deps, rawArgs) =>
      guarded(() => {
        const args = rawArgs as {
          connection: string;
          type: string;
          name: string;
          direction?: 'uses' | 'used_by' | 'both';
          depth?: number;
        };
        const { db } = deps;
        const conn = requireConnection(deps, args.connection, 'get_dependencies');
        const known =
          db.getArtifact(conn.id, args.type, args.name) !== null ||
          db.edgesFrom(conn.id, args.type, args.name).length > 0 ||
          db.edgesTo(conn.id, args.type, args.name).length > 0;
        if (!known) {
          return fail(
            `No artifact or edges found for ${args.type}:${args.name} in the local graph. ` +
              `Check the name with search_metadata or list_metadata, or run refresh_snapshot.`,
          );
        }
        const graph = queryDependencies(
          db,
          conn.id,
          args.type,
          args.name,
          args.direction ?? 'both',
          args.depth ?? 1,
        );
        return ok({ connection: conn.alias, ...graph });
      }),
  },
  {
    name: 'refresh_snapshot',
    title: 'Refresh the metadata snapshot',
    description:
      'Manifest-driven re-retrieve of the org\'s metadata into the local snapshot + index ' +
      '+ dependency graph. Long-running on big orgs: an in-progress result means call ' +
      'refresh_snapshot again to check on it. check_only=true just reports staleness.',
    grant: 'metadata_read',
    writeClass: false,
    inputSchema: {
      connection: z.string().describe('Connection alias (or id).'),
      types: z
        .array(z.string())
        .optional()
        .describe('Metadata types to refresh (default: the configured manifest).'),
      check_only: z
        .boolean()
        .optional()
        .describe('Only compare org lastModifiedDate against the index; retrieve nothing.'),
    },
    handler: (deps, rawArgs) =>
      guarded(async () => {
        const args = rawArgs as { connection: string; types?: string[]; check_only?: boolean };
        const conn = requireConnection(deps, args.connection, 'refresh_snapshot');
        if (args.types?.some((t) => !TYPE_RE.test(t))) return fail('invalid metadata type');
        if (args.check_only) {
          const report = await deps.engine.checkStaleness(conn, args.types);
          return ok({ connection: conn.alias, ...report });
        }
        const outcome = await deps.engine.refresh(conn, args.types);
        switch (outcome.status) {
          case 'complete':
            return ok(outcome.summary, 'Snapshot refreshed.');
          case 'failed':
            return fail(`Snapshot refresh failed: ${outcome.error}`);
          case 'in_progress':
            return ok(
              outcome.state,
              'Refresh is still running. Call refresh_snapshot again with the same ' +
                'connection to check progress or collect the result.',
            );
          case 'locked':
            return fail(
              'Another Contrail process is already refreshing this connection. ' +
                'Wait for it to finish and try again.',
            );
          case 'gone':
            // Unreachable without observeJobId, but the switch stays total.
            return fail('The refresh being observed has already been collected.');
        }
      }),
  },
];
