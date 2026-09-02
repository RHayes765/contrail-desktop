import fs from 'node:fs';
import { unzipSync } from 'fflate';
import {
  deployZipEntryPath,
  findChildBlock,
  parseFlowGraph,
  parsePermissionSet,
  semanticDiff,
  type EngineDeps,
  type DeployRequestRecord,
  type ManifestEntryRecord,
} from '@contrail/engine';
import type {
  ArtifactDetailView,
  ManifestEntryDetailView,
  ManifestEntryView,
  ProjectManifestView,
  PushChannel,
  PushEvents,
  SavedSummaryView,
} from '@contrail/shared';
import type { MetadataService } from './metadata.js';
import type { SummaryService } from './summaries.js';

/**
 * The project manifest (S28): what a project's sessions changed through the
 * ritual. Rows are captured by the engine's execution observer at the ONE
 * moment both truths coexist on disk — the pre-deploy snapshot (before) and
 * the frozen payload about to be deleted (after) — and backfilled without
 * content for history that predates the feature.
 *
 * Capture is deliberately SYNCHRONOUS and self-isolating: a refresh_snapshot
 * racing an async capture could rewrite `current/` under us, and nothing here
 * may ever fail or delay a deploy result (the engine additionally swallows
 * observer throws).
 *
 * ATTRIBUTION CAVEAT (inherited, pre-existing): request.session_id is stamped
 * via the per-connection expectation slot in deploys.ts — two live sessions
 * proposing on the same connection inside the same window can mis-attribute
 * a row, and the manifest reports whatever the row says.
 */

type PushFn = <C extends PushChannel>(channel: C, payload: PushEvents[C]) => void;

/** Per-side content cap — a captured flow is big; a pathological one is not a DB row. */
const CONTENT_CAP = 400_000;

interface ComponentChange {
  type: string;
  api_name: string;
  change: 'add' | 'modify' | 'unchanged_content' | 'delete';
  warnings?: string[];
  source_path?: string;
  source_sha256?: string;
}

export class ManifestService {
  constructor(
    private readonly deps: EngineDeps,
    private readonly push: PushFn,
    private readonly metadata: MetadataService,
    private readonly summaries?: SummaryService,
  ) {}

  // ── capture (execution observer) ───────────────────────────────────────

  capture(info: {
    request: DeployRequestRecord;
    payload: Record<string, unknown>;
    payloadPath: string | null;
  }): void {
    try {
      const projectId = this.projectFor(info.request);
      if (!projectId) return; // plugin rows / non-session executions — not project work
      const rows = this.synthesizeRows(info.request, projectId, {
        executedAt: new Date().toISOString(),
        payloadPath: info.payloadPath,
        captureContent: true,
      });
      if (rows.length === 0) return;
      this.deps.db.insertManifestEntries(rows);
      this.push('manifest:changed', { projectId });
    } catch (err) {
      // Belt to the engine's suspenders: capture must never surface.
      this.deps.audit.record('deploy.observer_failed', {
        connectionId: info.request.connectionId,
        tool: 'manifest_capture',
        outcome: 'error',
        detail: { requestId: info.request.id, error: String(err).slice(0, 500) },
      });
    }
  }

  /**
   * Boot-time backfill: executed, session-attributed requests with no
   * manifest rows yet — an idempotent anti-join, so a partial failure or a
   * second boot never duplicates. Backfilled rows carry NO content (the
   * frozen payloads are long gone); the viewer falls back to the current
   * snapshot version, labeled as such.
   */
  ensureBackfill(): void {
    let backfilled = 0;
    for (const rec of this.deps.db.listExecutedRequestsWithoutManifest()) {
      try {
        const projectId = this.projectFor(rec);
        if (!projectId) continue;
        const rows = this.synthesizeRows(rec, projectId, {
          executedAt: rec.executedAt ?? rec.createdAt,
          payloadPath: null, // historic payloads were unlinked at execution
          // The current snapshot is NOT the pre-change state for a historic
          // deploy — recording it as "before" would lie. Backfilled metadata
          // rows are deliberately content-less; the viewer falls back to the
          // current version, labeled as such.
          captureContent: false,
        });
        if (rows.length > 0) {
          this.deps.db.insertManifestEntries(rows);
          backfilled += rows.length;
        }
      } catch {
        // One unparseable historic row must not sink the sweep.
      }
    }
    if (backfilled > 0) this.push('manifest:changed', { projectId: '' });
  }

  private projectFor(request: DeployRequestRecord): string | null {
    if (!request.sessionId) return null;
    return this.deps.db.getAgentSession(request.sessionId)?.projectId ?? null;
  }

