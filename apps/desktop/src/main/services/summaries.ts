import type { EngineDeps } from '@contrail/engine';
import type { SavedSummaryView } from '@contrail/shared';
import { readApiKey } from './agentRuntime.js';
import type { BudgetService } from './budget.js';
import type { DiffService, MetadataService } from './metadata.js';
import { artifactHash, readSavedSummary } from './savedSummary.js';

/**
 * One-shot artifact summaries. The content is LOCAL (snapshot) and no tools
 * are needed, so this is a single direct Messages-API call on Haiku — no
 * agent session, no runtime process, ~a tenth of a cent.
 *
 * Summaries are SAVED, not cached: one row per thing summarized, kept across
 * restarts, and shown again when the artifact is reopened. A stored summary is
 * returned even when the artifact has since changed — flagged `stale` rather
 * than quietly regenerated, so the user decides whether a refresh is worth the
 * money.
 */

const SUMMARY_MODEL = 'claude-haiku-4-5';
const MAX_CONTENT_CHARS = 28_000;
const MAX_TOKENS = 700;

const SYSTEM_PROMPT =
  'You are a Salesforce metadata expert writing for a consultant who needs to understand ' +
  'an artifact fast. Summarize what it does: entry/trigger conditions, the main logic ' +
  'branches, which records it reads or writes, external callouts, and anything risky, ' +
  'hardcoded, or unusual worth flagging. Short markdown — a sentence of purpose, then ' +
  'tight bullets. No preamble, no restating the raw XML.';

const CHANGE_SYSTEM_PROMPT =
  'You are a Salesforce metadata expert explaining ONE executed change for a project ' +
  'change log. You are given the artifact before and after (either side may be absent ' +
  'for adds/deletes) plus the recorded change metadata. Explain what the artifact does ' +
  'and exactly what this change did to it: behavior added/removed/altered, ' +
  'records/fields newly touched, and any risk the change carried. Lead with one ' +
  'sentence naming the change; then tight bullets. No preamble.';

const DIFF_SYSTEM_PROMPT =
  'You are a Salesforce metadata expert comparing two orgs\' versions of the same ' +
  'artifact for a consultant. Explain what CHANGED between version A and version B and ' +
  'what the change means operationally: behavior differences, records/fields newly ' +
  'touched or no longer touched, new callouts, and any risk the change introduces. ' +
  'Lead with one sentence naming the essential difference, then tight bullets. If the ' +
  'versions are equivalent in behavior despite textual differences, say so plainly. ' +
  'No preamble.';
/** Haiku 4.5 list pricing (USD per million tokens) — used to price summaries
 * for the spend ledger. Approximate by design: the alternative was counting
 * them as free. */
const HAIKU_INPUT_USD_PER_MTOK = 1;
const HAIKU_OUTPUT_USD_PER_MTOK = 5;
const DIFF_CONTENT_CHARS = 14_000;
const DIFF_MAX_CHANGES = 100;

export class SummaryService {
  constructor(
    private readonly deps: EngineDeps,
    private readonly metadata: MetadataService,
    private readonly diff?: DiffService,
    /** Spend guard. Summaries are real money and must be counted. */
    private readonly budget?: BudgetService,
  ) {}

  /**
   * Diff-aware summary: explains the DIFFERENCE between two orgs' versions.
   * One-sided artifacts fall back to a single-version summary framed as
   * "exists only in X". Saved per org pair; either side changing makes it stale.
   */
  async summarizeDiff(
    connectionA: string,
    connectionB: string,
    type: 'ApexClass' | 'ApexTrigger' | 'Flow' | 'ValidationRule',
    apiName: string,
    refresh = false,
  ): Promise<SavedSummaryView & { cached: boolean }> {
    if (!this.diff) throw new Error('diff summaries are not wired in this mode');
    const a = this.deps.db.resolveConnection(connectionA);
    const b = this.deps.db.resolveConnection(connectionB);
    if (!a || !b) throw new Error('Both connections must exist.');
    const key = {
      kind: 'diff' as const,
      connectionId: a.id,
      connectionBId: b.id,
      type,
      apiName,
    };
    const hashA = artifactHash(this.deps, a.id, type, apiName);
    const hashB = artifactHash(this.deps, b.id, type, apiName);
    if (!refresh) {
      const saved = readSavedSummary(this.deps, key, hashA, hashB);
      if (saved) return { ...saved, cached: true };
    }

    const view = this.diff.diffArtifact(a.id, b.id, type, apiName);
    if (view.unreadableA || view.unreadableB) {
      throw new Error('A snapshot file is unreadable — re-sync before summarizing.');
    }

    let userContent: string;
    if (view.presence !== 'both') {
      const alias = view.presence === 'a-only' ? view.aliasA : view.aliasB;
      const content = view.contentA ?? view.contentB ?? '';
      userContent =
        `${type} "${apiName}" exists ONLY in org "${alias}" (absent from the other org). ` +
        `Summarize what it does and what its absence from the other org implies:\n\n` +
        `\`\`\`\n${content.slice(0, MAX_CONTENT_CHARS)}\n\`\`\``;
    } else {
      const changesNote = view.changes
        ? `\n\nStructural changes (A→B), pre-computed:\n${JSON.stringify(view.changes.slice(0, DIFF_MAX_CHANGES))}`
        : '';
      userContent =
        `${type} "${apiName}" — version A is from org "${view.aliasA}", version B from org "${view.aliasB}".\n\n` +
        `VERSION A:\n\`\`\`\n${(view.contentA ?? '').slice(0, DIFF_CONTENT_CHARS)}\n\`\`\`\n\n` +
        `VERSION B:\n\`\`\`\n${(view.contentB ?? '').slice(0, DIFF_CONTENT_CHARS)}\n\`\`\`` +
        changesNote;
    }

    const summary = await this.callModel(
      view.presence === 'both' ? DIFF_SYSTEM_PROMPT : SYSTEM_PROMPT,
      userContent,
    );
    return this.save(key, summary, hashA, hashB);
  }

