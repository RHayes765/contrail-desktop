import {
  findChildBlock,
  parseFlowGraph,
  parsePermissionSet,
  queryDependencies,
  semanticDiff,
  type EngineDeps,
} from '@contrail/engine';
import type {
  ArtifactDetailView,
  ArtifactDiffView,
  ArtifactRowView,
  DiffEntryView,
  DiffScopeView,
  MetadataTypeCountView,
} from '@contrail/shared';
import type { DiffPair, DiffPairResult } from '../workers/snapshotWorker.js';
import type { SnapshotWorkerBridge } from './snapshots.js';

/**
 * Local-first metadata browsing + cross-org scope diffs. Everything here
 * reads the LOCAL index and snapshot tree — browsing an org costs zero API
 * calls (that's the point of the snapshot). Content that isn't on disk says
 * so instead of silently fetching.
 */

const LIST_LIMIT_DEFAULT = 200;
const DEP_LIMIT = 50;
const DIFF_ENTRY_CAP = 2000;

/**
 * Child artifacts live INSIDE their parent's file (Account.MyField__c is a
 * block of Account.object). The scope diff works at PARENT granularity —
 * one changed object is one entry, however many of its fields moved — so
 * child types never emit entries in any bucket; their parent represents
 * them. (The S7 drill-in shows field-level detail from the parent's
 * semantic diff.) Requesting a child type expands to its parent.
 */
const CHILD_TO_PARENT: Record<string, string> = {
  CustomField: 'CustomObject',
  ValidationRule: 'CustomObject',
  CustomLabel: 'CustomLabels',
};

/** Child type → its XML block tag inside the parent file (indexer's naming). */
const CHILD_BLOCK_TAGS: Record<string, string> = {
  CustomField: 'fields',
  ValidationRule: 'validationRules',
  CustomLabel: 'labels',
};

export class MetadataService {
  constructor(private readonly deps: EngineDeps) {}

  types(connectionId: string): MetadataTypeCountView[] {
    this.mustResolve(connectionId);
    const counts = this.deps.db.countArtifactsByType(connectionId);
    return Object.entries(counts).map(([type, count]) => ({ type, count }));
  }

  list(connectionId: string, type: string, query?: string, limit?: number): ArtifactRowView[] {
    this.mustResolve(connectionId);
    const cap = limit ?? LIST_LIMIT_DEFAULT;
    const needle = query?.toLowerCase();
    const rows: ArtifactRowView[] = [];
    for (const a of this.deps.db.listArtifacts(connectionId, type)) {
      if (needle && !a.apiName.toLowerCase().includes(needle)) continue;
      rows.push({
        type: a.type,
        apiName: a.apiName,
        lastModifiedDate: a.lastModifiedDate,
        lastModifiedBy: a.lastModifiedBy,
      });
      if (rows.length >= cap) break;
    }
    return rows;
  }

