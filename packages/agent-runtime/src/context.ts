import type { SessionContext } from './types.js';
import { grantedList, notGrantedList } from '@contrail/engine';

/**
 * Prompt-cache-stable system context (spec §4). Layout discipline:
 * everything here is stable for the LIFETIME OF THE SESSION — no clocks, no
 * staleness data, no per-turn state. Volatile facts reach the model through
 * tools, never through this prompt, so the prefix stays byte-identical and
 * cache hits accrue across every turn.
 */

const PREAMBLE = `You are Contrail, an AI harness built for Salesforce work, operating inside the Contrail desktop app for a Salesforce professional.

House rules — these are the operating contract, not etiquette:
1. Never guess an org. Every tool call names its target connection explicitly by alias. If the user's request is ambiguous about which org, ask.
2. Grants are facts, not obstacles. The grants matrix below says what each connection allows. If something needed is not granted, say so — the human changes grants in the app's Connections screen, never through you.
3. Every write requires explicit human approval — deploys and data changes alike, in every environment including sandboxes. Propose and validate rather than asking permission conversationally; the approval flow will engage the human at the right moment. Summarize destructive changes prominently, before anything else.
4. You see only this project's connections, documents, and notes. Other projects' data does not exist to you.
5. Diagnostics output (debug logs, flow errors) may contain client record data — treat it as client-confidential.`;

export function buildSystemPrompt(ctx: SessionContext): string {
  const parts: string[] = [PREAMBLE];

  parts.push(
    `# Project: ${ctx.project.name}` +
      (ctx.project.description ? `\n${ctx.project.description}` : ''),
  );

  if (ctx.project.instructions) {
    parts.push(`# Project instructions\n${ctx.project.instructions}`);
  }

  // Names + descriptions only — bodies load on demand through read_skill.
  // The list arrives sorted from main; nothing volatile may appear here.
  if (ctx.skills && ctx.skills.length > 0) {
    const lines = ctx.skills.map((s) => `- ${s.name} — ${s.description}`);
    parts.push(
      `# Skills\nLoad a skill with read_skill BEFORE relying on its domain:\n${lines.join('\n')}`,
    );
  }

  const rows = ctx.bindings.map((b) => {
    const granted = grantedList(b.grants).join(', ') || 'none';
    const denied = notGrantedList(b.grants).join(', ') || 'none';
    return `- ${b.alias} (${b.orgName ?? 'unnamed'}) — ${b.orgType}, role: ${b.envRole}\n  granted: ${granted}\n  NOT granted: ${denied}`;
  });
  parts.push(`# Connected orgs and grants\n${rows.join('\n')}`);

  return parts.join('\n\n');
}
