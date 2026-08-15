import type { ContrailDb } from '../core/db.js';
import type { AuditLog } from '../core/audit.js';
import type { ContrailConfig } from '../core/config.js';
import type { ConnectionRecord } from '../core/types.js';
import type { AccessTokenManager } from '../salesforce/tokens.js';
import { MetadataSoapClient, type FileProperties } from '../salesforce/metadataSoap.js';
import { RestClient } from '../salesforce/rest.js';
import { SnapshotStore } from './store.js';
import { buildKnownArtifacts } from '../deps/extract.js';
import { fetchOrgDependencyEdges } from '../deps/orgdeps.js';
import { inlineSnapshotWork, withChildTypes, type SnapshotWorkUnits } from './work.js';
import { ContrailError } from '../core/errors.js';
import { log } from '../core/log.js';

/**
 * The snapshot pipeline: listMetadata → retrieve → unzip → index → extract
 * references. Runs as a per-connection background job with a short inline
 * wait, mirroring the connect_org pattern, so MCP client timeouts never bite
 * on large orgs.
 */

export interface RefreshSummary {
  connection: string;
  types: string[];
  artifact_counts: Record<string, number>;
  edge_counts: { extractor: number; org: number };
  warnings: string[];
  duration_ms: number;
}

export interface RefreshJobState {
  /** Identity of THIS run — observers poll by it so completions are never misattributed. */
  jobId: string;
  types: string[];
  startedAt: string;
  progress: string;
  done: boolean;
  result?: RefreshSummary;
  error?: string;
}

interface RefreshJob extends RefreshJobState {
  promise: Promise<RefreshSummary>;
}

export interface RefreshOptions {
  /**
   * How long to wait inline before returning in_progress. Defaults to
   * config.snapshot.toolWaitMs (the MCP-friendly value); pollers that push
   * progress elsewhere pass 0 for an immediate observation.
   */
  waitMs?: number;
  /**
   * Never collect a leftover finished job: if the previous job is done, it is
   * discarded and a NEW refresh starts. A running job is still attached to
   * (never duplicated). UI-initiated syncs use this so "Sync" always syncs.
   */
  fresh?: boolean;
  /**
   * Observe a specific run. If that job is no longer present (another
   * observer collected it), returns { status: 'gone' } instead of silently
   * starting a duplicate retrieve.
   */
  observeJobId?: string;
}

const SNAPSHOT_LOCK_TTL_MS = 15 * 60 * 1000;

export class SnapshotEngine {
  private readonly jobs = new Map<string, RefreshJob>();
  private readonly work: SnapshotWorkUnits;
  private readonly lockHolder = `engine:${process.pid}`;

  constructor(
    private readonly db: ContrailDb,
    private readonly store: SnapshotStore,
    private readonly tokenMgr: AccessTokenManager,
    private readonly config: ContrailConfig,
    private readonly audit: AuditLog,
    /** CPU-work seam — hosts may run unzip/index/extract off their main thread. */
    work?: SnapshotWorkUnits,
  ) {
    this.work = work ?? inlineSnapshotWork(store);
  }

  /**
   * Start (or observe) a refresh. Returns within ~waitMs either the finished
   * summary or an in-progress state the caller reports back.
   *
   * One refresh at a time per connection is enforced HERE via the shared
   * database's app_locks lease — every engine host (the desktop UI's sync,
   * a desktop agent's refresh_snapshot, future surfaces) passes this same
   * gate. NOTE: the frozen v5 plugin predates app_locks and cannot
   * participate; this serializes engine-v6+ hosts only.
   */
  async refresh(
    conn: ConnectionRecord,
    types?: string[],
    options?: RefreshOptions,
  ): Promise<
    | { status: 'complete'; summary: RefreshSummary }
    | { status: 'failed'; error: string }
    | { status: 'in_progress'; state: RefreshJobState }
    | { status: 'locked'; holder: string }
    | { status: 'gone' }
  > {
    const waitMs = options?.waitMs ?? this.config.snapshot.toolWaitMs;
    let job = this.jobs.get(conn.id);

    if (options?.observeJobId) {
      if (!job || job.jobId !== options.observeJobId) {
        // The observed run was collected by someone else (or never existed);
        // an observer must never accidentally start a duplicate retrieve.
        return { status: 'gone' };
      }
    } else if (job?.done) {
      if (options?.fresh) {
        // A leftover finished job is stale history to a fresh sync — discard.
        this.jobs.delete(conn.id);
        job = undefined;
      } else {
        this.jobs.delete(conn.id);
        // A finished job whose result was never collected is delivered now.
        if (job.result) return { status: 'complete', summary: job.result };
        if (job.error) return { status: 'failed', error: job.error };
        job = undefined;
      }
    }

    if (!job) {
      const lockName = `snapshot:${conn.id}`;
      if (!this.db.acquireAppLock(lockName, this.lockHolder, SNAPSHOT_LOCK_TTL_MS)) {
        return { status: 'locked', holder: 'another Contrail process' };
      }
      job = this.startJob(conn, types ?? this.config.snapshot.types);
      this.jobs.set(conn.id, job);
    }

    const winner = await Promise.race([
      job.promise.then(
        (summary) => ({ status: 'complete' as const, summary }),
        (err) => ({ status: 'failed' as const, error: String(err instanceof Error ? err.message : err) }),
      ),
      delay(waitMs).then(() => null),
    ]);
    if (winner) {
      // Deliver exactly once: only the observer that wins removes the job.
      if (this.jobs.get(conn.id)?.jobId === job.jobId) this.jobs.delete(conn.id);
      return winner;
    }
    return { status: 'in_progress', state: publicState(job) };
  }