  artifact(connectionId: string, type: string, apiName: string): ArtifactDetailView {
    this.mustResolve(connectionId);
    const rec = this.deps.db.getArtifact(connectionId, type, apiName);
    if (!rec) throw new Error(`${type} ${apiName} is not in this org's snapshot index.`);

    let content = rec.filePath
      ? this.deps.store.readCurrentFile(connectionId, rec.filePath)
      : null;
    // Children share the parent's file — show the child's OWN block, not the
    // whole object file masquerading as a field.
    const childTag = CHILD_BLOCK_TAGS[rec.type];
    if (content && childTag) {
      const shortName = rec.apiName.includes('.')
        ? (rec.apiName.split('.').pop() ?? rec.apiName)
        : rec.apiName;
      content = findChildBlock(content, childTag, shortName) ?? content;
    }

    // Graph edges are "Type:Name" keys; the root's outgoing edges are its
    // uses, incoming are its used-by. Edges store SOURCE casing (Flow refs,
    // regex-extracted names), so classification must be case-insensitive —
    // strict equality silently drops real edges.
    const rootKey = `${rec.type}:${rec.apiName}`.toLowerCase();
    const graph = queryDependencies(this.deps.db, connectionId, type, rec.apiName, 'both', 1);
    const uses: ArtifactDetailView['uses'] = [];
    const usedBy: ArtifactDetailView['usedBy'] = [];
    let usesTruncated = false;
    let usedByTruncated = false;
    const parseKey = (key: string): { type: string; name: string } => {
      const idx = key.indexOf(':');
      return idx > 0
        ? { type: key.slice(0, idx), name: key.slice(idx + 1) }
        : { type: 'Unknown', name: key };
    };
    for (const edge of graph.edges) {
      if (edge.from.toLowerCase() === rootKey) {
        if (uses.length < DEP_LIMIT) uses.push(parseKey(edge.to));
        else usesTruncated = true;
      } else if (edge.to.toLowerCase() === rootKey) {
        if (usedBy.length < DEP_LIMIT) usedBy.push(parseKey(edge.from));
        else usedByTruncated = true;
      }
    }

    return {
      type: rec.type,
      apiName: rec.apiName,
      content,
      lastModifiedDate: rec.lastModifiedDate,
      lastModifiedBy: rec.lastModifiedBy,
      uses: dedupeRefs(uses),
      usedBy: dedupeRefs(usedBy),
      usesTruncated,
      usedByTruncated,
      permissionSet:
        rec.type === 'PermissionSet' && content ? parsePermissionSet(content) : null,
      flowGraph: rec.type === 'Flow' && content ? parseFlowGraph(content) : null,
    };
  }

  private mustResolve(connectionId: string): void {
    if (!this.deps.db.resolveConnection(connectionId)) {
      throw new Error(`Connection ${connectionId} not found.`);
    }
  }
}

