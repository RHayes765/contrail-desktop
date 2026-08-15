import { utilityProcess, type UtilityProcess } from 'electron';
import {
  log,
  type DependencyEdge,
  type EdgeExtractionInput,
  type EngineDeps,
  type ExtractIndexInput,
  type ExtractIndexResult,
  type SnapshotWorkUnits,
} from '@contrail/engine';
import type { PushChannel, PushEvents, SnapshotStatusView } from '@contrail/shared';

/**
 * Snapshot orchestration for the desktop:
 *   - the CPU work seam backed by a utilityProcess worker (UI never blocks);
 *   - a cross-process app lock so the desktop and the plugin never run the
 *     same connection's sync concurrently against the shared DB;
 *   - progress pushed to the renderer by polling the engine's job state;
 *   - auto-baseline on fresh connects.
 * All SQLite writes happen in MAIN (inside SnapshotEngine) — the worker only
 * touches the snapshot file tree.
 */

const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const POLL_MS = 1200;
const WORK_TIMEOUT_MS = 5 * 60 * 1000;

type PushFn = <C extends PushChannel>(channel: C, payload: PushEvents[C]) => void;

// ── the worker-backed SnapshotWorkUnits ──────────────────────────────────

interface PendingWork {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Lazy singleton bridge to the snapshot worker process. Restarts the worker
 * on exit; in-flight calls fail fast and the caller surfaces the error.
 */
export class SnapshotWorkerBridge implements SnapshotWorkUnits {
  private worker: UtilityProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingWork>();

  constructor(private readonly workerPath: string) {}

  private ensureWorker(): UtilityProcess {
    if (this.worker) return this.worker;
    const worker = utilityProcess.fork(this.workerPath, [], { stdio: 'pipe' });
    // Piped stdio MUST be drained: an undrained pipe wedges the worker after
    // ~55KB of output (engine debug logging mid-extract is enough). Forward
    // stderr so the engine's log lines stay visible for troubleshooting.
    worker.stdout?.on('data', () => undefined);
    worker.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
    });
    worker.on('message', (msg: { id: number; ok: boolean; result?: unknown; error?: string }) => {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.ok) entry.resolve(msg.result);
      else entry.reject(new Error(msg.error ?? 'snapshot worker failed'));
    });
    worker.on('exit', (code) => {
      this.worker = null;
      for (const [id, entry] of this.pending) {
        this.pending.delete(id);
        clearTimeout(entry.timer);
        entry.reject(new Error(`snapshot worker exited (code ${code}) mid-task`));
      }
    });
    this.worker = worker;
    return worker;
  }

  private call<T>(kind: 'extractAndIndex' | 'extractEdges', input: unknown): Promise<T> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // Kill the wedged worker: (a) the next call gets a fresh process
        // instead of queueing behind the stuck job forever, (b) the 'exit'
        // handler fails other queued calls fast, and (c) the abandoned job
        // can never zombie-write the snapshot tree minutes later.
        const wedged = this.worker;
        this.worker = null;
        wedged?.kill();
        reject(new Error(`snapshot worker timed out on ${kind}`));
      }, WORK_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      worker.postMessage({ kind, id, input });
    });
  }

  extractAndIndex(input: ExtractIndexInput): Promise<ExtractIndexResult> {
    return this.call('extractAndIndex', input);
  }

  extractEdges(input: EdgeExtractionInput): Promise<DependencyEdge[]> {
    return this.call('extractEdges', input);
  }

  shutdown(): void {
    this.worker?.kill();
    this.worker = null;
  }
}

// ── the service ──────────────────────────────────────────────────────────

interface ActiveSync {
  progress: string;
  startedAt: number;
}

export class SnapshotService {
  private readonly active = new Map<string, ActiveSync>();

  constructor(
    private readonly deps: EngineDeps,
    private readonly push: PushFn,
  ) {}

  status(connectionId: string): SnapshotStatusView {
    const s = this.deps.db.getSnapshotStatus(connectionId);
    const activeSync = this.active.get(connectionId);
    const stale =
      s.lastIndexedAt != null && Date.now() - new Date(s.lastIndexedAt).getTime() > STALE_AFTER_MS;
    return {
      connectionId,
      artifactCount: s.artifactCount,
      edgeCount: s.edgeCount,
      lastIndexedAt: s.lastIndexedAt,
      syncing: activeSync != null,
      progress: activeSync?.progress ?? null,
      stale,
    };
  }