  // ── row synthesis (capture and backfill share it) ──────────────────────

  private synthesizeRows(
    request: DeployRequestRecord,
    projectId: string,
    opts: { executedAt: string; payloadPath: string | null; captureContent: boolean },
  ): Array<Omit<ManifestEntryRecord, 'id' | 'summary' | 'summaryModel' | 'summaryCreatedAt'>> {
    const base = {
      projectId,
      sessionId: request.sessionId!,
      requestId: request.id,
      connectionId: request.connectionId,
      kind: request.kind,
      executedAt: opts.executedAt,
    };
    const summary = parseJson(request.summaryJson) as Record<string, unknown> | null;
    const payload = parseJson(request.payloadJson ?? '') as Record<string, unknown> | null;

    if (request.kind === 'deploy') {
      const changes = [
        ...((summary?.changes as ComponentChange[] | undefined) ?? []),
        ...((summary?.destructive as ComponentChange[] | undefined) ?? []),
      ].filter((c) => c && c.change !== 'unchanged_content');
      const zip = this.readZip(opts.payloadPath);
      return changes.map((c) => {
        const contents = opts.captureContent
          ? this.componentContents(request.connectionId, c, zip)
          : { before: null, after: null, truncated: false };
        return {
          ...base,
          entryKind: 'metadata' as const,
          type: c.type,
          apiName: c.api_name,
          change: c.change,
          label: null,
          detailJson: JSON.stringify({
            warnings: c.warnings ?? [],
            ...(c.source_path ? { source_path: c.source_path } : {}),
            ...(c.source_sha256 ? { source_sha256: c.source_sha256 } : {}),
          }),
          beforeContent: contents.before,
          afterContent: contents.after,
          contentTruncated: contents.truncated,
        };
      });
    }

    // Data kinds: one labeled row per request.
    if (request.kind === 'apex') {
      const lines = typeof summary?.lines === 'number' ? summary.lines : null;
      const script = typeof payload?.code === 'string' ? payload.code : null;
      return [
        {
          ...base,
          entryKind: 'data' as const,
          type: null,
          apiName: null,
          change: null,
          label: `Anonymous Apex${lines !== null ? ` (${lines} line${lines === 1 ? '' : 's'})` : ''}`,
          detailJson: JSON.stringify({ chars: summary?.chars ?? null }),
          beforeContent: null,
          afterContent: script ? cap(script).content : null,
          contentTruncated: script ? cap(script).truncated : false,
        },
      ];
    }
    if (request.kind === 'bulk') {
      const steps = typeof summary?.steps === 'number' ? summary.steps : null;
      const totalRows = typeof summary?.total_rows === 'number' ? summary.total_rows : null;
      const ops = typeof summary?.operations === 'string' ? summary.operations : null;
      const manifestSteps = Array.isArray(payload?.steps)
        ? (payload!.steps as Array<Record<string, unknown>>).map((s) => ({
            object: s.object,
            operation: s.operation,
            rows: s.row_count,
          }))
        : null;
      return [
        {
          ...base,
          entryKind: 'data' as const,
          type: null,
          apiName: null,
          change: null,
          label:
            `Bulk load — ${steps ?? '?'} step${steps === 1 ? '' : 's'}` +
            (totalRows !== null ? `, ${totalRows.toLocaleString('en-US')} rows` : '') +
            (ops ? ` (${ops})` : ''),
          detailJson: JSON.stringify({
            stop_on_failure: summary?.stop_on_failure ?? null,
            ...(manifestSteps ? { steps: manifestSteps } : {}),
          }),
          beforeContent: null,
          afterContent: null,
          contentTruncated: false,
        },
      ];
    }
    // dml — flat or plan.
    const isPlan = summary?.plan === true;
    const label = isPlan
      ? `DML plan — ${summary?.steps ?? '?'} steps` +
        (typeof summary?.operations === 'string' ? ` (${summary.operations})` : '')
      : `${String(summary?.operation ?? 'DML').toUpperCase()} ${summary?.row_count ?? '?'} row(s)` +
        (summary?.object ? ` on ${summary.object}` : '');
    return [
      {
        ...base,
        entryKind: 'data' as const,
        type: null,
        apiName: null,
        change: null,
        label,
        detailJson: JSON.stringify(
          isPlan
            ? { plan: true, steps: summary?.steps ?? null, operations: summary?.operations ?? null }
            : {
                operation: summary?.operation ?? null,
                object: summary?.object ?? null,
                rows: summary?.row_count ?? null,
              },
        ),
        beforeContent: null,
        afterContent: null,
        contentTruncated: false,
      },
    ];
  }

