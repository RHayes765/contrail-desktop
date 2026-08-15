import { create } from 'zustand';
import {
  CHAT_MODELS,
  type ChatEvent,
  type ChatModelId,
  type EffortLevel,
  type EnvRole,
  type TranscriptEntryView,
} from '@contrail/shared';
import { ipc } from '../lib/ipc.js';

/**
 * One live chat session at a time (v1). Events stream from main; this store
 * folds them into a message list the Chat screen renders directly.
 */

export interface ToolCard {
  toolUseId: string;
  name: string;
  input: unknown;
  connection: string | null;
  envRole: EnvRole | null;
  /** null while running */
  ok: boolean | null;
}

export type MessagePart = { kind: 'text'; text: string } | { kind: 'tool'; card: ToolCard };

export interface ChatMessage {
  role: 'user' | 'assistant';
  parts: MessagePart[];
}

interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

interface ChatState {
  sessionId: string | null;
  projectId: string | null;
  messages: ChatMessage[];
  /** Text streamed for the current in-flight assistant reply. */
  streaming: string;
  busy: boolean;
  /** A start() is in flight — guards double-starts (StrictMode, fast nav). */
  starting: boolean;
  usage: UsageTotals;
  error: string | null;
  /** Neutral status line (external-server OAuth progress) — not an error. */
  notice: string | null;
  /** Model/effort the user WANTS (persisted). The live session may lag during a swap. */
  model: ChatModelId;
  effort: EffortLevel | null;
  /** What the LIVE session actually runs — reconciliation target for configure(). */
  sessionModel: ChatModelId | null;
  sessionEffort: EffortLevel | null;

  start: (projectId: string) => Promise<void>;
  /** Continue an ended session with its history — visible AND model-side. */
  resume: (projectId: string, sessionId: string) => Promise<void>;
  /** Change model/effort — restarts the session (only offered before the first message). */
  configure: (model: ChatModelId, effort: EffortLevel | null) => Promise<void>;
  send: (text: string) => Promise<void>;
  interrupt: () => Promise<void>;
  end: () => Promise<void>;
  clearError: () => void;
}

const ZERO_USAGE: UsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 };

const PREFS_KEY = 'contrail.chat.prefs';

function loadPrefs(): { model: ChatModelId; effort: EffortLevel | null } {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Record<string, unknown>;
    const model =
      typeof raw.model === 'string' && Object.hasOwn(CHAT_MODELS, raw.model)
        ? (raw.model as ChatModelId)
        : 'claude-haiku-4-5';
    const effort = ['low', 'medium', 'high', 'xhigh', 'max'].includes(raw.effort as string)
      ? (raw.effort as EffortLevel)
      : null;
    return { model, effort };
  } catch {
    return { model: 'claude-haiku-4-5', effort: null };
  }
}

function savePrefs(model: ChatModelId, effort: EffortLevel | null): void {
  localStorage.setItem(PREFS_KEY, JSON.stringify({ model, effort }));
}

/** Rebuild the visible thread from a persisted transcript (resume preload). */
export function messagesFromTranscript(entries: TranscriptEntryView[]): ChatMessage[] {
  const toolOutcomes = new Map<string, boolean>();
  for (const e of entries) {
    if (e.kind === 'tool_end') toolOutcomes.set(e.toolUseId, e.ok);
  }
  const messages: ChatMessage[] = [];
  const currentAssistant = (): ChatMessage => {
    const last = messages[messages.length - 1];
    if (last && last.role === 'assistant') return last;
    const fresh: ChatMessage = { role: 'assistant', parts: [] };
    messages.push(fresh);
    return fresh;
  };
  for (const e of entries) {
    switch (e.kind) {
      case 'user':
        messages.push({ role: 'user', parts: [{ kind: 'text', text: e.text }] });
        break;
      case 'assistant':
        currentAssistant().parts.push({ kind: 'text', text: e.text });
        break;
      case 'tool_start':
        currentAssistant().parts.push({
          kind: 'tool',
          card: {
            toolUseId: e.toolUseId,
            name: e.name,
            input: e.input,
            connection: null,
            envRole: null,
            ok: toolOutcomes.get(e.toolUseId) ?? null,
          },
        });
        break;
      default:
        break; // tool_end folded above; errors don't reconstruct as messages
    }
  }
  return messages;
}

