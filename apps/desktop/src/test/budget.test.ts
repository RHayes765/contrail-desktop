import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ContrailDb, type EngineDeps } from '@contrail/engine';
import {
  BudgetOverspendError,
  BudgetService,
  DEFAULT_DAILY_CAP_USD,
} from '../main/services/budget.js';

/**
 * The spend guard. The holes these tests pin were all real: agent turns and
 * summaries were budgeted separately (summaries not at all), resume minted a
 * fresh full budget, and nothing bounded several sessions together.
 */

let tmp: string;
let db: ContrailDb;
let deps: EngineDeps;
let svc: BudgetService;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-budget-'));
  db = new ContrailDb(path.join(tmp, 'test.db'));
  deps = { db, audit: { record: () => undefined } } as unknown as EngineDeps;
  svc = new BudgetService(deps);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('one ceiling covers every kind of paid call', () => {
  it('counts session turns AND summaries against the same number', () => {
    svc.record('session', 'claude-haiku-4-5', 1.5, 'sess-1');
    svc.record('summary', 'claude-haiku-4-5', 0.25);
    svc.record('summary', 'claude-haiku-4-5', 0.25);
    const s = svc.status();
    expect(s.spentUsd).toBeCloseTo(2.0, 6);
    expect(s.capUsd).toBe(DEFAULT_DAILY_CAP_USD);
    expect(s.remainingUsd).toBeCloseTo(DEFAULT_DAILY_CAP_USD - 2.0, 6);
    const kinds = Object.fromEntries(s.byKind.map((k) => [k.kind, k]));
    expect(kinds.session.calls).toBe(1);
    expect(kinds.summary.calls).toBe(2);
  });

  it('ignores free/cached calls — zero cost is not a ledger event', () => {
    svc.record('summary', 'claude-haiku-4-5', 0);
    expect(svc.status().spentUsd).toBe(0);
    expect(svc.status().byKind).toEqual([]);
  });
});

describe('a session can never cross the daily line (the resume hole)', () => {
  it('clamps the session allowance to what remains, not the model cap', () => {
    svc.setDailyCapUsd(2);
    svc.record('session', 'claude-opus-5', 1.5, 'sess-1');
    // Opus normally gets $5/session; only $0.50 of the day is left.
    expect(svc.allowanceForSession(5)).toBeCloseTo(0.5, 6);
  });

  it('never inflates a small model cap up to the remaining allowance', () => {
    svc.setDailyCapUsd(100);
    expect(svc.allowanceForSession(0.5)).toBe(0.5);
  });

  it('refuses outright once the remainder is too small to be useful', () => {
    svc.setDailyCapUsd(1);
    svc.record('session', 'claude-opus-5', 0.99, 'sess-1');
    expect(() => svc.allowanceForSession(5)).toThrow(BudgetOverspendError);
    // The message must name the real numbers, not just say "no".
    expect(() => svc.allowanceForSession(5)).toThrow(/0\.99 of \$1\.00/);
  });
});

describe('summaries are refused at the ceiling', () => {
  it('assertCanSpend throws only when nothing is left', () => {
    svc.setDailyCapUsd(1);
    svc.record('summary', 'claude-haiku-4-5', 0.4);
    expect(() => svc.assertCanSpend('this summary')).not.toThrow();
    svc.record('summary', 'claude-haiku-4-5', 0.7); // now over
    expect(() => svc.assertCanSpend('this summary')).toThrow(/Daily AI budget reached/);
  });
});

describe('the window really rolls', () => {
  it('excludes spend older than 24h', () => {
    // Plant an old event directly — 25 hours ago.
    db.recordSpend({ kind: 'session', model: 'm', costUsd: 5 });
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).db.prepare(`UPDATE spend_events SET ts = ?`).run(old);
    expect(svc.status().spentUsd).toBe(0);
    expect(svc.status().remainingUsd).toBe(DEFAULT_DAILY_CAP_USD);
  });
});

describe('the cap is user policy, persisted and validated', () => {
  it('round-trips through the database', () => {
    svc.setDailyCapUsd(3.5);
    expect(new BudgetService(deps).dailyCapUsd()).toBe(3.5);
  });

  it('refuses nonsense instead of storing it', () => {
    expect(() => svc.setDailyCapUsd(-1)).toThrow();
    expect(() => svc.setDailyCapUsd(Number.NaN)).toThrow();
    expect(() => svc.setDailyCapUsd(5000)).toThrow(/typo/);
    expect(svc.dailyCapUsd()).toBe(DEFAULT_DAILY_CAP_USD);
  });

  it('a cap of 0 stops all spend rather than meaning "unlimited"', () => {
    svc.setDailyCapUsd(0);
    expect(() => svc.assertCanSpend('a summary')).toThrow();
    expect(() => svc.allowanceForSession(5)).toThrow();
  });
});

describe('saved summaries survive a restart (they were in-memory)', () => {
  it('a stored summary is readable by a fresh handle on the same database', () => {
    const key = { kind: 'artifact' as const, connectionId: 'conn-1', type: 'Flow', apiName: 'Foo' };
    db.putSavedSummary({ ...key, connectionBId: '', contentHash: 'hash123', contentHashB: null, summary: 'the summary', model: 'claude-haiku-4-5' });
    expect(db.getSavedSummary(key)?.summary).toBe('the summary');
    // Reopening the same file keeps it — no re-billing after a restart.
    db.close();
    const reopened = new ContrailDb(path.join(tmp, 'test.db'));
    const saved = reopened.getSavedSummary(key);
    expect(saved?.summary).toBe('the summary');
    // The hash rides along as DATA, so staleness stays decidable after restart.
    expect(saved?.contentHash).toBe('hash123');
    reopened.close();
    db = new ContrailDb(path.join(tmp, 'test.db')); // so afterEach can close
  });
});
