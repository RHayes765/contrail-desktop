import type { ConnectionPolicyView, PoliciesView } from '@contrail/shared';

/**
 * S46 (B): the SF Orgs screen's policy wording — what the policies in the
 * human's config.json (or Contrail's built-in rule) require of a connection
 * right now. Read-only: nothing in the app edits the policies. Pure — no
 * React — so the wording is testable without a renderer.
 */

/**
 * What each deny rule refuses, in the words of the engine's own policy
 * lines. denyDataDeletes covers the DML and bulk-load proposals only — the
 * engine does not inspect anonymous Apex for deletes — so its label says so.
 */
const DENY_LABEL: Record<ConnectionPolicyView['denies'][number], string> = {
  destructive_metadata: 'destructive metadata changes denied',
  data_deletes: 'data deletes via dml_propose / bulk_load_propose denied (anonymous Apex not inspected)',
  anonymous_apex: 'anonymous Apex denied',
};

/** Where the rules came from — the approval page's two headings, shortened. */
export function policySourceLabel(source: PoliciesView['source']): string {
  return source === 'default'
    ? "Contrail's built-in default — config.json has no policies section"
    : 'from config.json';
}

/**
 * One connection's requirements, in the order list_connections reports
 * them. Empty when no rule applies.
 */
export function policyRequirementLabels(p: ConnectionPolicyView): string[] {
  const out: string[] = [];
  if (p.requiresJustification) out.push('justification required');
  if (p.requiresTicket) out.push('ticket required');
  for (const pattern of p.ticketPatterns) out.push(`ticket must match ${pattern}`);
  for (const d of p.denies) out.push(DENY_LABEL[d]);
  if (p.minTestLevel) out.push(`deploys need test_level ${p.minTestLevel} or stricter`);
  for (const w of p.freezeWindows) out.push(`freeze window "${w.name}": ${w.when} ${w.timeZone}`);
  return out;
}

/** The card's one policy line, or null when no rule applies to the connection. */
export function policyLine(p: ConnectionPolicyView): string | null {
  if (p.rules.length === 0) return null;
  const rules = p.rules.map((r) => `"${r}"`).join(', ');
  const reqs = policyRequirementLabels(p);
  return `Policy ${rules}${reqs.length ? ` — ${reqs.join(' · ')}` : ''}`;
}

/** A change freeze in effect on this connection now, or null. */
export function freezeNowLabel(p: ConnectionPolicyView): string | null {
  return p.freezeNow
    ? `CHANGE FREEZE in effect ("${p.freezeNow.window}", rule "${p.freezeNow.rule}") until ` +
        p.freezeNow.until
    : null;
}

/** The screen-level notice when config.json's policies could not be read. */
export function policiesUnreadableText(problem: string): string {
  return (
    'The policies in config.json could not be read, so every write proposal and every agent ' +
    `test-run start is refused until the file is fixed: ${problem}`
  );
}
