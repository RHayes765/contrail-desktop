import type { EngineDeps } from '../core/deps.js';
import type { ConnectionRecord } from '../core/types.js';
import { ContrailError } from '../core/errors.js';
import { RestClient, stripAttributes } from '../salesforce/rest.js';
import { findChildBlock } from '../snapshot/indexer.js';

/**
 * Artifact content resolution — extracted verbatim from the Phase 0 MCP tool
 * layer (tools/metadata.ts). The live/snapshot branching below encodes
 * hard-won org behavior (Tooling API short names, hidden managed bodies, the
 * three-tier Flow fallback ending at FlowDefinitionView for platform-delivered
 * flows) — treat it as engine knowledge, not surface plumbing.
 */

export const MAX_CONTENT_PER_ARTIFACT = 60_000;

/** Container file location + child tag for fragment types. */
export const CHILD_SPEC: Record<string, { parentType: string; tag: string }> = {
  CustomField: { parentType: 'CustomObject', tag: 'fields' },
  ValidationRule: { parentType: 'CustomObject', tag: 'validationRules' },
  CustomLabel: { parentType: 'CustomLabels', tag: 'labels' },
};

type ReadDeps = Pick<EngineDeps, 'db' | 'store' | 'tokenMgr' | 'config'>;

export interface ArtifactContent {
  body: string;
  source: string;
  note?: string;
}

export async function fetchArtifactContent(
  deps: ReadDeps,
  conn: ConnectionRecord,
  type: string,
  name: string,
): Promise<ArtifactContent> {
  const { db, store, tokenMgr, config } = deps;

  if (type === 'ApexClass' || type === 'ApexTrigger') {
    const rest = new RestClient(tokenMgr, conn, config.salesforce.apiVersion);
    try {
      const { ns, short } = splitNamespace(name);
      const rows = await rest.toolingQuery<{ Body: string; NamespacePrefix: string | null }>(
        `SELECT Body, NamespacePrefix FROM ${type} WHERE Name = '${short.replaceAll("'", "\\'")}'`,
        10,
      );
      const row = pickByNamespace(rows, ns);
      // Managed bodies come back as the literal "(hidden)" — not useful content.
      if (row?.Body && row.Body !== '(hidden)') {
        return { body: row.Body, source: 'tooling_api_live' };
      }
    } catch {
      // fall through to snapshot
    }
    const fromSnapshot = readSnapshotArtifact(deps, conn, type, name);
    if (fromSnapshot) {
      return {
        body: fromSnapshot,
        source: 'snapshot',
        note: 'Live Tooling API read failed or returned nothing; this is the snapshot copy.',
      };
    }
    throw new ContrailError(
      `${type} ${name} not found via the Tooling API or the local snapshot.`,
      'artifact_not_found',
    );
  }

  if (type === 'Flow') {
    const body = readSnapshotArtifact(deps, conn, type, name);
    if (body) return { body, source: 'snapshot' };
    // Standard/feature-delivered flows never appear in Metadata API
    // retrieves; fall back to the Tooling API before reporting not-found.
    const rest = new RestClient(tokenMgr, conn, config.salesforce.apiVersion);
    const { ns, short } = splitNamespace(name);
    const escaped = short.replaceAll("'", "\\'");
    const defs = pickAllByNamespace(
      await rest.toolingQuery<{
        Id: string;
        ActiveVersionId: string | null;
        LatestVersionId: string | null;
        NamespacePrefix: string | null;
      }>(
        `SELECT Id, ActiveVersionId, LatestVersionId, NamespacePrefix FROM FlowDefinition ` +
          `WHERE DeveloperName = '${escaped}'`,
        10,
      ),
      ns,
    );
    const versionId = defs[0]?.ActiveVersionId ?? defs[0]?.LatestVersionId;
    if (versionId) {
      const versions = await rest.toolingQuery<{ Metadata: unknown }>(
        `SELECT Metadata FROM Flow WHERE Id = '${versionId.replaceAll("'", "\\'")}'`,
        1,
      );
      if (versions[0]?.Metadata) {
        return {
          body: JSON.stringify(versions[0].Metadata, null, 2),
          source: 'tooling_api_live',
          note:
            'This flow is not visible to the Metadata API. This is the Tooling API JSON ' +
            `representation of the ${defs[0]?.ActiveVersionId ? 'active' : 'latest'} version.`,
        };
      }
    }
    // Platform/feature-delivered flows expose no content through ANY API —
    // return the FlowDefinitionView descriptor instead of a dead not-found.
    const views = pickAllByNamespace(
      await rest.query<Record<string, unknown> & { NamespacePrefix: string | null }>(
        `SELECT ApiName, Label, ProcessType, TriggerType, IsActive, NamespacePrefix, ` +
          `Description, ActiveVersionId FROM FlowDefinitionView WHERE ApiName = '${escaped}'`,
        10,
      ),
      ns,
    );
    if (views[0]) {
      return {
        body: JSON.stringify(stripAttributes(views[0]), null, 2),
        source: 'flow_definition_view',
        note:
          'This flow is platform/feature-delivered: Salesforce does not expose its definition ' +
          'content through the Metadata or Tooling APIs. This descriptor (identity, type, ' +
          'active status) is everything the platform makes available.',
      };
    }
    throw new ContrailError(
      `Flow ${name} not found in the snapshot, the Tooling API, or FlowDefinitionView. Check ` +
        `the name with list_metadata (live=true unions all sources) or run refresh_snapshot.`,
      'artifact_not_found',
    );
  }

  const child = Object.hasOwn(CHILD_SPEC, type) ? CHILD_SPEC[type] : undefined;
  if (child) {
    const [parentName, childName] = splitChildName(type, name);
    const parentArtifact = db.getArtifact(conn.id, child.parentType, parentName);
    const parentXml = parentArtifact?.filePath
      ? store.readCurrentFile(conn.id, parentArtifact.filePath)
      : null;
    if (!parentXml) {
      throw new ContrailError(
        `${child.parentType} ${parentName} is not in the local snapshot — run refresh_snapshot.`,
        'artifact_not_found',
      );
    }
    const block = findChildBlock(parentXml, child.tag, childName);
    if (!block) {
      throw new ContrailError(
        `${type} ${name} not found inside ${child.parentType} ${parentName} in the snapshot.`,
        'artifact_not_found',
      );
    }
    return { body: block, source: 'snapshot' };
  }

  const body = readSnapshotArtifact(deps, conn, type, name);
  if (!body) {
    throw new ContrailError(
      `${type} ${name} is not in the local snapshot — run refresh_snapshot (or check the name ` +
        `with list_metadata / search_metadata).`,
      'artifact_not_found',
    );
  }
  return { body, source: 'snapshot' };
}

