import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalReviewHash, stableStringify } from '../main/services/reviewHash.js';

/**
 * The content-addressed contract behind the Ultracode gate. Both sides
 * (request_review and the executor) hash through this module — these tests
 * pin the equivalence classes: what MUST match (same bytes, any listing
 * order, any key order) and what must NEVER match (one changed byte).
 */

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-rh-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('stableStringify', () => {
  it('is key-order invariant and array-order preserving', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(
      stableStringify({ a: { c: 3, d: 2 }, b: 1 }),
    );
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });
});

describe('canonicalReviewHash', () => {
  it('dml: argument key order never changes the hash; a value change always does', () => {
    const a = canonicalReviewHash({
      kind: 'dml',
      args: { operation: 'update', object: 'Account', records: [{ Id: 'x', Name: 'N' }] },
    });
    const b = canonicalReviewHash({
      kind: 'dml',
      args: { records: [{ Name: 'N', Id: 'x' }], object: 'Account', operation: 'update' },
    });
    expect(a).toBe(b);
    const c = canonicalReviewHash({
      kind: 'dml',
      args: { operation: 'update', object: 'Account', records: [{ Id: 'x', Name: 'M' }] },
    });
    expect(c).not.toBe(a);
  });

  it('deploy: component listing order is irrelevant; content vs content_file with the same bytes is identical', () => {
    const file = path.join(tmp, 'Thing.cls');
    fs.writeFileSync(file, 'public class Thing { }');
    const viaFile = canonicalReviewHash({
      kind: 'deploy',
      components: [
        { type: 'ApexClass', api_name: 'Thing', content_file: file },
        { type: 'CustomField', api_name: 'Account.X__c', content: '<fields/>' },
      ],
      deletions: [{ type: 'Flow', api_name: 'Old' }],
    });
    const viaInlineReordered = canonicalReviewHash({
      kind: 'deploy',
      components: [
        { type: 'CustomField', api_name: 'Account.X__c', content: '<fields/>' },
        { type: 'ApexClass', api_name: 'Thing', content: 'public class Thing { }' },
      ],
      deletions: [{ type: 'Flow', api_name: 'Old' }],
    });
    expect(viaFile).toBe(viaInlineReordered);

    // One byte in the FILE changes the hash — the TOCTOU closure.
    fs.writeFileSync(file, 'public class Thing {  }');
    expect(
      canonicalReviewHash({
        kind: 'deploy',
        components: [
          { type: 'ApexClass', api_name: 'Thing', content_file: file },
          { type: 'CustomField', api_name: 'Account.X__c', content: '<fields/>' },
        ],
        deletions: [{ type: 'Flow', api_name: 'Old' }],
      }),
    ).not.toBe(viaFile);
  });

  it('deploy: a changed deletion set changes the hash', () => {
    const base = {
      kind: 'deploy' as const,
      components: [{ type: 'ApexClass', api_name: 'T', content: 'x' }],
    };
    expect(canonicalReviewHash({ ...base, deletions: [] })).not.toBe(
      canonicalReviewHash({ ...base, deletions: [{ type: 'Flow', api_name: 'Doomed' }] }),
    );
  });

  it('apex: exact bytes — no normalization equivalence classes', () => {
    const a = canonicalReviewHash({ kind: 'apex', script: 'System.debug(1);\n' });
    expect(canonicalReviewHash({ kind: 'apex', script: 'System.debug(1);\r\n' })).not.toBe(a);
    expect(canonicalReviewHash({ kind: 'apex', script: 'System.debug(1);\n' })).toBe(a);
  });

  it('bulk: hashes the resolved files BYTES; step order irrelevant; csv edit detected', () => {
    const f1 = path.join(tmp, 'a.csv');
    const f2 = path.join(tmp, 'b.csv');
    fs.writeFileSync(f1, 'Name\nAcme\n');
    fs.writeFileSync(f2, 'Id\n001000000000001AAA\n');
    const a = canonicalReviewHash({
      kind: 'bulk',
      steps: [
        { absPath: f1, object: 'Account', operation: 'insert' },
        { absPath: f2, object: 'Account', operation: 'delete' },
      ],
    });
    const b = canonicalReviewHash({
      kind: 'bulk',
      steps: [
        { absPath: f2, object: 'Account', operation: 'delete' },
        { absPath: f1, object: 'Account', operation: 'insert' },
      ],
    });
    expect(a).toBe(b);
    fs.appendFileSync(f1, 'Globex\n');
    expect(
      canonicalReviewHash({
        kind: 'bulk',
        steps: [
          { absPath: f1, object: 'Account', operation: 'insert' },
          { absPath: f2, object: 'Account', operation: 'delete' },
        ],
      }),
    ).not.toBe(a);
  });

  it('the kinds never collide with each other', () => {
    const hashes = [
      canonicalReviewHash({ kind: 'apex', script: 'x' }),
      canonicalReviewHash({ kind: 'dml', args: { operation: 'insert' } }),
      canonicalReviewHash({ kind: 'flow_deactivation', apiName: 'x' }),
      canonicalReviewHash({ kind: 'deploy', components: [], deletions: [] }),
    ];
    expect(new Set(hashes).size).toBe(hashes.length);
  });
});
