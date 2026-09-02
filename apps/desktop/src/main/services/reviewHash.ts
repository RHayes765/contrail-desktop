import crypto from 'node:crypto';
import fs from 'node:fs';

/**
 * Content-addressed review hashing (S28 Ultracode). ONE implementation, used
 * by BOTH sides of the gate: request_review hashes what it reviewed, and the
 * executor hashes what is being proposed — a propose passes only when the
 * two agree. That equality is the whole guarantee ("the review addresses
 * these exact bytes"), so the rules here are strict:
 *
 *   - hash the EXACT bytes — no unicode normalization, no newline
 *     normalization, no trimming. Any "helpful" equivalence class is content
 *     the human's reviewer never saw.
 *   - content_file / csv paths are resolved to bytes at BOTH points, which
 *     also closes the review→propose TOCTOU: editing the file in between
 *     changes the hash and is correctly refused.
 *   - object keys are sorted (stable-stringify); array ORDER is preserved
 *     except where the subject is a set by construction (deploy components,
 *     bulk steps), which are sorted by identity so listing order cannot
 *     dodge or fake a match.
 */

export type ReviewSubject =
  | {
      kind: 'deploy';
      components: Array<{ type: string; api_name: string; content?: string; content_file?: string }>;
      deletions: Array<{ type: string; api_name: string }>;
    }
  | { kind: 'apex'; script: string }
  | { kind: 'dml'; args: Record<string, unknown> }
  | {
      kind: 'bulk';
      /** Steps AFTER path resolution — absPath is the host-resolved file. */
      steps: Array<{ absPath: string; object: string; operation: string; externalIdField?: string }>;
    }
  | { kind: 'flow_deactivation'; apiName: string };

export function canonicalReviewHash(subject: ReviewSubject): string {
  return sha256(stableStringify(canonicalForm(subject)));
}

function canonicalForm(subject: ReviewSubject): unknown {
  switch (subject.kind) {
    case 'deploy': {
      const components = subject.components
        .map((c) => [c.type, c.api_name, sha256(componentBytes(c))])
        .sort(tupleCompare);
      const deletions = subject.deletions.map((d) => [d.type, d.api_name]).sort(tupleCompare);
      return { kind: 'deploy', components, deletions };
    }
    case 'apex':
      return { kind: 'apex', script: sha256(Buffer.from(subject.script, 'utf8')) };
    case 'dml':
      return { kind: 'dml', args: subject.args };
    case 'bulk': {
      const steps = subject.steps
        .map((s) => [s.object, s.operation, s.externalIdField ?? '', sha256(readBytes(s.absPath))])
        .sort(tupleCompare);
      return { kind: 'bulk', steps };
    }
    case 'flow_deactivation':
      return { kind: 'flow_deactivation', api_name: subject.apiName };
  }
}

function componentBytes(c: { content?: string; content_file?: string }): Buffer {
  if (typeof c.content === 'string') return Buffer.from(c.content, 'utf8');
  if (c.content_file) return readBytes(c.content_file);
  return Buffer.alloc(0); // malformed — the propose itself will refuse it
}

function readBytes(absPath: string): Buffer {
  // A missing file hashes as a sentinel rather than throwing: the gate then
  // simply never matches (and the propose's own containment/read errors give
  // the real message).
  try {
    return fs.readFileSync(absPath);
  } catch {
    return Buffer.from(`<<unreadable:${absPath}>>`, 'utf8');
  }
}

function tupleCompare(a: unknown[], b: unknown[]): number {
  return JSON.stringify(a) < JSON.stringify(b) ? -1 : 1;
}

function sha256(bytes: Buffer | string): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** JSON.stringify with recursively sorted object keys; array order preserved. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
