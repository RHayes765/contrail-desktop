import { log, type EngineDeps } from '@contrail/engine';
import type { BudgetStatusView } from '@contrail/shared';

/**
 * The spend guard. Per-session caps already existed (the SDK enforces
 * maxBudgetUsd per run), but they left three holes a tester could fall
 * through, all of which cost real money on THEIR key:
 *
 *   1. No ceiling across sessions — four concurrent Opus runs is $20 of
 *      headroom, and every resume minted a FRESH full budget.
 *   2. AI summaries bypassed budgeting entirely (a direct API call).
 *   3. The summary cache was in-memory, so a restart re-billed work already
 *      paid for.
 *
 * This service closes all three against one rolling 24h ledger. It does not
 * merely refuse at the line: it shrinks each session's own cap to whatever
 * allowance remains, so a single session can never cross it either.
 */

const DAILY_CAP_KEY = 'budget.dailyCapUsd';
/** Deliberately modest: a pilot tester should hit this before their card does. */
export const DEFAULT_DAILY_CAP_USD = 10;
/** Below this there is no point starting a session — it would die immediately. */
const MIN_USEFUL_SESSION_USD = 0.05;

export class BudgetOverspendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetOverspendError';
  }
}

export class BudgetService {
  constructor(private readonly deps: EngineDeps) {}

  dailyCapUsd(): number {
    const raw = this.deps.db.getAppSetting(DAILY_CAP_KEY);
    const parsed = raw === null ? NaN : Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_DAILY_CAP_USD;
  }

  setDailyCapUsd(value: number): BudgetStatusView {
    if (!Number.isFinite(value) || value < 0) throw new Error('Enter a number of dollars, 0 or more.');
    if (value > 1000) throw new Error('That cap looks like a typo — 1000 USD/day is the maximum.');
    this.deps.db.setAppSetting(DAILY_CAP_KEY, String(value));
    this.deps.audit.record('budget.cap_changed', {
      tool: 'desktop_settings_screen',
      outcome: 'success',
      detail: { dailyCapUsd: value },
    });
    return this.status();
  }

  private windowStartIso(): string {
    return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  }

  status(): BudgetStatusView {
    const cap = this.dailyCapUsd();
    const spend = this.deps.db.spendSince(this.windowStartIso());
    return {
      capUsd: cap,
      spentUsd: Number(spend.totalUsd.toFixed(6)),
      remainingUsd: Number(Math.max(0, cap - spend.totalUsd).toFixed(6)),
      byKind: spend.byKind.map((k) => ({
        kind: k.kind,
        usd: Number(k.usd.toFixed(6)),
        calls: k.calls,
      })),
      windowHours: 24,
    };
  }

  /** Record real spend. Called for agent turn deltas, summary calls, and Ultracode reviews. */
  record(
    kind: 'session' | 'summary' | 'review',
    model: string | null,
    costUsd: number,
    sessionId?: string | null,
  ): void {
    this.deps.db.recordSpend({ kind, model, costUsd, sessionId: sessionId ?? null });
  }

  /**
   * The allowance a new (or resumed) session may spend: never more than the
   * model's own per-session cap, never more than what's left today. Throws
   * when there is nothing meaningful left, naming the numbers.
   */
  allowanceForSession(modelCapUsd: number): number {
    const { remainingUsd, capUsd, spentUsd } = this.status();
    if (remainingUsd < MIN_USEFUL_SESSION_USD) {
      throw new BudgetOverspendError(
        `Daily AI budget reached: $${spentUsd.toFixed(2)} of $${capUsd.toFixed(2)} spent in the ` +
          `last 24 hours. Raise the cap in Settings, or wait for the window to roll off.`,
      );
    }
    return Math.min(modelCapUsd, remainingUsd);
  }

  /** Guard for non-session spend (summaries). Throws when the cap is reached. */
  assertCanSpend(what: string): void {
    const { remainingUsd, capUsd, spentUsd } = this.status();
    if (remainingUsd <= 0) {
      throw new BudgetOverspendError(
        `Daily AI budget reached ($${spentUsd.toFixed(2)} of $${capUsd.toFixed(2)} in 24h), so ` +
          `${what} was not generated. Raise the cap in Settings or try later.`,
      );
    }
  }

  /** One-time startup line so the log always shows the policy in force. */
  logPolicy(): void {
    const s = this.status();
    log('info', 'AI budget policy', {
      dailyCapUsd: s.capUsd,
      spentUsd24h: s.spentUsd,
      remainingUsd: s.remainingUsd,
    });
  }
}
