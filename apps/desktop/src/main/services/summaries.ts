import type { EngineDeps } from '@contrail/engine';
import { readApiKey } from './agentRuntime.js';
import type { MetadataService } from './metadata.js';

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

export class SummaryService {
  private readonly cache = new Map<string, string>();

  constructor(
    private readonly deps: EngineDeps,
    private readonly metadata: MetadataService,
  ) {}

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
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content:
              `${type} "${detail.apiName}"` +
              (detail.lastModifiedDate ? ` (last modified ${detail.lastModifiedDate})` : '') +
              `:\n\n\`\`\`\n${detail.content.slice(0, MAX_CONTENT_CHARS)}\n\`\`\``,
          },
        ],
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
    this.cache.set(cacheKey, summary);
    return { summary, cached: false };
  }
}