function lastAssistant(messages: ChatMessage[]): ChatMessage | null {
  const last = messages[messages.length - 1];
  return last && last.role === 'assistant' ? last : null;
}

export const useChat = create<ChatState>((set, get) => ({
  sessionId: null,
  projectId: null,
  messages: [],
  streaming: '',
  busy: false,
  starting: false,
  usage: { ...ZERO_USAGE },
  error: null,
  notice: null,
  sessionModel: null,
  sessionEffort: null,
  ...loadPrefs(),

  start: async (projectId) => {
    const state = get();
    // Re-entering the same project's live chat resumes it; a start already in
    // flight (StrictMode double-effect) is never doubled.
    if (state.starting) return;
    if (state.sessionId && state.projectId === projectId) return;
    set({ starting: true, error: null });
    try {
      // Leaving a previous live session behind? End it — one live chat in v1.
      const prev = get().sessionId;
      if (prev) {
        await ipc.invoke('sessions:end', { sessionId: prev }).catch(() => undefined);
      }
      const { model, effort } = get();
      const view = await ipc.invoke('sessions:start', {
        projectId,
        model,
        effort: effort ?? undefined,
      });
      set({
        sessionId: view.id,
        projectId,
        messages: [],
        streaming: '',
        busy: false,
        usage: { ...ZERO_USAGE },
        error: null,
        // Record what this session ACTUALLY runs — if the picker moved while
        // the start was in flight, configure() reconciles against these.
        sessionModel: model,
        sessionEffort: effort,
      });
    } catch (err) {
      set({ sessionId: null, projectId, error: String(err) });
    } finally {
      set({ starting: false });
    }
  },

  resume: async (projectId, sessionId) => {
    const state = get();
    if (state.starting) return;
    if (state.sessionId === sessionId) return; // already the live session
    set({ starting: true, error: null });
    try {
      // One live chat: leave any other session behind first.
      const prev = get().sessionId;
      if (prev) {
        await ipc.invoke('sessions:end', { sessionId: prev }).catch(() => undefined);
      }
      // Preload the visible history, then bring the runtime back up on it.
      const transcript = await ipc.invoke('sessions:transcript', { sessionId });
      const view = await ipc.invoke('sessions:resume', { sessionId });
      const sessionModel =
        view.model && Object.hasOwn(CHAT_MODELS, view.model)
          ? (view.model as ChatModelId)
          : null;
      set({
        sessionId: view.id,
        projectId,
        messages: messagesFromTranscript(transcript.entries),
        streaming: '',
        busy: false,
        usage: {
          inputTokens: view.inputTokens,
          outputTokens: view.outputTokens,
          cacheReadTokens: view.cacheReadTokens,
          costUsd: view.costUsd,
        },
        error: null,
        // The session's OWN model/effort (from the row) — the user's saved
        // preference is deliberately untouched; the locked picker displays
        // sessionModel, so the header tells the truth about what is running.
        sessionModel,
        sessionEffort: view.effort,
      });
    } catch (err) {
      set({ error: String(err) });
    } finally {
      set({ starting: false });
    }
  },

  configure: async (model, effort) => {
    savePrefs(model, effort);
    set({ model, effort });
    // Wait out any in-flight start so the check below sees the real session —
    // otherwise a mid-spawn picker change would be silently dropped and the
    // conversation would run (and bill) on a model the header doesn't show.
    while (get().starting) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const s = get();
    const matches = s.sessionModel === s.model && s.sessionEffort === s.effort;
    // Before the first message the session is just an idle process — swap it
    // for one on the new config. After that, the picker is disabled in the UI.
    if (s.projectId && s.messages.length === 0 && !matches) {
      const prev = s.sessionId;
      set({ sessionId: null });
      if (prev) await ipc.invoke('sessions:end', { sessionId: prev }).catch(() => undefined);
      await get().start(s.projectId);
    }
  },

  send: async (text) => {
    const { sessionId, busy } = get();
    if (!sessionId || busy) return;
    set((s) => ({
      messages: [
        ...s.messages,
        { role: 'user', parts: [{ kind: 'text', text }] },
        { role: 'assistant', parts: [] },
      ],
      streaming: '',
      busy: true,
      error: null,
    }));
    try {
      await ipc.invoke('sessions:send', { sessionId, text });
    } catch (err) {
      set({ busy: false, error: String(err) });
    }
  },

  interrupt: async () => {
    const { sessionId } = get();
    if (sessionId) await ipc.invoke('sessions:interrupt', { sessionId }).catch(() => undefined);
  },

  end: async () => {
    const { sessionId } = get();
    if (sessionId) await ipc.invoke('sessions:end', { sessionId }).catch(() => undefined);
    set({ sessionId: null, busy: false });
  },

  clearError: () => set({ error: null }),
}));

