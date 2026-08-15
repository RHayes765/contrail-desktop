import type { EngineDeps } from '@contrail/engine';
import { readApiKey } from './agentRuntime.js';
import type { DiffService, MetadataService } from './metadata.js';

/**
 * One-shot artifact summaries. The content is LOCAL (snapshot) and no tools
 * are needed, so this is a single direct Messages-API call on Haiku — no
 * agent session, no runtime process, ~a tenth of a cent. Cached by content
 * hash: re-summarize only when the artifact actually changed.
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

const DIFF_SYSTEM_PROMPT =
  'You are a Salesforce metadata expert comparing two orgs\' versions of the same ' +
  'artifact for a consultant. Explain what CHANGED between version A and version B and ' +
  'what the change means operationally: behavior differences, records/fields newly ' +
  'touched or no longer touched, new callouts, and any risk the change introduces. ' +
  'Lead with one sentence naming the essential difference, then tight bullets. If the ' +
  'versions are equivalent in behavior despite textual differences, say so plainly. ' +
  'No preamble.';
const DIFF_CONTENT_CHARS = 14_000;
const DIFF_MAX_CHANGES = 100;

export class SummaryService {
  private readonly cache = new Map<string, string>();

  constructor(
    private readonly deps: EngineDeps,
    private readonly metadata: MetadataService,
    private readonly diff?: DiffService,
  ) {}

  /**
   * Diff-aware summary: explains the DIFFERENCE between two orgs' versions.
   * One-sided artifacts fall back to a single-version summary framed as
   * "exists only in X". Cached by the content-hash pair.
   */
  async summarizeDiff(
    connectionA: string,
    connectionB: string,
    type: 'ApexClass' | 'ApexTrigger' | 'Flow' | 'ValidationRule',
    apiName: string,
  ): Promise<{ summary: string; cached: boolean }> {
    if (!this.diff) throw new Error('diff summaries are not wired in this mode');
    const a = this.deps.db.resolveConnection(connectionA);
    const b = this.deps.db.resolveConnection(connectionB);
    if (!a || !b) throw new Error('Both connections must exist.');
    const hashA = this.deps.db.getArtifact(a.id, type, apiName)?.contentHash ?? 'absent';
    const hashB = this.deps.db.getArtifact(b.id, type, apiName)?.contentHash ?? 'absent';
    const cacheKey = `diff:${type}:${apiName}:${hashA}:${hashB}`;
    const hit = this.cache.get(cacheKey);
    if (hit) return { summary: hit, cached: true };

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
    this.cache.set(cacheKey, summary);
    return { summary, cached: false };
  }

  async summarize(
    connectionId: string,
    type: 'ApexClass' | 'ApexTrigger' | 'Flow' | 'ValidationRule',
    apiName: string,
  ): Promise<{ summary: string; cached: boolean }> {
    const rec = this.deps.db.getArtifact(connectionId, type, apiName);
    if (!rec) throw new Error(`${type} ${apiName} is not in this org's snapshot index.`);
    const cacheKey = `${type}:${apiName}:${rec.contentHash ?? 'nohash'}`;
    const hit = this.cache.get(cacheKey);
    if (hit) return { summary: hit, cached: true };

    // artifact() already handles child-block extraction (validation rules).
    const detail = this.metadata.artifact(connectionId, type, apiName);
    if (!detail.content) {
      throw new Error('No source on disk to summarize — sync this org first.');
    }
    const summary = await this.callModel(
      SYSTEM_PROMPT,
      `${type} "${detail.apiName}"` +
        (detail.lastModifiedDate ? ` (last modified ${detail.lastModifiedDate})` : '') +
        `:\n\n\`\`\`\n${detail.content.slice(0, MAX_CONTENT_CHARS)}\n\`\`\``,
    );
    this.cache.set(cacheKey, summary);
    return { summary, cached: false };
  }

  private async callModel(system: string, userContent: string): Promise<string> {
    const apiKey = readApiKey();
    if (!apiKey) throw new Error('No Anthropic API key found — add one before summarizing.');
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
    return summary;
  }
}
