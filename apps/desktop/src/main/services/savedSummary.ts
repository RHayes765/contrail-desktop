import type { EngineDeps } from '@contrail/engine';
import type { SavedSummaryView } from '@contrail/shared';

/**
 * Reading saved summaries and judging whether they are still true.
 *
 * Summaries are addressed by WHAT they describe (org + type + api name), not
 * by the content hash they were generated from. Hash-as-identity was the old
 * design and it hid the interesting case: a changed artifact simply missed the
 * cache and got silently re-billed, so the user never learned the explanation
 * they were reading had gone out of date. Here the hash is stored as data, and
 * comparing it to the artifact's current hash is what produces `stale`.
 */

export interface SavedSummaryKey {
  kind: 'artifact' | 'diff';
  connectionId: string;
  /** '' (or omitted) for a single artifact; org B's id for a diff. */
  connectionBId?: string;
  type: string;
  apiName: string;
}

/**
 * The artifact's current hash for staleness purposes. A missing index row is
 * a real, comparable state ('absent') rather than unknown: an artifact that
 * was deleted since the summary was written HAS changed.
 */
export function artifactHash(
  deps: EngineDeps,
  connectionId: string,
  type: string,
  apiName: string,
): string | null {
  const rec = deps.db.getArtifact(connectionId, type, apiName);
  if (!rec) return 'absent';
  return rec.contentHash;
}

/**
 * Unknown is not evidence of change. If either hash is missing we cannot
 * compare, and flagging "outdated" on a missing hash would cry wolf on every
 * artifact type the indexer does not hash.
 */
function changed(then: string | null, now: string | null): boolean {
  if (then === null || now === null) return false;
  return then !== now;
}

/** Load a saved summary (if any) and decide whether it still describes current content. */
export function readSavedSummary(
  deps: EngineDeps,
  key: SavedSummaryKey,
  currentHash: string | null,
  currentHashB?: string | null,
): SavedSummaryView | null {
  const rec = deps.db.getSavedSummary(key);
  if (!rec) return null;
  const stale =
    changed(rec.contentHash, currentHash) ||
    (key.kind === 'diff' && changed(rec.contentHashB, currentHashB ?? null));
  return {
    summary: rec.summary,
    createdAt: rec.createdAt,
    model: rec.model,
    stale,
  };
}