function dedupeRefs(refs: Array<{ type: string; name: string }>): Array<{ type: string; name: string }> {
  const seen = new Set<string>();
  return refs.filter((r) => {
    const key = `${r.type}:${r.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── cross-org scope diff ─────────────────────────────────────────────────

interface DiffCacheEntry {
  key: string;
  view: DiffScopeView;
}

const DIFF_CONTENT_CAP = 100_000;

export class DiffService {
  private cache: DiffCacheEntry | null = null;

  constructor(
    private readonly deps: EngineDeps,
    private readonly worker: SnapshotWorkerBridge,
    private readonly metadata: MetadataService,
  ) {}

  /**
   * Per-artifact drill-in: both sides' content (child-block aware) + the
   * full semantic diff. One artifact is milliseconds — no worker needed.
   */
  diffArtifact(
    connectionA: string,
    connectionB: string,
    type: string,
    apiName: string,
  ): ArtifactDiffView {
    const a = this.deps.db.resolveConnection(connectionA);
    const b = this.deps.db.resolveConnection(connectionB);
    if (!a || !b) throw new Error('Both connections must exist.');

    // Presence comes from the INDEX — "only in X" is an org-absence claim a
    // consultant may act on, and a locked/deleted snapshot file must never
    // fabricate it. Unreadable content gets its own flags instead.
    const recA = this.deps.db.getArtifact(a.id, type, apiName);
    const recB = this.deps.db.getArtifact(b.id, type, apiName);
    if (!recA && !recB) {
      throw new Error(`${type} ${apiName} is not in either org's snapshot index.`);
    }
    const readSide = (connId: string, present: boolean): string | null => {
      if (!present) return null;
      try {
        return this.metadata.artifact(connId, type, apiName).content;
      } catch {
        return null; // indexed but unreadable — flagged below, never "absent"
      }
    };
    const contentA = readSide(a.id, recA != null);
    const contentB = readSide(b.id, recB != null);
    const unreadableA = recA != null && contentA == null;
    const unreadableB = recB != null && contentB == null;

    const cap = (text: string | null): string | null =>
      text && text.length > DIFF_CONTENT_CAP
        ? text.slice(0, DIFF_CONTENT_CAP) + '\n[truncated]'
        : text;

    const base: ArtifactDiffView = {
      type,
      apiName,
      aliasA: a.alias,
      aliasB: b.alias,
      presence: recA && recB ? 'both' : recA ? 'a-only' : 'b-only',
      unreadableA,
      unreadableB,
      identical: false,
      format: null,
      changes: null,
      changesTruncated: false,
      hunks: null,
      hunksTruncated: false,
      countsOnly: false,
      linesAdded: 0,
      linesRemoved: 0,
      contentA: cap(contentA),
      contentB: cap(contentB),
    };
    if (contentA == null || contentB == null) return base;

    const diff = semanticDiff(contentA, contentB);
    return {
      ...base,
      identical: diff.identical,
      format: diff.format,
      changes: diff.xml?.changes ?? null,
      changesTruncated: diff.xml?.truncated ?? false,
      hunks: diff.text?.hunks ?? null,
      hunksTruncated: diff.text?.hunks_truncated ?? false,
      countsOnly: diff.text?.counts_only ?? false,
      linesAdded: diff.text?.lines_added ?? 0,
      linesRemoved: diff.text?.lines_removed ?? 0,
    };
  }

  async diffScope(
    connectionA: string,
    connectionB: string,
    types?: string[],
  ): Promise<DiffScopeView> {
    const a = this.deps.db.resolveConnection(connectionA);
    const b = this.deps.db.resolveConnection(connectionB);
    if (!a || !b) throw new Error('Both connections must exist.');
    if (a.id === b.id) throw new Error('Pick two different connections to diff.');

    // Cache key: both orgs' newest indexed timestamps AND row counts — a
    // delete-only re-sync moves no timestamp, but it moves the count.
    const statusA = this.deps.db.getSnapshotStatus(a.id);
    const statusB = this.deps.db.getSnapshotStatus(b.id);
    if (statusA.artifactCount === 0 || statusB.artifactCount === 0) {
      throw new Error('Both orgs need a metadata sync before they can be diffed.');
    }
    const typeKey = [...(types ?? [])].sort().join(',');
    const key =
      `${a.id}|${b.id}|${typeKey}|${statusA.lastIndexedAt}|${statusA.artifactCount}` +
      `|${statusB.lastIndexedAt}|${statusB.artifactCount}`;
    if (this.cache?.key === key) {
      return { ...this.cache.view, cached: true };
    }

    // A child-only filter would silently exclude the parent whose file
    // carries the changes — requesting a child type pulls its parent in.
    let typeFilter: Set<string> | null = null;
    if (types && types.length > 0) {
      typeFilter = new Set(types);
      for (const t of types) {
        const parent = Object.hasOwn(CHILD_TO_PARENT, t) ? CHILD_TO_PARENT[t] : undefined;
        if (parent) typeFilter.add(parent);
      }
    }

    // Coverage guard: a type present in one snapshot and absent from the
    // other is NON-COVERAGE, not mass deletion — omit its entries and say so.
    const countsA = this.deps.db.countArtifactsByType(a.id);
    const countsB = this.deps.db.countArtifactsByType(b.id);
    const uncoveredTypes: DiffScopeView['uncoveredTypes'] = [];
    const uncovered = new Set<string>();
    for (const type of new Set([...Object.keys(countsA), ...Object.keys(countsB)])) {
      if (typeFilter && !typeFilter.has(type)) continue;
      if (Object.hasOwn(CHILD_TO_PARENT, type)) continue; // parents represent children
      const na = countsA[type] ?? 0;
      const nb = countsB[type] ?? 0;
      if (na > 0 && nb === 0) {
        uncovered.add(type);
        uncoveredTypes.push({ type, missingIn: 'B', countInOther: na });
      } else if (nb > 0 && na === 0) {
        uncovered.add(type);
        uncoveredTypes.push({ type, missingIn: 'A', countInOther: nb });
      }
    }

    const skip = (type: string): boolean =>
      (typeFilter != null && !typeFilter.has(type)) ||
      Object.hasOwn(CHILD_TO_PARENT, type) ||
      uncovered.has(type);

    const inA = new Map<string, { apiName: string; type: string; hash: string | null; path: string | null }>();
    for (const art of this.deps.db.listArtifacts(a.id)) {
      if (skip(art.type)) continue;
      inA.set(`${art.type}:${art.apiName.toLowerCase()}`, {
        apiName: art.apiName,
        type: art.type,
        hash: art.contentHash,
        path: art.filePath,
      });
    }

    const entries: DiffEntryView[] = [];
    let unchanged = 0;
    const pairs: DiffPair[] = [];
    const seenInB = new Set<string>();

    for (const art of this.deps.db.listArtifacts(b.id)) {
      if (skip(art.type)) continue;
      const k = `${art.type}:${art.apiName.toLowerCase()}`;
      seenInB.add(k);
      const other = inA.get(k);
      if (!other) {
        entries.push({
          type: art.type,
          apiName: art.apiName,
          status: 'added',
          changeCount: 0,
          unreadable: false,
        });
        continue;
      }
      // Hash prefilter: equal content hashes = unchanged, no file reads.
      if (other.hash != null && art.contentHash != null && other.hash === art.contentHash) {
        unchanged += 1;
        continue;
      }
      if (other.path && art.filePath) {
        pairs.push({
          type: art.type,
          apiName: other.apiName,
          connectionIdA: a.id,
          connectionIdB: b.id,
          filePathA: other.path,
          filePathB: art.filePath,
        });
      } else {
        entries.push({
          type: art.type,
          apiName: other.apiName,
          status: 'changed',
          changeCount: 0,
          unreadable: true,
        });
      }
    }
    for (const [k, art] of inA) {
      if (!seenInB.has(k)) {
        entries.push({
          type: art.type,
          apiName: art.apiName,
          status: 'removed',
          changeCount: 0,
          unreadable: false,
        });
      }
    }

    // The semantic pass (worker): only hash-differing pairs get parsed.
    // Chunked so no single work unit can monopolize the worker lane or
    // outlive the per-call timeout on huge scopes.
    const CHUNK = 500;
    const results: DiffPairResult[] = [];
    for (let i = 0; i < pairs.length; i += CHUNK) {
      results.push(...(await this.worker.diffPairs(pairs.slice(i, i + CHUNK))));
    }
    for (const r of results) {
      if (r.identical) {
        // Hash differs but content semantically identical (whitespace,
        // element order) — the exact noise the semantic diff exists to kill.
        unchanged += 1;
        continue;
      }
      entries.push({
        type: r.type,
        apiName: r.apiName,
        status: 'changed',
        changeCount: r.changeCount,
        unreadable: r.unreadable,
      });
    }

    const totals = {
      added: entries.filter((e) => e.status === 'added').length,
      removed: entries.filter((e) => e.status === 'removed').length,
      changed: entries.filter((e) => e.status === 'changed').length,
      unchanged,
    };
    entries.sort((x, y) => x.type.localeCompare(y.type) || x.apiName.localeCompare(y.apiName));
    const truncated = entries.length > DIFF_ENTRY_CAP;

    const view: DiffScopeView = {
      connectionA: a.id,
      connectionB: b.id,
      aliasA: a.alias,
      aliasB: b.alias,
      computedAt: new Date().toISOString(),
      cached: false,
      totals,
      entries: truncated ? entries.slice(0, DIFF_ENTRY_CAP) : entries,
      truncated,
      uncoveredTypes,
    };
    this.cache = { key, view };
    return view;
  }
}
