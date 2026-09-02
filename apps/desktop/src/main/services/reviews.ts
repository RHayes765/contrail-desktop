import fs from 'node:fs';
import { resolveSourcePath, type EngineDeps } from '@contrail/engine';
import { readApiKey } from './agentRuntime.js';
import type { BudgetService } from './budget.js';
import { canonicalReviewHash, type ReviewSubject } from './reviewHash.js';

/**
 * The Ultracode adversarial reviewer (S28). Executed ENTIRELY in main as a
 * direct Messages-API call — never a subagent — so authorship is verifiable:
 * the runtime cannot fabricate a review, only request one. The review is
 * content-addressed (reviewHash.ts); the executor's gate refuses proposals
 * whose exact content has no fresh review, and the matched review rides the
 * request's review_json so the HUMAN reads the verdict and findings beside
 * the change on Deploy Review. A `fail` verdict never blocks the propose —
 * the reviewer informs, the human decides.
 */

const REVIEW_MODEL = 'claude-sonnet-5';
const MAX_TOKENS = 1500;
const MAX_CONTENT_CHARS = 24_000;
const CSV_PREVIEW_CHARS = 600;
/** Sonnet list pricing (USD per MTok) — approximate for the ledger, like summaries. */
const SONNET_INPUT_USD_PER_MTOK = 3;
const SONNET_OUTPUT_USD_PER_MTOK = 15;

const REVIEW_SYSTEM_PROMPT =
  'You are an ADVERSARIAL Salesforce change reviewer. You receive the exact content an AI ' +
  'agent is about to propose for deployment or execution against a real org, plus its ' +
  'notes. Hunt for genuine defects: data loss (field type changes, whole-document ' +
  'replaces, destructive scope), security regressions (missing FLS/permissions, ' +
  'over-broad access), governor traps (queries/DML in loops, unbounded scope), broken or ' +
  'suspicious references, logic errors, and — for data operations — irreversibility, bad ' +
  'targeting, and volume mistakes. You cannot query the org; judge the content on its ' +
  'face and flag what you could not verify. Do NOT invent findings to seem useful: a ' +
  'clean change deserves "pass" with an empty list.\n\n' +
  'Respond with ONLY a JSON object, no prose around it:\n' +
  '{"verdict": "pass" | "concerns" | "fail", "findings": [{"severity": "blocker" | ' +
  '"concern" | "note", "title": "...", "detail": "..."}]}\n' +
  'verdict=fail requires at least one blocker; concerns = real issues worth the ' +
  "human's attention; pass = you looked hard and found nothing material.";

export interface ReviewFinding {
  severity: 'blocker' | 'concern' | 'note';
  title: string;
  detail: string;
}

export interface StoredReview {
  reviewId: string;
  verdict: 'pass' | 'concerns' | 'fail';
  findings: ReviewFinding[];
  model: string;
  at: string;
  notes: string | null;
}

export interface ReviewResult extends StoredReview {
  hash: string;
}

/** The raw `subject` shape the request_review tool accepts. */
export interface ReviewSubjectInput {
  components?: Array<{ type: string; api_name: string; content?: string; content_file?: string }>;
  deletions?: Array<{ type: string; api_name: string }>;
  script?: string;
  dml?: Record<string, unknown>;
  bulk_steps?: Array<{
    folder: string;
    path: string;
    object: string;
    operation: string;
    external_id_field?: string;
  }>;
  flow_deactivation?: { api_name: string };
}

export type FolderDataResolver = (
  projectId: string,
  folder: string,
  relPath: string,
) => { ok: true; absPath: string; size: number } | { ok: false; message: string };

export class ReviewService {
  constructor(
    private readonly deps: EngineDeps,
    private readonly budget?: BudgetService,
    /** The projects service's linked-folder resolver (bulk subjects). */
    private readonly resolveFolderDataFile?: FolderDataResolver,
  ) {}

