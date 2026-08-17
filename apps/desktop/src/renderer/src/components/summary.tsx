import { useCallback, useEffect, useRef, useState } from 'react';
import type { SavedSummaryView } from '@contrail/shared';
import { Md } from './thread.js';

/**
 * Saved AI summaries, shared by the Metadata and Diff screens.
 *
 * Two things this must never do: lose a summary the user paid for (they used
 * to live in component state and died with the window), and present a stale
 * explanation as current. So a stored summary is shown on open, stamped with
 * when it was written, and clearly flagged when the metadata it describes has
 * changed since — with Refresh as the user's choice, not an automatic re-bill.
 */

/** The state of a summary in the UI: what's stored, plus in-flight/error. */
export interface SummaryState {
  saved: SavedSummaryView | null;
  busy: boolean;
  error: string | null;
  /** Generate (or regenerate when `refresh`). */
  run: (refresh: boolean) => void;
}

/**
 * Drives one summary. `fetch` performs the channel call; `initial` is the
 * summary that arrived with the artifact/diff view, so a restart shows it
 * without any model call at all.
 */
export function useSummary(
  initial: SavedSummaryView | null,
  fetch: (refresh: boolean) => Promise<SavedSummaryView & { cached: boolean }>,
): SummaryState {
  const [saved, setSaved] = useState<SavedSummaryView | null>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Bumped whenever the subject changes, so a late response can be dropped. */
  const generation = useRef(0);

  // Selecting a different artifact swaps the stored summary underneath us.
  useEffect(() => {
    generation.current += 1;
    setSaved(initial);
    setError(null);
    setBusy(false);
  }, [initial]);

  const run = useCallback(
    (refresh: boolean) => {
      // A summary that arrives after the user moved on must be discarded, not
      // rendered under a different artifact's name.
      const mine = generation.current;
      setBusy(true);
      setError(null);
      void fetch(refresh)
        .then((r) => {
          if (generation.current !== mine) return;
          setSaved({ summary: r.summary, createdAt: r.createdAt, model: r.model, stale: r.stale });
        })
        .catch((err) => {
          if (generation.current !== mine) return;
          setError(String(err).replace(/^Error:\s*/, ''));
        })
        .finally(() => {
          if (generation.current === mine) setBusy(false);
        });
    },
    [fetch],
  );

  return { saved, busy, error, run };
}

/** The "AI summary" action — only offered when nothing is stored yet. */
export function SummaryButton({ state }: { state: SummaryState }) {
  if (state.saved) return null;
  return (
    <button disabled={state.busy} onClick={() => state.run(false)}>
      {state.busy ? 'Summarizing…' : 'AI summary'}
    </button>
  );
}

export function SummaryPanel({ label, state }: { label: string; state: SummaryState }) {
  const { saved, busy, error } = state;
  if (error && !saved) return <div className="notice">{error}</div>;
  if (!saved) return null;
  return (
    <div className={`summary-panel${saved.stale ? ' stale' : ''}`}>
      <div className="summary-head">
        <div className="dep-label">{label}</div>
        <div className="summary-meta">
          <span className="meter-dim">
            generated {new Date(saved.createdAt).toLocaleString()}
            {saved.model ? ` · ${saved.model}` : ''}
          </span>
          <button className="link-btn" disabled={busy} onClick={() => state.run(true)}>
            {busy ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>
      {saved.stale && (
        <div className="summary-stale">
          Outdated — this metadata changed after the summary was written. Refresh to re-summarize
          the current version.
        </div>
      )}
      {error && <div className="notice">{error}</div>}
      <Md text={saved.summary} />
    </div>
  );
}
