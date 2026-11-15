import type { ManifestEntryDetailView } from '@contrail/shared';

/**
 * Which "before" a Manifest entry's what-changed diff used, and how the tab
 * names it. Pure — no React — so the wording is testable without a renderer.
 *
 * S45: a captured entry records `baseline` in its detail — 'live_preimage'
 * (what the org held when the deploy was validated, from its revert
 * package) or 'snapshot' (the local snapshot). Entries captured before S45
 * carry none; they used the snapshot. The approval's live-org warnings ride
 * the entry too, so a snapshot diff must never sit under them unlabelled.
 */

export type ManifestBaseline = 'live_preimage' | 'snapshot';

export function manifestBaseline(
  detail: Pick<ManifestEntryDetailView, 'detail'>,
): ManifestBaseline {
  return detail.detail?.baseline === 'live_preimage' ? 'live_preimage' : 'snapshot';
}

/** The approval found the org's live copy different from the local snapshot. */
export function liveCopyDiffered(warnings: string[]): boolean {
  return warnings.some(
    (w) => w.startsWith('EXISTS IN TARGET') || w.startsWith('CHANGED IN TARGET'),
  );
}

export function whatChangedHeading(baseline: ManifestBaseline): string {
  return baseline === 'live_preimage'
    ? 'What changed (vs the live org at validate)'
    : 'What changed (vs your local snapshot — not the live org)';
}

/** The line for a diff whose two sides are identical. */
export function identicalLine(baseline: ManifestBaseline, warnings: string[]): string {
  return baseline === 'snapshot' && liveCopyDiffered(warnings)
    ? "Identical to your local snapshot; the org's live copy differed (see the warning above) " +
        'and is not shown here.'
    : 'The deployed content was byte-identical to the previous version.';
}

/**
 * The line for an entry with no "before" at all whose approval said the
 * live copy differed (the local snapshot held no copy to diff against);
 * null otherwise — then nothing is shown, as before.
 */
export function noDiffLine(
  baseline: ManifestBaseline,
  warnings: string[],
  hasBefore: boolean,
): string | null {
  return !hasBefore && baseline === 'snapshot' && liveCopyDiffered(warnings)
    ? "The org's live copy (see the warning above) is not shown here, and your local snapshot " +
        'held no copy to diff against.'
    : null;
}
