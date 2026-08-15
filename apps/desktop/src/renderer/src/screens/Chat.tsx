import { useEffect, useRef, useState } from 'react';
import { CHAT_MODELS, type ChatModelId, type EffortLevel } from '@contrail/shared';
import { useChat } from '../stores/chat.js';
import { useProjects } from '../stores/projects.js';
import { useNav } from '../stores/nav.js';
import { Md, ToolCardView } from '../components/thread.js';

/**
 * The chat screen: markdown-rendered streamed text, tool cards color-coded by
 * env role, model/effort pickers (locked once the conversation starts), and a
 * cost meter that ticks per turn. One live session at a time (v1).
 */

const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export function ChatScreen({ projectId }: { projectId: string }) {
  const {
    sessionId,
    messages,
    streaming,
    busy,
    usage,
    error,
    model,
    effort,
    start,
    configure,
    send,
    interrupt,
    end,
    clearError,
  } = useChat();
  const { projects } = useProjects();
  const { openProject } = useNav();
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const project = (projects ?? []).find((p) => p.id === projectId) ?? null;

  useEffect(() => {
    // The store dedupes: an in-flight start is never doubled (StrictMode) and
    // re-entering the same project's live chat resumes instead of restarting.
    void start(projectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, streaming]);

  const submit = () => {
    const text = draft.trim();
    if (!text || busy || !sessionId) return;
    setDraft('');
    void send(text);
  };

  const leave = () => {
    void end();
    openProject(projectId);
  };

  return (
    <div className="chat-shell">
      <div className="chat-head">
        <button className="crumb" onClick={leave}>
          ← {project?.name ?? 'Project'}
        </button>
        <div className="model-picker" title={messages.length > 0 ? 'Model is fixed for a running conversation — start a new session to change it' : 'Model and reasoning effort for this session'}>
          <select
            value={model}
            disabled={messages.length > 0}
            onChange={(e) => void configure(e.target.value as ChatModelId, effort)}
          >
            {(Object.keys(CHAT_MODELS) as ChatModelId[]).map((id) => (
              <option key={id} value={id}>
                {CHAT_MODELS[id].label}
              </option>
            ))}
          </select>
          <select
            value={effort ?? ''}
            disabled={messages.length > 0}
            onChange={(e) =>
              void configure(model, (e.target.value || null) as EffortLevel | null)
            }
          >
            <option value="">default effort</option>
            {EFFORT_LEVELS.map((lvl) => (
              <option key={lvl} value={lvl}>
                {lvl}
              </option>
            ))}
          </select>
        </div>
        <div className="meter" title="input / output tokens · cache reads">
          <span>${usage.costUsd.toFixed(4)}</span>
          <span className="meter-dim">
            {usage.inputTokens + usage.outputTokens} tok · {usage.cacheReadTokens} cached
          </span>
          {busy && <span className="spinner">thinking…</span>}
        </div>
        {busy && (
          <button onClick={() => void interrupt()} className="danger">
            Stop
          </button>
        )}
      </div>

      <div className="chat-scroll" ref={scrollRef}>
        {messages.length === 0 && !streaming && (
          <div className="empty chat-empty">
            {sessionId
              ? `Ask about ${project?.bindings.map((b) => b.alias).join(', ') || 'this project'} — the session sees only this project's orgs, docs, and notes.`
              : error
                ? `Could not start a session: ${error}`
                : 'Starting session…'}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.parts.map((p, j) =>
              p.kind === 'text' ? (
                m.role === 'assistant' ? (
                  <div key={j} className="msg-text">
                    <Md text={p.text} />
                  </div>
                ) : (
                  // User text stays literal — pasted SOQL/XML must not re-render.
                  <div key={j} className="msg-text">
                    {p.text}
                  </div>
                )
              ) : (
                <ToolCardView key={j} card={p.card} />
              ),
            )}
            {m.role === 'assistant' && i === messages.length - 1 && streaming && (
              <div className="msg-text streaming">
                <Md text={streaming} />
              </div>
            )}
          </div>
        ))}
      </div>

      {error && (
        <div className="notice" onClick={clearError}>
          {error}
        </div>
      )}

      <div className="composer">
        <textarea
          rows={2}
          placeholder={busy ? 'Waiting for the reply…' : 'Message this project'}
          value={draft}
          disabled={!sessionId}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button className="primary" disabled={busy || !draft.trim() || !sessionId} onClick={submit}>
          Send
        </button>
      </div>
    </div>
  );
}