function readSnapshotArtifact(
  deps: Pick<EngineDeps, 'db' | 'store'>,
  conn: ConnectionRecord,
  type: string,
  name: string,
): string | null {
  const artifact = deps.db.getArtifact(conn.id, type, name);
  if (!artifact?.filePath) return null;
  return deps.store.readCurrentFile(conn.id, artifact.filePath);
}

/**
 * Snapshot-only artifact read (no live fallbacks) — the deterministic source
 * the diff tools compare. Children resolve to their XML fragment.
 */
export function readArtifactFromSnapshot(
  deps: Pick<EngineDeps, 'db' | 'store'>,
  conn: ConnectionRecord,
  type: string,
  name: string,
): string | null {
  const child = Object.hasOwn(CHILD_SPEC, type) ? CHILD_SPEC[type] : undefined;
  if (child) {
    const [parentName, childName] = splitChildName(type, name);
    const parentXml = readSnapshotArtifact(deps, conn, child.parentType, parentName);
    if (!parentXml) return null;
    return findChildBlock(parentXml, child.tag, childName);
  }
  return readSnapshotArtifact(deps, conn, type, name);
}

/**
 * Split a namespace-qualified API name at the FIRST double underscore.
 * Namespaces themselves may contain single underscores (e.g. sales_channel),
 * but no valid API name contains consecutive underscores except as the
 * namespace separator (custom suffixes like __c never apply to Apex/Flow names).
 */
export function splitNamespace(name: string): { ns: string | null; short: string } {
  const idx = name.indexOf('__');
  if (idx <= 0) return { ns: null, short: name };
  return { ns: name.slice(0, idx), short: name.slice(idx + 2) };
}

/**
 * Resolve namespace intent against query rows: a qualified name demands its
 * exact namespace; a bare name prefers the local (null-namespace) row but
 * accepts a single unambiguous namespaced match (the ledger's
 * get_existing_swarm case, where the platform owns the namespace).
 */
export function pickByNamespace<T extends { NamespacePrefix: string | null }>(
  rows: T[],
  ns: string | null,
): T | undefined {
  const exact = rows.find((r) => (r.NamespacePrefix ?? null) === ns);
  if (exact) return exact;
  if (ns === null && rows.length === 1) return rows[0];
  return undefined;
}

export function pickAllByNamespace<T extends { NamespacePrefix: string | null }>(
  rows: T[],
  ns: string | null,
): T[] {
  const picked = pickByNamespace(rows, ns);
  return picked ? [picked] : [];
}

export function splitChildName(type: string, name: string): [string, string] {
  if (type === 'CustomLabel') return ['CustomLabels', name];
  const idx = name.indexOf('.');
  if (idx === -1) {
    throw new ContrailError(
      `${type} names are dotted (Parent.Child), got "${name}".`,
      'bad_artifact_name',
    );
  }
  return [name.slice(0, idx), name.slice(idx + 1)];
}

export function truncateContent(body: string): string {
  if (body.length <= MAX_CONTENT_PER_ARTIFACT) return body;
  return `${body.slice(0, MAX_CONTENT_PER_ARTIFACT)}\n… [truncated ${
    body.length - MAX_CONTENT_PER_ARTIFACT
  } of ${body.length} chars]`;
}