  private startJob(conn: ConnectionRecord, types: string[]): RefreshJob {
    const job: RefreshJob = {
      jobId: `${conn.id}:${Date.now()}:${Math.floor(Math.random() * 1e6)}`,
      types,
      startedAt: new Date().toISOString(),
      progress: 'starting',
      done: false,
      promise: undefined as unknown as Promise<RefreshSummary>,
    };
    const lockName = `snapshot:${conn.id}`;
    job.promise = this.runRefresh(conn, types, job)
      .then((summary) => {
        job.done = true;
        job.result = summary;
        return summary;
      })
      .catch((err) => {
        job.done = true;
        job.error = String(err instanceof Error ? err.message : err);
        this.audit.record('snapshot.refresh_failed', {
          connectionId: conn.id,
          tool: 'refresh_snapshot',
          outcome: 'error',
          detail: { error: job.error },
        });
        throw err;
      })
      .finally(() => {
        this.db.releaseAppLock(lockName, this.lockHolder);
      });
    // Prevent unhandled rejection when nobody is awaiting after soft-return.
    job.promise.catch(() => {});
    return job;
  }

  private async runRefresh(
    conn: ConnectionRecord,
    types: string[],
    job: RefreshJob,
  ): Promise<RefreshSummary> {
    const started = Date.now();
    const warnings: string[] = [];
    const soap = new MetadataSoapClient(this.tokenMgr, conn, this.config.salesforce.apiVersion);
    const rest = new RestClient(this.tokenMgr, conn, this.config.salesforce.apiVersion);

    job.progress = 'listing metadata';
    let listedProps: FileProperties[] = [];
    try {
      listedProps = await soap.listMetadata(types);
    } catch (err) {
      warnings.push(`listMetadata failed (${String(err instanceof Error ? err.message : err)}); staleness data will be limited`);
    }

    job.progress = 'starting retrieve';
    const retrieveId = await soap.retrieve(buildRetrieveMembers(types, listedProps, warnings));

    const deadline = Date.now() + this.config.snapshot.retrieveTimeoutMs;
    let status = await soap.checkRetrieveStatus(retrieveId, true);
    let poll = 0;
    while (!status.done) {
      if (Date.now() > deadline) {
        throw new ContrailError(
          `retrieve did not complete within ${Math.round(
            this.config.snapshot.retrieveTimeoutMs / 60000,
          )} minutes (status: ${status.status})`,
          'retrieve_timeout',
        );
      }
      poll += 1;
      job.progress = `retrieving (poll ${poll}, status ${status.status})`;
      // Long retrieves must outlive the lease TTL — renew it every poll, and
      // say so loudly if someone took the lock over (expired lease + takeover).
      if (!this.db.acquireAppLock(`snapshot:${conn.id}`, this.lockHolder, SNAPSHOT_LOCK_TTL_MS)) {
        log('warn', 'snapshot lock was taken over mid-refresh; continuing (last writer wins)', {
          connection: conn.alias,
        });
      }
      await delay(this.config.snapshot.pollIntervalMs);
      status = await soap.checkRetrieveStatus(retrieveId, true);
    }
    if (!status.success || !status.zipFile) {
      throw new ContrailError(
        `retrieve failed: ${status.errorMessage ?? status.status}`,
        'retrieve_failed',
      );
    }

    job.progress = 'extracting snapshot';
    const retrievedAt = new Date().toISOString();
    this.store.saveZip(conn.id, status.zipFile, retrievedAt);
    const affectedTypes = withChildTypes(types);
    const fullManifest = this.config.snapshot.types.every((t) => types.includes(t));

    job.progress = 'indexing artifacts';
    const fileProps = mergeProps(status.fileProperties, listedProps);
    // Unzip/filter/write/index runs behind the work seam (possibly in a
    // worker process); every DB write below stays HERE — single writer.
    const { artifacts } = await this.work.extractAndIndex({
      connectionId: conn.id,
      zip: status.zipFile,
      types,
      fullManifest,
      fileProps,
      retrievedAt,
    });
    this.db.replaceArtifactsForTypes(
      conn.id,
      affectedTypes,
      artifacts.map((a) => ({ ...a, connectionId: conn.id })),
    );

    job.progress = 'extracting references';
    // Known-artifact maps span the whole index (post-replace) so a partial
    // refresh still resolves cross-type references from untouched types.
    const known = buildKnownArtifacts(this.db.listArtifacts(conn.id));
    const extractorEdges = await this.work.extractEdges({
      connectionId: conn.id,
      artifacts,
      known,
    });
    this.db.replaceEdges(conn.id, 'extractor', affectedTypes, extractorEdges);

    job.progress = 'querying org dependency data';
    const orgDeps = await fetchOrgDependencyEdges(rest, conn.id, types);
    warnings.push(...orgDeps.warnings);
    this.db.replaceEdges(conn.id, 'org', types, orgDeps.edges);

    const summary: RefreshSummary = {
      connection: conn.alias,
      types,
      artifact_counts: countByType(artifacts),
      edge_counts: { extractor: extractorEdges.length, org: orgDeps.edges.length },
      warnings,
      duration_ms: Date.now() - started,
    };
    this.audit.record('snapshot.refreshed', {
      connectionId: conn.id,
      tool: 'refresh_snapshot',
      outcome: 'success',
      detail: {
        types,
        artifacts: artifacts.length,
        edges: extractorEdges.length + orgDeps.edges.length,
        duration_ms: summary.duration_ms,
      },
    });
    log('info', 'snapshot refreshed', { connection: conn.alias, artifacts: artifacts.length });
    return summary;
  }

