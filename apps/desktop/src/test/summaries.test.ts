import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ContrailDb, type EngineDeps } from '@contrail/engine';

/**
 * Saved AI summaries. Three failures these pin, all of which the user hit or
 * would have hit:
 *
 *   1. A summary was component state — it died with the window, and the money
 *      spent on it died with it.
 *   2. The old cache was keyed BY content hash, so a changed artifact silently
 *      missed and got re-billed; the user was never told the explanation they
 *      had been reading was out of date.
 *   3. Nothing let a user deliberately regenerate one.
 */

vi.mock('../main/services/agentRuntime.js', () => ({
  readApiKey: () => 'sk-ant-test',
}));

const { SummaryService } = await import('../main/services/summaries.js');
const { readSavedSummary } = await import('../main/services/savedSummary.js');

let tmp: string;
let db: ContrailDb;
let deps: EngineDeps;
let connId: string;
/** Model calls made — the ledger of what the user was billed for. */
let calls: number;

/** A MetadataService stand-in: summaries only need the artifact's content. */
const metadata = {
  artifact: (_c: string, type: string, apiName: string) => ({
    type,
    apiName,
    content: 'public class Thing { }',
    lastModifiedDate: null,
  }),
} as unknown as import('../main/services/metadata.js').MetadataService;

function indexArtifact(hash: string): void {
  db.replaceArtifactsForTypes(connId, ['ApexClass'], [
    {
      type: 'ApexClass',
      apiName: 'Thing',
      filePath: 'classes/Thing.cls',
      contentHash: hash,
      lastModifiedDate: null,
      lastModifiedBy: null,
      retrievedAt: new Date().toISOString(),
    },
  ]);
}

function service() {
  return new SummaryService(deps, metadata);
}

beforeEach(() => {
  calls = 0;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-summaries-'));
  db = new ContrailDb(path.join(tmp, 'test.db'));
  deps = { db, audit: { record: () => undefined } } as unknown as EngineDeps;
  const conn = db.insertConnection({
    alias: 'dev',
    instanceUrl: 'https://example.my.salesforce.com',
    loginUrl: 'https://test.salesforce.com',
    orgId: '00Dxx',
    orgName: 'Dev',
    orgType: 'sandbox',
    isSandbox: true,
    username: 'u@example.com',
    userId: '005xx',
    grants: {
      metadata_read: true,
      metadata_write: false,
      diagnostics_read: false,
      data_read: false,
      data_write: false,
    },
  });
  connId = conn.id;
  indexArtifact('hash-v1');

  vi.stubGlobal('fetch', async () => {
    calls += 1;
    return {
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: `summary #${calls}` }],
        usage: { input_tokens: 1000, output_tokens: 200 },
      }),
    } as unknown as Response;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('a summary is paid for once', () => {
  it('the second request is served from storage, not the model', async () => {
    const first = await service().summarize(connId, 'ApexClass', 'Thing');
    expect(first.cached).toBe(false);
    expect(first.stale).toBe(false);
    expect(calls).toBe(1);

    const second = await service().summarize(connId, 'ApexClass', 'Thing');
    expect(second.summary).toBe(first.summary);
    expect(second.cached).toBe(true);
    expect(calls).toBe(1);
  });

  it('survives a restart — a brand new db handle still has it', async () => {
    const first = await service().summarize(connId, 'ApexClass', 'Thing');
    const file = path.join(tmp, 'test.db');
    db.close();
    db = new ContrailDb(file);
    deps = { db, audit: { record: () => undefined } } as unknown as EngineDeps;

    const after = await service().summarize(connId, 'ApexClass', 'Thing');
    expect(after.summary).toBe(first.summary);
    expect(after.cached).toBe(true);
    expect(calls).toBe(1);
  });

  it('an alias and an id address the SAME summary (no duplicate row)', async () => {
    await service().summarize(connId, 'ApexClass', 'Thing');
    const byAlias = await service().summarize('dev', 'ApexClass', 'Thing');
    expect(byAlias.cached).toBe(true);
    expect(calls).toBe(1);
  });
});