  private readZip(payloadPath: string | null): Record<string, Uint8Array> | null {
    if (!payloadPath) return null;
    try {
      if (!fs.existsSync(payloadPath) || !fs.statSync(payloadPath).isFile()) return null;
      return unzipSync(fs.readFileSync(payloadPath));
    } catch {
      return null; // a corrupt zip degrades to a content-less entry, never a failure
    }
  }

  /**
   * before = the pre-deploy snapshot's version (still on disk — snapshots
   * only move on refresh); after = the deployed bytes from the frozen zip.
   * Child components extract their own block from the parent document on
   * BOTH sides so the diff altitudes match.
   */
  private componentContents(
    connectionId: string,
    c: ComponentChange,
    zip: Record<string, Uint8Array> | null,
  ): { before: string | null; after: string | null; truncated: boolean } {
    const entry = deployZipEntryPath(c.type, c.api_name);
    const extract = (doc: string | null): string | null => {
      if (!doc) return null;
      if (entry?.child) return findChildBlock(doc, entry.childTag, entry.childName) ?? null;
      return doc;
    };

    let after: string | null = null;
    if (c.change !== 'delete' && zip && entry) {
      const bytes = zip[entry.path];
      if (bytes) after = extract(new TextDecoder().decode(bytes));
    }

    let before: string | null = null;
    if (c.change !== 'add') {
      try {
        const rec = this.deps.db.getArtifact(connectionId, c.type, c.api_name);
        if (rec?.filePath) {
          before = extract(this.deps.store.readCurrentFile(connectionId, rec.filePath));
        }
      } catch {
        before = null; // no snapshot coverage — the entry just has no before
      }
    }

    const b = before ? cap(before) : null;
    const a = after ? cap(after) : null;
    return {
      before: b?.content ?? null,
      after: a?.content ?? null,
      truncated: (b?.truncated ?? false) || (a?.truncated ?? false),
    };
  }

  // ── views ──────────────────────────────────────────────────────────────

  list(projectId: string): ProjectManifestView {
    const metadata: ManifestEntryView[] = [];
    const data: ManifestEntryView[] = [];
    for (const rec of this.deps.db.listManifestEntries(projectId)) {
      const view = this.entryView(rec);
      (rec.entryKind === 'metadata' ? metadata : data).push(view);
    }
    return { metadata, data };
  }

  private entryView(rec: ManifestEntryRecord): ManifestEntryView {
    const detail = parseJson(rec.detailJson ?? '') as { warnings?: unknown } | null;
    return {
      id: rec.id,
      requestId: rec.requestId,
      connectionId: rec.connectionId,
      alias: this.deps.db.resolveConnection(rec.connectionId)?.alias ?? '(removed connection)',
      kind: rec.kind,
      entryKind: rec.entryKind,
      type: rec.type,
      apiName: rec.apiName,
      change: rec.change,
      label: rec.label,
      warnings: Array.isArray(detail?.warnings) ? (detail!.warnings as string[]) : [],
      executedAt: rec.executedAt,
      hasCapturedContent: rec.beforeContent !== null || rec.afterContent !== null,
      hasSummary: rec.summary !== null,
    };
  }

