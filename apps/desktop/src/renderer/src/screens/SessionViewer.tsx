import { useEffect, useState } from 'react';
import { CHAT_MODELS, type TranscriptView } from '@contrail/shared';
import { ipc } from '../lib/ipc.js';
import { useNav } from '../stores/nav.js';
import type { ToolCard } from '../stores/chat.js';
import { Md, ToolCardView } from '../components/thread.js';

/**
 * Read-only replay of a past session from its on-disk transcript. Rendering
 * mirrors the live chat (markdown, tool cards) so a session reads the same
 * way finished as it did live.
 */

export function SessionViewerScreen({
  projectId,
  sessionId,
}: {
  projectId: string;
  sessionId: string;
}) {
  const { openProject } = useNav();
  const [transcript, setTranscript] = useState<TranscriptView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTranscript(null);
    setError(null);
    ipc
      .invoke('sessions:transcript', { sessionId })
      .then(setTranscript)
      .catch((err) => setError(String(err)));
  }, [sessionId]);

  const session = transcript?.session;
  const modelLabel =
    session?.model && Object.hasOwn(CHAT_MODELS, session.model)
      ? CHAT_MODELS[session.model as keyof typeof CHAT_MODELS].label
      : (session?.model ?? '?');

  // Pair tool_start↔tool_end once — a .find() per card would be quadratic on
  // long transcripts.
  const toolOutcomes = new Map<string, boolean>();
  for (const e of transcript?.entries ?? []) {
    if (e.kind === 'tool_end') toolOutcomes.set(e.toolUseId, e.ok);
  }

  return (
    <div className="chat-shell">
      <div className="chat-head">
        <button className="crumb" onClick={() => openProject(projectId)}>
          ← Back
        </button>
        {session && (
          <>
            <span className="viewer-title">{session.title ?? 'untitled session'}</span>
            <span className={`status-chip ${session.status}`}>{session.status}</span>
            <div className="meter">
              <span>${session.costUsd.toFixed(4)}</span>
              <span className="meter-dim">
                {modelLabel} · {session.inputTokens + session.outputTokens} tok ·{' '}
                {new Date(session.createdAt).toLocaleString()}
              </span>
            </div>
          </>
        )}
      </div>

      <div className="chat-scroll">
        {error ? (
          <div className="empty chat-empty">Could not load this session: {error}</div>
        ) : transcript === null ? (
          <div className="empty chat-empty">Loading transcript…</div>
        ) : transcript.missing ? (
          <div className="empty chat-empty">
            No transcript was recorded for this session (it predates transcript capture, or the
            file was removed).
          </div>
        ) : transcript.entries.length === 0 ? (
          <div className="empty chat-empty">This session ended before anything was said.</div>
        ) : (
          <>
            {transcript.truncated && (
              <div className="notice">Long session — showing the most recent part.</div>
            )}
            {transcript.entries.map((entry, i) => {
              switch (entry.kind) {
                case 'user':
                  return (
                    <div key={i} className="msg user">
                      <div className="msg-text">{entry.text}</div>
                    </div>
                  );
                case 'assistant':
                  return (
                    <div key={i} className="msg assistant">
                      <div className="msg-text">
                        <Md text={entry.text} />
                      </div>
                    </div>
                  );
                case 'tool_start': {
                  const card: ToolCard = {
                    toolUseId: entry.toolUseId,
                    name: entry.name,
                    input: entry.input,
                    connection: null,
                    envRole: null,
                    ok: toolOutcomes.get(entry.toolUseId) ?? null,
                  };
                  return (
                    <div key={i} className="msg assistant">
                      <ToolCardView card={card} />
                    </div>
                  );
                }
                case 'error':
                  return (
                    <div key={i} className="notice" style={{ cursor: 'default' }}>
                      {entry.message}
                    </div>
                  );
                default:
                  return null; // tool_end renders via its tool_start pair
              }
            })}
          </>
        )}
      </div>
    </div>
  );
}