describe('a changed artifact makes the summary outdated, not invisible', () => {
  it('still returns the saved text, flagged stale, without re-billing', async () => {
    const first = await service().summarize(connId, 'ApexClass', 'Thing');
    indexArtifact('hash-v2'); // the org changed under us

    const after = await service().summarize(connId, 'ApexClass', 'Thing');
    expect(after.summary).toBe(first.summary); // NOT hidden
    expect(after.stale).toBe(true); // but labelled
    expect(after.cached).toBe(true);
    expect(calls).toBe(1); // and not silently re-billed
  });

  it('a deleted artifact counts as changed (absent is a real state)', async () => {
    await service().summarize(connId, 'ApexClass', 'Thing');
    const saved = readSavedSummary(
      deps,
      { kind: 'artifact', connectionId: connId, type: 'ApexClass', apiName: 'Thing' },
      'absent',
    );
    expect(saved?.stale).toBe(true);
  });

  it('a missing hash is not treated as evidence of change', async () => {
    indexArtifact(''); // hash unavailable for this type
    db.replaceArtifactsForTypes(connId, ['ApexClass'], [
      {
        type: 'ApexClass',
        apiName: 'Thing',
        filePath: 'classes/Thing.cls',
        contentHash: null,
        lastModifiedDate: null,
        lastModifiedBy: null,
        retrievedAt: new Date().toISOString(),
      },
    ]);
    const first = await service().summarize(connId, 'ApexClass', 'Thing');
    expect(first.stale).toBe(false);
    const again = await service().summarize(connId, 'ApexClass', 'Thing');
    expect(again.stale).toBe(false);
    expect(again.cached).toBe(true);
  });
});

describe('refresh is the user regenerating on purpose', () => {
  it('re-bills, replaces the stored text, and clears stale', async () => {
    const first = await service().summarize(connId, 'ApexClass', 'Thing');
    indexArtifact('hash-v2');

    const refreshed = await service().summarize(connId, 'ApexClass', 'Thing', true);
    expect(calls).toBe(2);
    expect(refreshed.summary).not.toBe(first.summary);
    expect(refreshed.stale).toBe(false);
    expect(refreshed.cached).toBe(false);

    // The replacement is what a later read gets — one row per artifact.
    const next = await service().summarize(connId, 'ApexClass', 'Thing');
    expect(next.summary).toBe(refreshed.summary);
    expect(next.cached).toBe(true);
    expect(calls).toBe(2);
  });
});

describe('the read path — reopening the artifact shows the summary', () => {
  it('artifact() carries the saved summary, with staleness already decided', async () => {
    const { MetadataService } = await import('../main/services/metadata.js');
    const withStore = {
      db,
      store: { readCurrentFile: () => 'public class Thing { }' },
      audit: { record: () => undefined },
    } as unknown as EngineDeps;

    // Nothing generated yet: the field must be null, not absent or a guess.
    expect(new MetadataService(withStore).artifact(connId, 'ApexClass', 'Thing').savedSummary).toBe(
      null,
    );

    await service().summarize(connId, 'ApexClass', 'Thing');
    const fresh = new MetadataService(withStore).artifact(connId, 'ApexClass', 'Thing');
    expect(fresh.savedSummary?.summary).toBe('summary #1');
    expect(fresh.savedSummary?.stale).toBe(false);
    expect(fresh.savedSummary?.model).toBe('claude-haiku-4-5');

    indexArtifact('hash-v2');
    const later = new MetadataService(withStore).artifact(connId, 'ApexClass', 'Thing');
    expect(later.savedSummary?.summary).toBe('summary #1');
    expect(later.savedSummary?.stale).toBe(true);
  });
});

describe('the ledger still sees summary spend', () => {
  it('records a priced event for a generated summary and nothing for a saved one', async () => {
    const recorded: Array<{ kind: string; costUsd: number }> = [];
    const budget = {
      assertCanSpend: () => undefined,
      record: (kind: string, _m: string | null, costUsd: number) =>
        recorded.push({ kind, costUsd }),
    } as unknown as import('../main/services/budget.js').BudgetService;

    const svc = new SummaryService(deps, metadata, undefined, budget);
    await svc.summarize(connId, 'ApexClass', 'Thing');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.kind).toBe('summary');
    expect(recorded[0]!.costUsd).toBeGreaterThan(0);

    await svc.summarize(connId, 'ApexClass', 'Thing'); // saved hit
    expect(recorded).toHaveLength(1);
  });
});