  async summarize(
    connectionId: string,
    type: 'ApexClass' | 'ApexTrigger' | 'Flow' | 'ValidationRule',
    apiName: string,
    refresh = false,
  ): Promise<SavedSummaryView & { cached: boolean }> {
    // Resolve first: rows are keyed by connection id, so calling this with an
    // alias must not create a second summary for the same artifact.
    const conn = this.deps.db.resolveConnection(connectionId);
    if (!conn) throw new Error(`Connection ${connectionId} not found.`);
    const rec = this.deps.db.getArtifact(conn.id, type, apiName);
    if (!rec) throw new Error(`${type} ${apiName} is not in this org's snapshot index.`);
    const key = { kind: 'artifact' as const, connectionId: conn.id, type, apiName };
    if (!refresh) {
      const saved = readSavedSummary(this.deps, key, rec.contentHash);
      if (saved) return { ...saved, cached: true };
    }

    // artifact() already handles child-block extraction (validation rules).
    const detail = this.metadata.artifact(conn.id, type, apiName);
    if (!detail.content) {
      throw new Error('No source on disk to summarize — sync this org first.');
    }
    const summary = await this.callModel(
      SYSTEM_PROMPT,
      `${type} "${detail.apiName}"` +
        (detail.lastModifiedDate ? ` (last modified ${detail.lastModifiedDate})` : '') +
        `:\n\n\`\`\`\n${detail.content.slice(0, MAX_CONTENT_CHARS)}\n\`\`\``,
    );
    return this.save(key, summary, rec.contentHash);
  }

  /**
   * S28 manifest: summarize one EXECUTED change from captured before/after
   * content. Purely content-based — no snapshot-index lookup, no type union,
   * no artifact_summaries row (its UNIQUE key admits one summary per
   * artifact; per-change summaries live on the manifest entry, persisted by
   * the caller). Budget-gated and ledgered exactly like every other summary.
   */
  async summarizeChange(input: {
    title: string;
    before: string | null;
    after: string | null;
    changeMeta?: Record<string, unknown>;
  }): Promise<{ summary: string; model: string }> {
    if (!input.before && !input.after) {
      throw new Error('No captured content on this entry — nothing to summarize.');
    }
    const metaNote = input.changeMeta
      ? `\n\nRecorded change metadata:\n${JSON.stringify(input.changeMeta).slice(0, 2000)}`
      : '';
    const beforeBlock = input.before
      ? `BEFORE:\n\`\`\`\n${input.before.slice(0, DIFF_CONTENT_CHARS)}\n\`\`\``
      : 'BEFORE: (did not exist — this change created it)';
    const afterBlock = input.after
      ? `AFTER:\n\`\`\`\n${input.after.slice(0, DIFF_CONTENT_CHARS)}\n\`\`\``
      : 'AFTER: (deleted by this change)';
    const summary = await this.callModel(
      CHANGE_SYSTEM_PROMPT,
      `${input.title}\n\n${beforeBlock}\n\n${afterBlock}${metaNote}`,
    );
    return { summary, model: SUMMARY_MODEL };
  }

  /**
   * Persist a freshly generated summary alongside the hashes it describes, and
   * hand it back as the view. Fresh output is never stale by definition.
   */
  private save(
    key: {
      kind: 'artifact' | 'diff';
      connectionId: string;
      connectionBId?: string;
      type: string;
      apiName: string;
    },
    summary: string,
    contentHash: string | null,
    contentHashB: string | null = null,
  ): SavedSummaryView & { cached: boolean } {
    this.deps.db.putSavedSummary({
      kind: key.kind,
      connectionId: key.connectionId,
      connectionBId: key.connectionBId ?? '',
      type: key.type,
      apiName: key.apiName,
      contentHash,
      contentHashB,
      summary,
      model: SUMMARY_MODEL,
    });
    // Read back rather than re-deriving the timestamp: whatever the row says
    // is what the UI will show on the next load.
    const saved = readSavedSummary(this.deps, key, contentHash, contentHashB);
    return {
      summary,
      createdAt: saved?.createdAt ?? new Date().toISOString(),
      model: SUMMARY_MODEL,
      stale: false,
      cached: false,
    };
  }

  private async callModel(system: string, userContent: string): Promise<string> {
    const apiKey = readApiKey();
    if (!apiKey) {
      throw new Error(
        'No Anthropic API key found — add one in Settings before summarizing.',
      );
    }
    // Summaries used to bypass budgeting entirely. They are billed work on the
    // user's key, so they answer to the same daily ceiling as agent turns.
    this.budget?.assertCanSpend('this summary');
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: SUMMARY_MODEL,
        max_tokens: MAX_TOKENS,
        system,
        messages: [{ role: 'user', content: userContent }],
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Summary request failed (${response.status}): ${body.slice(0, 200)}`);
    }
    const data = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const summary = (data.content ?? [])
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text)
      .join('')
      .trim();
    if (!summary) throw new Error('The model returned an empty summary.');
    // Price the call from reported usage and put it in the ledger. Haiku
    // pricing, per million tokens; wrong-but-close beats uncounted.
    const usage = (data as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
    const inTok = usage?.input_tokens ?? 0;
    const outTok = usage?.output_tokens ?? 0;
    const costUsd = (inTok / 1_000_000) * HAIKU_INPUT_USD_PER_MTOK +
      (outTok / 1_000_000) * HAIKU_OUTPUT_USD_PER_MTOK;
    this.budget?.record('summary', SUMMARY_MODEL, costUsd);
    return summary;
  }
}
