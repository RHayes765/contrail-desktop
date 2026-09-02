import { useEffect, useRef, useState } from 'react';
import { CHAT_MODELS, type ChatModelId, type EffortLevel } from '@contrail/shared';
import { ipc } from '../lib/ipc.js';
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
    notice,
    pendingApproval,
    model,
    effort,
    ultracode,
    sessionModel,
    sessionEffort,
    sessionUltracode,
    start,
    configure,
    send,
    interrupt,
    end,
    clearError,
  } = useChat();

  // Once the conversation is locked, the pickers show what the SESSION runs —
  // never a preference the session might not be honoring (resume, races).
  const locked = messages.length > 0;
  const shownModel = locked ? (sessionModel ?? model) : model;
  const shownEffort = locked ? sessionEffort : effort;
  const shownUltracode = locked ? (sessionUltracode ?? false) : ultracode;
  const { projects } = useProjects();
  const { openProject } = useNav();
  const [draft, setDraft] = useState('');
  // Files dropped onto the chat: already copied into the project's docs by
  // main; listed here until the next send tells the agent they exist.
  const [attached, setAttached] = useState<string[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  // dragenter/dragleave fire for every CHILD the pointer crosses; a bare
  // boolean flickers. Count depth, and only react to drags that carry files.
  const dragDepth = useRef(0);
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
    if ((!text && attached.length === 0) || busy || !sessionId) return;
    // Attachments ride as a plain preamble the agent can act on — the files
    // are ALREADY in the project docs, so read_project_doc just works.
    const preamble =
      attached.length > 0
        ? `[Attached to project docs: ${attached.join(', ')} — read with read_project_doc]\n\n`
        : '';
    setDraft('');
    setAttached([]);
    void send(preamble + (text || 'Please look at the attached file(s).'));
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    setAttachError(null);
    const files = Array.from(e.dataTransfer?.files ?? []);
    const failures: string[] = [];
    for (const file of files) {
      try {
        const path = ipc.pathForFile(file);
        if (!path) throw new Error(`No path for ${file.name}`);
        const { added } = await ipc.invoke('projects:docs:addFromPath', { projectId, path });
        setAttached((prev) => (prev.includes(added.filename) ? prev : [...prev, added.filename]));
      } catch (err) {
        failures.push(`${file.name}: ${String(err).replace(/^Error:\s*/, '')}`);
      }
    }
    // Every failure, not just the last — dropping three files and seeing one
    // error line for one of them reads as "the other two worked".
    if (failures.length) setAttachError(failures.join(' · '));
  };

  const leave = () => {
    void end();
    openProject(projectId);
  };

  return (
    <div
      className={`chat-shell${dragOver ? ' drag-over' : ''}`}
      onDragEnter={(e) => {
        if (!e.dataTransfer?.types.includes('Files')) return;
        e.preventDefault();
        dragDepth.current += 1;
        setDragOver(true);
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer?.types.includes('Files')) return;
        e.preventDefault();
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragOver(false);
      }}
      onDrop={(e) => void onDrop(e)}
    >
      <div className="chat-head">
        <button className="crumb" onClick={leave}>
          ← {project?.name ?? 'Project'}
        </button>
        <div className="model-picker" title={locked ? 'Model is fixed for a running conversation — start a new session to change it' : 'Model and reasoning effort for this session'}>
          <select
            value={shownModel}
            disabled={locked}
            onChange={(e) => void configure(e.target.value as ChatModelId, effort, ultracode)}
          >
            {(Object.keys(CHAT_MODELS) as ChatModelId[]).map((id) => (
              <option key={id} value={id}>
                {CHAT_MODELS[id].label}
              </option>
            ))}
          </select>
          <select
            value={shownEffort ?? ''}
            disabled={locked}
            onChange={(e) =>
              void configure(model, (e.target.value || null) as EffortLevel | null, ultracode)
            }
          >
            <option value="">default effort</option>
            {EFFORT_LEVELS.map((lvl) => (
              <option key={lvl} value={lvl}>
                {lvl}
              </option>
            ))}
          </select>
          <label
            className={`grant-toggle ultracode-toggle${shownUltracode ? ' on' : ''}`}
            title={
              'Ultracode: every write proposal is machine-refused until the exact content ' +
              'passed an adversarial AI review (the verdict shows on the approval card). ' +
              'Heavier validation = more token spend; raises this session\'s budget cap 3×.'
            }
          >
            <input
              type="checkbox"
              checked={shownUltracode}
              disabled={locked}
              onChange={(e) => void configure(model, effort, e.target.checked)}
            />
            <span>Ultracode</span>
          </label>
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

      {pendingApproval && (
        <div
          className={`approval-banner env-${pendingApproval.orgType === 'production' ? 'prod' : 'dev'}`}
        >
          <span>
            The agent wants to{' '}
            {pendingApproval.kind === 'deploy'
              ? 'deploy metadata to'
              : pendingApproval.kind === 'apex'
                ? 'run an anonymous Apex script on'
                : pendingApproval.kind === 'bulk'
                  ? 'bulk-load data into'
                  : 'change data on'}{' '}
            <strong>{pendingApproval.connection}</strong> ({pendingApproval.orgType}). Nothing runs
            until you decide.
          </span>
          <button
            className="primary"
            onClick={() => useNav.getState().openDeploys(pendingApproval.requestId)}
          >
            Review &amp; approve →
          </button>
          <button
            title="Dismiss (the request stays on the Deploys screen)"
            onClick={() => useChat.setState({ pendingApproval: null })}
          >
            ✕
          </button>
        </div>
      )}
      {notice && (
        <div
          className="notice"
          onClick={() => useChat.setState({ notice: null })}
          title="Dismiss"
        >
          {notice}
        </div>
      )}
      {error && (
        <div className="notice" onClick={clearError}>
          {error}
        </div>
      )}

      {attachError && (
        <div className="notice" onClick={() => setAttachError(null)}>
          {attachError}
        </div>
      )}
      {attached.length > 0 && (
        <div className="attach-row">
          {attached.map((name) => (
            <span key={name} className="attach-chip">
              📎 {name}
              <button
                aria-label={`Remove ${name} from this message`}
                onClick={() => setAttached((prev) => prev.filter((n) => n !== name))}
              >
                ×
              </button>
            </span>
          ))}
          <span className="meter-dim">saved to project docs · sent with your next message</span>
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
        <button
          className="primary"
          disabled={busy || (!draft.trim() && attached.length === 0) || !sessionId}
          onClick={submit}
        >
          Send
        </button>
      </div>
    </div>
  );
}
