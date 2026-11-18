import type { SnapshotStatusView } from '@contrail/shared';

/**
 * S46 (C): the snapshot identity a Diff result was computed against — the
 * same pair main's org-diff cache key uses (services/metadata.ts diffScope):
 * the newest index time AND the row count. A member-scoped re-read moves
 * the time; a removal-only one (a destructive deploy of a class, a flow or a
 * whole object) moves no timestamp but moves the count — either way an open
 * diff that still lists the old content is marked historical. Never
 * syncedAt: a re-baseline after a deploy changes content without moving it.
 */
export function snapshotBasis(s: SnapshotStatusView | undefined | null): string | null {
  return s ? `${s.lastIndexedAt ?? ''}|${s.artifactCount}` : null;
}