  async requestReview(input: {
    projectId: string;
    connection: string;
    subject: ReviewSubjectInput;
    notes?: string;
  }): Promise<ReviewResult> {
    const { subject, body } = this.resolveSubject(input.projectId, input.subject);
    const hash = canonicalReviewHash(subject);

    const userContent =
      `Target connection: ${input.connection}\n` +
      (input.notes ? `Agent notes: ${input.notes}\n` : '') +
      `\n${body}`;
    const { text, costUsd } = await this.callModel(userContent);
    this.budget?.record('review', REVIEW_MODEL, costUsd);

    const parsed = parseVerdict(text);
    return {
      reviewId: `rev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      verdict: parsed.verdict,
      findings: parsed.findings,
      model: REVIEW_MODEL,
      at: new Date().toISOString(),
      notes: input.notes ?? null,
      hash,
    };
  }

  /**
   * Build the canonical subject AND the reviewer-visible body. content_file
   * paths go through the SAME containment as validate_deploy (staging/
   * snapshots/allowedSourceRoots) — request_review must never become a free
   * file-read primitive that ships arbitrary local files to a model.
   */
  private resolveSubject(
    projectId: string,
    raw: ReviewSubjectInput,
  ): { subject: ReviewSubject; body: string } {
    const shapes = [
      raw.components || raw.deletions ? 'deploy' : null,
      raw.script !== undefined ? 'apex' : null,
      raw.dml !== undefined ? 'dml' : null,
      raw.bulk_steps !== undefined ? 'bulk' : null,
      raw.flow_deactivation !== undefined ? 'flow_deactivation' : null,
    ].filter(Boolean);
    if (shapes.length !== 1) {
      throw new Error(
        `subject must carry exactly ONE shape (components/deletions, script, dml, ` +
          `bulk_steps, or flow_deactivation) — got ${shapes.length}.`,
      );
    }

    switch (shapes[0]) {
      case 'deploy': {
        const roots = this.deps.config.deploy.allowedSourceRoots;
        const components = (raw.components ?? []).map((c) => {
          if (c.content_file) {
            // Containment first; hashing and the review body then use the
            // resolved path's bytes.
            const { absPath } = resolveSourcePath(c.content_file, roots, { noun: 'content_file' });
            return { ...c, content_file: absPath };
          }
          return c;
        });
        const deletions = raw.deletions ?? [];
        const parts = components.map((c) => {
          const content =
            c.content ?? (c.content_file ? readForReview(c.content_file) : '(no content)');
          return `## ${c.type} ${c.api_name}\n\`\`\`\n${content.slice(0, MAX_CONTENT_CHARS)}\n\`\`\``;
        });
        if (deletions.length > 0) {
          parts.push(
            `## DELETIONS\n${deletions.map((d) => `- ${d.type}:${d.api_name}`).join('\n')}`,
          );
        }
        return {
          subject: { kind: 'deploy', components, deletions },
          body: `A metadata deploy:\n\n${parts.join('\n\n')}`,
        };
      }
      case 'apex':
        return {
          subject: { kind: 'apex', script: raw.script! },
          body: `An anonymous Apex script (DML commits on success):\n\`\`\`\n${raw
            .script!.slice(0, MAX_CONTENT_CHARS)}\n\`\`\``,
        };
      case 'dml':
        return {
          subject: { kind: 'dml', args: raw.dml! },
          body: `A DML proposal (the exact arguments):\n\`\`\`json\n${JSON.stringify(
            raw.dml,
            null,
            2,
          ).slice(0, MAX_CONTENT_CHARS)}\n\`\`\``,
        };
      case 'bulk': {
        if (!this.resolveFolderDataFile) {
          throw new Error('bulk review subjects are not available in this mode.');
        }
        const steps = (raw.bulk_steps ?? []).map((s, i) => {
          const resolved = this.resolveFolderDataFile!(projectId, s.folder, s.path);
          if (!resolved.ok) throw new Error(`bulk step ${i + 1}: ${resolved.message}`);
          return {
            absPath: resolved.absPath,
            object: s.object,
            operation: s.operation,
            ...(s.external_id_field ? { externalIdField: s.external_id_field } : {}),
            display: `${s.folder}/${s.path}`,
          };
        });
        const body =
          'A Bulk API 2.0 load plan (sequential steps; no cross-job rollback; delete is ' +
          'soft):\n' +
          steps
            .map(
              (s, i) =>
                `${i + 1}. ${s.operation.toUpperCase()} ${s.object} from ${s.display}` +
                (s.externalIdField ? ` (match on ${s.externalIdField})` : '') +
                `\n   head: ${readForReview(s.absPath).slice(0, CSV_PREVIEW_CHARS).replace(/\n/g, ' ⏎ ')}`,
            )
            .join('\n');
        return { subject: { kind: 'bulk', steps }, body };
      }
      default:
        return {
          subject: { kind: 'flow_deactivation', apiName: raw.flow_deactivation!.api_name },
          body: `Deactivating flow "${raw.flow_deactivation!.api_name}" (turns its automation off).`,
        };
    }
  }

  private async callModel(userContent: string): Promise<{ text: string; costUsd: number }> {
    const apiKey = readApiKey();
    if (!apiKey) {
      throw new Error('No Anthropic API key found — add one in Settings before reviewing.');
    }
    this.budget?.assertCanSpend('an adversarial review');
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: REVIEW_MODEL,
        max_tokens: MAX_TOKENS,
        system: REVIEW_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }],
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Review request failed (${response.status}): ${body.slice(0, 200)}`);
    }
    const data = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = (data.content ?? [])
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text)
      .join('')
      .trim();
    if (!text) throw new Error('The reviewer returned an empty response.');
    const inTok = data.usage?.input_tokens ?? 0;
    const outTok = data.usage?.output_tokens ?? 0;
    const costUsd =
      (inTok / 1_000_000) * SONNET_INPUT_USD_PER_MTOK +
      (outTok / 1_000_000) * SONNET_OUTPUT_USD_PER_MTOK;
    return { text, costUsd };
  }
}

function readForReview(absPath: string): string {
  try {
    return fs.readFileSync(absPath, 'utf8');
  } catch (err) {
    return `(unreadable: ${String(err).slice(0, 120)})`;
  }
}

/** Tolerant verdict parsing — a malformed reviewer reply degrades to `concerns`, never to a silent pass. */
function parseVerdict(text: string): { verdict: StoredReview['verdict']; findings: ReviewFinding[] } {
  try {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('no JSON');
    const parsed = JSON.parse(text.slice(start, end + 1)) as {
      verdict?: string;
      findings?: Array<{ severity?: string; title?: string; detail?: string }>;
    };
    const verdict: StoredReview['verdict'] =
      parsed.verdict === 'pass' || parsed.verdict === 'fail' ? parsed.verdict : 'concerns';
    const findings: ReviewFinding[] = (parsed.findings ?? []).slice(0, 25).map((f) => ({
      severity: f.severity === 'blocker' || f.severity === 'note' ? f.severity : 'concern',
      title: String(f.title ?? 'finding').slice(0, 200),
      detail: String(f.detail ?? '').slice(0, 2000),
    }));
    // Internal consistency: a pass with blockers is not a pass.
    if (verdict === 'pass' && findings.some((f) => f.severity === 'blocker')) {
      return { verdict: 'fail', findings };
    }
    return { verdict, findings };
  } catch {
    return {
      verdict: 'concerns',
      findings: [
        {
          severity: 'concern',
          title: 'Reviewer output was not machine-readable',
          detail: text.slice(0, 2000),
        },
      ],
    };
  }
}