  /** Fresh connects get a baseline automatically — but never a re-sync storm. */
  maybeAutoBaseline(connectionId: string): void {
    try {
      const s = this.deps.db.getSnapshotStatus(connectionId);
      if (s.artifactCount > 0) return; // plugin or an earlier run already synced it
      const result = this.sync(connectionId, 'baseline');
      if (result.status !== 'started') {
        log('info', 'auto-baseline skipped', { connectionId, reason: result.status });
      }
    } catch (err) {
      // A baseline failure must never break the connect flow that fired it.
      log('warn', 'auto-baseline failed to start', { connectionId, err: String(err) });
    }
  }

  sync(
    connectionId: string,
    kind: 'baseline' | 'refresh' = 'refresh',
  ): { status: 'started' | 'already_syncing' | 'locked' } {
    const conn = this.deps.db.resolveConnection(connectionId);
    if (!conn) throw new Error(`Connection ${connectionId} not found.`);
    // Everything keys on the RESOLVED id — a caller passing an alias must
    // not slip past the reentrancy guard.
    if (this.active.has(conn.id)) return { status: 'already_syncing' };

    this.active.set(conn.id, { progress: 'starting', startedAt: Date.now() });

    void this.runSync(conn.id, kind).catch((err) => {
      // runSync handles its own failures; this guards the guard.
      log('error', 'snapshot sync escaped its error handling', { err: String(err) });
      this.active.delete(conn.id);
    });
    return { status: 'started' };
  }

  private async runSync(connectionId: string, kind: 'baseline' | 'refresh'): Promise<void> {
    try {
      const conn = this.deps.db.resolveConnection(connectionId);
      if (!conn) throw new Error('connection removed mid-sync');

      // Start (or attach to) the job. fresh:true means "Sync" NEVER collects
      // an hours-old finished job as if it just ran; waitMs 0 keeps every
      // observation non-blocking so progress flows at POLL_MS, not toolWaitMs.
      const first = await this.deps.engine.refresh(conn, undefined, { fresh: true, waitMs: 0 });
      if (first.status === 'locked') {
        this.emit(connectionId, 'locked', true, 'Another Contrail process is syncing this org.');
        return;
      }
      if (first.status === 'complete' || first.status === 'failed') {
        this.settle(connectionId, kind, first);
        return;
      }
      if (first.status !== 'in_progress') {
        this.emit(connectionId, 'failed', true, `unexpected refresh state: ${first.status}`);
        return;
      }
      const jobId = first.state.jobId;
      this.emit(connectionId, first.state.progress, false, null);

      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        const result = await this.deps.engine.refresh(conn, undefined, {
          observeJobId: jobId,
          waitMs: 0,
        });
        if (result.status === 'gone') {
          // Another observer (an agent's refresh_snapshot poll) collected the
          // completion. The work happened; report from the database.
          const s = this.deps.db.getSnapshotStatus(connectionId);
          this.emit(connectionId, `synced ${s.artifactCount} artifacts`, true, null);
          return;
        }
        if (result.status === 'complete' || result.status === 'failed') {
          this.settle(connectionId, kind, result);
          return;
        }
        if (result.status === 'in_progress') {
          const progress = result.state.progress;
          const entry = this.active.get(connectionId);
          if (entry && entry.progress !== progress) {
            entry.progress = progress;
            this.emit(connectionId, progress, false, null);
          }
        }
      }
    } catch (err) {
      this.emit(connectionId, 'failed', true, String(err).slice(0, 500));
    } finally {
      this.active.delete(connectionId);
    }
  }

  private settle(
    connectionId: string,
    kind: 'baseline' | 'refresh',
    result:
      | { status: 'complete'; summary: { types: string[]; artifact_counts: Record<string, number> } }
      | { status: 'failed'; error: string },
  ): void {
    if (result.status === 'failed') {
      this.emit(connectionId, 'failed', true, result.error);
      return;
    }
    const artifactCount = Object.values(result.summary.artifact_counts).reduce((a, b) => a + b, 0);
    this.deps.db.insertMetadataSnapshot({
      connectionId,
      kind,
      types: result.summary.types,
      artifactCount,
    });
    this.emit(connectionId, `synced ${artifactCount} artifacts`, true, null);
  }

  private emit(connectionId: string, progress: string, done: boolean, error: string | null): void {
    this.push('metadata:progress', { connectionId, progress, done, error });
  }
}