function onEvent(event: ChatEvent): void {
  const state = useChat.getState();
  switch (event.type) {
    case 'text_delta':
      useChat.setState({ streaming: state.streaming + event.text });
      break;
    case 'text': {
      // Finalized block: replace the streamed preview with the real text.
      const messages = [...state.messages];
      const target = lastAssistant(messages);
      if (target) {
        target.parts = [...target.parts, { kind: 'text', text: event.text }];
        useChat.setState({ messages, streaming: '' });
      }
      break;
    }
    case 'tool_start': {
      const messages = [...state.messages];
      const target = lastAssistant(messages);
      if (target) {
        target.parts = [
          ...target.parts,
          {
            kind: 'tool',
            card: {
              toolUseId: event.toolUseId,
              name: event.name,
              input: event.input,
              connection: event.connection,
              envRole: event.envRole,
              ok: null,
            },
          },
        ];
        useChat.setState({ messages });
      }
      break;
    }
    case 'tool_end': {
      const messages = state.messages.map((m) => ({
        ...m,
        parts: m.parts.map((p) =>
          p.kind === 'tool' && p.card.toolUseId === event.toolUseId
            ? { ...p, card: { ...p.card, ok: event.ok } }
            : p,
        ),
      }));
      useChat.setState({ messages });
      break;
    }
    case 'usage':
      useChat.setState({
        usage: {
          inputTokens: state.usage.inputTokens + event.inputTokens,
          outputTokens: state.usage.outputTokens + event.outputTokens,
          cacheReadTokens: state.usage.cacheReadTokens + event.cacheReadTokens,
          costUsd: state.usage.costUsd + event.costUsd,
        },
      });
      break;
    case 'mcp_status': {
      const bad = event.servers.filter((s) => s.status !== 'connected');
      const isStatusNotice = state.notice?.startsWith('External servers:') ?? false;
      if (bad.length === 0) {
        // All good — clear only our own stale status line, never an auth prompt.
        if (isStatusNotice) useChat.setState({ notice: null });
      } else if (state.notice === null || isStatusNotice) {
        const needsAuth = bad.some((s) => s.status === 'needs-auth');
        useChat.setState({
          notice:
            `External servers: ${bad
              .map((s) => `${s.name} — ${s.status}${s.error ? ` (${s.error.slice(0, 280)})` : ''}`)
              .join('; ')}` +
            (needsAuth
              ? '. Authorize it on the Connectors screen, then start a new session.'
              : ''),
        });
      }
      break;
    }
    case 'external_auth':
      useChat.setState({
        notice:
          event.status === 'browser_opened'
            ? `Opening your browser to authorize “${event.server}”… Finish the login there, then keep chatting.`
            : event.status === 'completed'
              ? `“${event.server}” authorized — its tools are now available in this session.`
              : `Refused to open the authorization URL “${event.server}” sent (unsafe scheme).`,
      });
      break;
    case 'error':
      // Fatal runtime errors are always followed by 'done' (or the session
      // ends), but never leave the composer stuck if that ordering slips.
      useChat.setState({ error: event.message, busy: false });
      break;
    case 'done':
      useChat.setState({ busy: false, streaming: '' });
      break;
    case 'session_ended':
      useChat.setState({
        sessionId: null,
        busy: false,
        streaming: '',
        error: `Session ended: ${event.reason}`,
      });
      break;
  }
}

ipc.subscribe('session:event', ({ sessionId, event }) => {
  if (sessionId !== useChat.getState().sessionId) return; // stale/other session
  onEvent(event);
});