  entryDetail(id: string): ManifestEntryDetailView {
    const rec = this.deps.db.getManifestEntry(id);
    if (!rec) throw new Error('Manifest entry not found.');
    const entry = this.entryView(rec);
    const detail = parseJson(rec.detailJson ?? '') as Record<string, unknown> | null;
    const savedSummary: SavedSummaryView | null = rec.summary
      ? {
          summary: rec.summary,
          createdAt: rec.summaryCreatedAt ?? rec.executedAt,
          model: rec.summaryModel,
          stale: false, // captured content is frozen — a change summary cannot go stale
        }
      : null;

    // Data rows: the anonymous-Apex script is viewable; dml/bulk are label-only.
    if (rec.entryKind === 'data') {
      const artifact =
        rec.kind === 'apex' && rec.afterContent
          ? this.syntheticArtifact('AnonymousApex', rec.label ?? 'Anonymous Apex', rec, rec.afterContent, savedSummary)
          : null;
      return {
        entry,
        artifact,
        contentSource: artifact ? 'captured' : 'none',
        beforeContent: null,
        contentTruncated: rec.contentTruncated,
        identical: null,
        format: null,
        changes: null,
        hunks: null,
        detail,
        summary: savedSummary,
      };
    }

    // Metadata rows — captured content first, current snapshot as the honest fallback.
    const displayContent = rec.afterContent ?? rec.beforeContent;
    if (displayContent !== null) {
      const artifact = this.syntheticArtifact(
        rec.type ?? 'Metadata',
        rec.apiName ?? '(unknown)',
        rec,
        displayContent,
        savedSummary,
      );
      let identical: boolean | null = null;
      let format: 'xml' | 'text' | null = null;
      let changes: ManifestEntryDetailView['changes'] = null;
      let hunks: ManifestEntryDetailView['hunks'] = null;
      if (rec.beforeContent !== null && rec.afterContent !== null) {
        const diff = semanticDiff(rec.beforeContent, rec.afterContent, {
          maxChanges: 500,
          maxHunks: 100,
        });
        identical = diff.identical;
        format = diff.format;
        changes = diff.xml?.changes ?? null;
        hunks = diff.text?.hunks ?? null;
      }
      return {
        entry,
        artifact,
        contentSource: 'captured',
        beforeContent: rec.beforeContent,
        contentTruncated: rec.contentTruncated,
        identical,
        format,
        changes,
        hunks,
        detail,
        summary: savedSummary,
      };
    }

    // Backfilled (or capture-degraded) row: show the org's CURRENT version.
    let artifact: ArtifactDetailView | null = null;
    if (rec.type && rec.apiName) {
      try {
        artifact = {
          ...this.metadata.artifact(rec.connectionId, rec.type, rec.apiName),
          savedSummary,
        };
      } catch {
        artifact = null;
      }
    }
    return {
      entry,
      artifact,
      contentSource: artifact ? 'current_snapshot' : 'none',
      beforeContent: null,
      contentTruncated: false,
      identical: null,
      format: null,
      changes: null,
      hunks: null,
      detail,
      summary: savedSummary,
    };
  }

  private syntheticArtifact(
    type: string,
    apiName: string,
    rec: ManifestEntryRecord,
    content: string,
    savedSummary: SavedSummaryView | null,
  ): ArtifactDetailView {
    return {
      type,
      apiName,
      content,
      lastModifiedDate: rec.executedAt,
      lastModifiedBy: null,
      uses: [],
      usedBy: [],
      usesTruncated: false,
      usedByTruncated: false,
      permissionSet: rec.type === 'PermissionSet' ? parsePermissionSet(content) : null,
      flowGraph: rec.type === 'Flow' ? parseFlowGraph(content) : null,
      savedSummary,
    };
  }

  // ── AI summary ─────────────────────────────────────────────────────────

  async summarize(id: string, refresh = false): Promise<SavedSummaryView & { cached: boolean }> {
    const rec = this.deps.db.getManifestEntry(id);
    if (!rec) throw new Error('Manifest entry not found.');
    if (!this.summaries) throw new Error('Summaries are not wired in this mode.');
    if (rec.summary && !refresh) {
      return {
        summary: rec.summary,
        createdAt: rec.summaryCreatedAt ?? rec.executedAt,
        model: rec.summaryModel,
        stale: false,
        cached: true,
      };
    }

    let before = rec.beforeContent;
    let after = rec.afterContent;
    let currentVersionNote = false;
    // Backfilled metadata rows have no capture — summarize the org's current
    // version and SAY so, rather than refusing or pretending.
    if (before === null && after === null && rec.entryKind === 'metadata' && rec.type && rec.apiName) {
      try {
        after = this.metadata.artifact(rec.connectionId, rec.type, rec.apiName).content;
        currentVersionNote = true;
      } catch {
        after = null;
      }
    }

    const title =
      rec.entryKind === 'metadata'
        ? `${(rec.change ?? 'change').toUpperCase()} ${rec.type} "${rec.apiName}" (executed ${rec.executedAt})`
        : `${rec.label ?? 'Data change'} (executed ${rec.executedAt})`;
    const { summary, model } = await this.summaries.summarizeChange({
      title,
      before,
      after,
      changeMeta: {
        kind: rec.kind,
        change: rec.change,
        ...(parseJson(rec.detailJson ?? '') as Record<string, unknown> | null),
        ...(currentVersionNote
          ? {
              note:
                'No captured content for this historic change — the content shown is the ' +
                "org's CURRENT version, which may include later changes.",
            }
          : {}),
      },
    });
    this.deps.db.setManifestEntrySummary(rec.id, summary, model);
    const saved = this.deps.db.getManifestEntry(rec.id);
    return {
      summary,
      createdAt: saved?.summaryCreatedAt ?? new Date().toISOString(),
      model,
      stale: false,
      cached: false,
    };
  }
}

function cap(content: string): { content: string; truncated: boolean } {
  return content.length > CONTENT_CAP
    ? { content: content.slice(0, CONTENT_CAP), truncated: true }
    : { content, truncated: false };
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