  /** Compare org-side lastModifiedDate against the index (on-demand staleness check, spec §4). */
  async checkStaleness(
    conn: ConnectionRecord,
    types?: string[],
  ): Promise<{
    checked_types: string[];
    stale: Array<{ type: string; api_name: string; org_modified: string; index_modified: string | null }>;
    missing_from_index: number;
    note: string;
  }> {
    const checkTypes = types ?? this.config.snapshot.types;
    const soap = new MetadataSoapClient(this.tokenMgr, conn, this.config.salesforce.apiVersion);
    const props = await soap.listMetadata(checkTypes);
    const stale: Array<{
      type: string;
      api_name: string;
      org_modified: string;
      index_modified: string | null;
    }> = [];
    let missing = 0;
    for (const p of props) {
      // Managed-package components are excluded from wildcard retrieves by
      // the platform; counting them as "missing" would be permanent noise.
      if (isManaged(p)) continue;
      const artifact = this.db.getArtifact(conn.id, p.type, p.fullName);
      if (!artifact) {
        missing += 1;
        continue;
      }
      if (
        p.lastModifiedDate &&
        (!artifact.lastModifiedDate ||
          new Date(p.lastModifiedDate).getTime() >
            new Date(artifact.lastModifiedDate).getTime())
      ) {
        stale.push({
          type: p.type,
          api_name: p.fullName,
          org_modified: p.lastModifiedDate,
          index_modified: artifact.lastModifiedDate,
        });
      }
    }
    return {
      checked_types: checkTypes,
      stale: stale.slice(0, 100),
      missing_from_index: missing,
      note:
        stale.length || missing
          ? 'Run refresh_snapshot to bring the local snapshot up to date.'
          : 'Snapshot is current for the checked types.',
    };
  }
}

/**
 * Build the retrieve package members. The package.xml wildcard only matches
 * CUSTOM objects — standard objects (which carry most real-world custom
 * fields) must be named explicitly, so CustomObject members are expanded
 * from the listMetadata inventory when available.
 */
function buildRetrieveMembers(
  types: string[],
  listedProps: FileProperties[],
  warnings: string[],
): Record<string, string[]> {
  const members: Record<string, string[]> = Object.fromEntries(types.map((t) => [t, ['*']]));
  if (types.includes('CustomObject')) {
    const objectNames = listedProps
      .filter((p) => p.type === 'CustomObject' && !isManaged(p))
      .map((p) => p.fullName);
    if (objectNames.length > 0) {
      members.CustomObject = objectNames;
      if (objectNames.length > 1000) {
        warnings.push(
          `CustomObject inventory is large (${objectNames.length}); the retrieve may be slow or hit platform size limits.`,
        );
      }
    } else {
      warnings.push(
        'listMetadata returned no CustomObject inventory; falling back to the * wildcard, which misses standard objects.',
      );
    }
  }
  return members;
}

function isManaged(p: FileProperties): boolean {
  return p.manageableState === 'installed' || p.manageableState === 'released'
    ? p.namespacePrefix !== undefined && p.namespacePrefix !== ''
    : false;
}

function mergeProps(primary: FileProperties[], secondary: FileProperties[]): FileProperties[] {
  const seen = new Set(primary.map((p) => `${p.type}:${p.fullName.toLowerCase()}`));
  return [
    ...primary,
    ...secondary.filter((p) => !seen.has(`${p.type}:${p.fullName.toLowerCase()}`)),
  ];
}

function countByType(artifacts: Array<{ type: string }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const a of artifacts) counts[a.type] = (counts[a.type] ?? 0) + 1;
  return counts;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

function publicState(job: RefreshJob): RefreshJobState {
  return {
    jobId: job.jobId,
    types: job.types,
    startedAt: job.startedAt,
    progress: job.progress,
    done: job.done,
    result: job.result,
    error: job.error,
  };
}
