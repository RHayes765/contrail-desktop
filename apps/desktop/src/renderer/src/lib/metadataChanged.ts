import type { PushEvents } from '@contrail/shared';

/**
 * S46 (C): whether a member-scoped re-read (refresh_snapshot members, or the
 * re-baseline after a deploy) changed the component open in the Metadata
 * screen — it names that component, or it re-wrote the document that
 * component is: a FlowDefinition member re-reads its Flow, a CustomField
 * member its whole CustomObject, and a run that skipped every member can
 * still have written such a document. Names compare case-insensitively.
 * Pure — no React — so the rule is testable without a renderer.
 */
export function changeTouchesArtifact(
  open: { type: string; apiName: string },
  change: Pick<PushEvents['metadata:changed'], 'members' | 'units'>,
): boolean {
  const name = open.apiName.toLowerCase();
  const unit = `${open.type}:${open.apiName}`.toLowerCase();
  return (
    change.members.some(
      (m) =>
        (m.type === open.type && m.apiName.toLowerCase() === name) ||
        (m.unit !== null && m.unit.toLowerCase() === unit),
    ) || change.units.some((u) => u.toLowerCase() === unit)
  );
}
