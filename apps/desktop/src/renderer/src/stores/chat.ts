import { create } from 'zustand';
import type { ChatEvent, EnvRole } from '@contrail/shared';
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

  start: (projectId: string, model?: string) => Promise<void>;
  send: (text: string) => Promise<void>;
  interrupt: () => Promise<void>;
  end: () => Promise<void>;
  clearError: () => void;
}

const ZERO_USAGE: UsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 };

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

  start: async (projectId, model) => {
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
      const view = await ipc.invoke('sessions:start', { projectId, model });
      set({
        sessionId: view.id,
        projectId,
        messages: [],
        streaming: '',
        busy: false,
        usage: { ...ZERO_USAGE },
        error: null,
      });
    } catch (err) {
      set({ sessionId: null, projectId, error: String(err) });
    } finally {
      set({ starting: false });
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
