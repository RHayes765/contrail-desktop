import { z } from 'zod';
import type {
  ArtifactDetailView,
  ArtifactDiffView,
  ArtifactRowView,
  ChatEvent,
  ConnectionView,
  ConnectOutcomeView,
  CustomMcpServerView,
  DeployRequestView,
  DiffScopeView,
  McpServerTestView,
  EffortLevel,
  GrantSetView,
  HealthView,
  MetadataTypeCountView,
  PingResultView,
  ProjectDocView,
  ProjectMcpView,
  ProjectNoteView,
  ProjectView,
  SessionView,
  SnapshotStatusView,
  TranscriptView,
} from './views.js';

/**
 * The typed IPC contract — the single source of truth for every channel
 * between renderer and main. Main validates every request against the zod
 * schema before the handler runs; the renderer client is typed off the same
 * table. Add a channel here first, then implement its handler.
 *
 * Two kinds of traffic:
 *   - invoke channels (renderer → main → response), declared in `Contracts`
 *   - push channels (main → renderer events), declared in `PushEvents`
 */

const ENV_ROLE = z.enum(['dev', 'qa', 'uat', 'prod', 'other']);
const ID = z.string().min(1).max(128);

// ── invoke channels ──────────────────────────────────────────────────────

export const REQUEST_SCHEMAS = {
  'app:health': z.object({}),

  'connections:list': z.object({}),
  'connections:connect': z.object({
    login: z.string().max(300).optional(),
    label: z.string().max(120).optional(),
  }),
  'connections:remove': z.object({ id: ID }),
  'connections:ping': z.object({ id: ID }),
  'connections:setGrants': z.object({
    id: ID,
    grants: z.object({
      metadata_read: z.boolean(),
      metadata_write: z.boolean(),
      diagnostics_read: z.boolean(),
      data_read: z.boolean(),
      data_write: z.boolean(),
    }),
  }),

  'metadata:status': z.object({ connectionId: ID }),
  'metadata:sync': z.object({ connectionId: ID }),
  'metadata:types': z.object({ connectionId: ID }),
  'metadata:list': z.object({
    connectionId: ID,
    type: z.string().min(1).max(80),
    query: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }),
  'metadata:artifact': z.object({
    connectionId: ID,
    type: z.string().min(1).max(80),
    apiName: z.string().min(1).max(300),
  }),
  'metadata:summarize': z.object({
    connectionId: ID,
    type: z.enum(['ApexClass', 'ApexTrigger', 'Flow', 'ValidationRule']),
    apiName: z.string().min(1).max(300),
  }),

  'diff:scope': z.object({
    connectionA: ID,
    connectionB: ID,
    types: z.array(z.string().min(1).max(80)).max(20).optional(),
  }),
  'diff:artifact': z.object({
    connectionA: ID,
    connectionB: ID,
    type: z.string().min(1).max(80),
    apiName: z.string().min(1).max(300),
  }),
  'diff:summarize': z.object({
    connectionA: ID,
    connectionB: ID,
    type: z.enum(['ApexClass', 'ApexTrigger', 'Flow', 'ValidationRule']),
    apiName: z.string().min(1).max(300),
  }),

  'projects:list': z.object({}),
  'projects:create': z.object({
    name: z.string().min(1).max(120),
    description: z.string().max(2000).optional(),
  }),
  'projects:update': z.object({
    id: ID,
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(2000).nullable().optional(),
    instructions: z.string().max(20_000).nullable().optional(),
  }),
  'projects:delete': z.object({ id: ID }),
  'projects:bind': z.object({ projectId: ID, connectionId: ID, envRole: ENV_ROLE }),
  'projects:unbind': z.object({ projectId: ID, connectionId: ID }),

  'projects:docs:list': z.object({ projectId: ID }),
  'projects:docs:add': z.object({ projectId: ID }),
  'projects:docs:remove': z.object({ projectId: ID, docId: ID }),

  'projects:notes:list': z.object({ projectId: ID }),
  'projects:notes:add': z.object({ projectId: ID, body: z.string().min(1).max(10_000) }),

  'sessions:list': z.object({ projectId: ID }),
  'sessions:start': z.object({
    projectId: ID,
    model: z.string().max(80).optional(),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  }),
  'sessions:send': z.object({ sessionId: ID, text: z.string().min(1).max(50_000) }),
  'sessions:interrupt': z.object({ sessionId: ID }),
  'sessions:end': z.object({ sessionId: ID }),
  'sessions:transcript': z.object({ sessionId: ID }),
  'sessions:resume': z.object({ sessionId: ID }),

  'mcp:project': z.object({ projectId: ID }),
  'mcp:setToggle': z.object({
    projectId: ID,
    serverKey: z.string().min(1).max(160),
    enabled: z.boolean(),
  }),
  'mcp:servers:list': z.object({}),
  'mcp:servers:add': z.object({
    name: z.string().min(1).max(120),
    transport: z.enum(['stdio', 'http', 'sse']),
    urlOrCommand: z.string().min(1).max(2000),
    args: z.array(z.string().max(500)).max(64).optional(),
    env: z.record(z.string().max(64), z.string().max(4000)).optional(),
    headers: z.record(z.string().max(64), z.string().max(4000)).optional(),
    oauthClientId: z.string().max(300).optional(),
    oauthClientSecret: z.string().max(300).optional(),
  }),
  'mcp:servers:update': z.object({
    id: ID,
    name: z.string().min(1).max(120).optional(),
    urlOrCommand: z.string().min(1).max(2000).optional(),
    enabled: z.boolean().optional(),
    args: z.array(z.string().max(500)).max(64).optional(),
    env: z.record(z.string().max(64), z.string().max(4000)).optional(),
    headers: z.record(z.string().max(64), z.string().max(4000)).optional(),
    oauthClientId: z.string().max(300).optional(),
    oauthClientSecret: z.string().max(300).optional(),
  }),
  'mcp:servers:remove': z.object({ id: ID }),
  'mcp:servers:test': z.object({ id: ID }),
  'mcp:servers:authorize': z.object({ id: ID }),

  'deploys:list': z.object({ connectionId: ID.optional() }),
  'deploys:get': z.object({ id: ID }),
  'deploys:approve': z.object({ id: ID, comment: z.string().max(1000).optional() }),
  'deploys:reject': z.object({ id: ID, comment: z.string().max(1000).optional() }),
} as const;

export type Channel = keyof typeof REQUEST_SCHEMAS;

export interface Contracts {
  'app:health': { req: Record<string, never>; res: HealthView };

  'connections:list': { req: Record<string, never>; res: ConnectionView[] };
  'connections:connect': {
    req: { login?: string; label?: string };
    res: ConnectOutcomeView;
  };
  'connections:remove': { req: { id: string }; res: { ok: boolean; detail: string | null } };
  'connections:ping': { req: { id: string }; res: PingResultView };
  'connections:setGrants': {
    req: { id: string; grants: GrantSetView };
    res: ConnectionView;
  };

  'metadata:status': { req: { connectionId: string }; res: SnapshotStatusView };
  'metadata:sync': {
    req: { connectionId: string };
    res: { status: 'started' | 'already_syncing' | 'locked' };
  };
  'metadata:types': { req: { connectionId: string }; res: MetadataTypeCountView[] };
  'metadata:list': {
    req: { connectionId: string; type: string; query?: string; limit?: number };
    res: ArtifactRowView[];
  };
  'metadata:artifact': {
    req: { connectionId: string; type: string; apiName: string };
    res: ArtifactDetailView;
  };
  'metadata:summarize': {
    req: {
      connectionId: string;
      type: 'ApexClass' | 'ApexTrigger' | 'Flow' | 'ValidationRule';
      apiName: string;
    };
    res: { summary: string; cached: boolean };
  };

  'diff:scope': {
    req: { connectionA: string; connectionB: string; types?: string[] };
    res: DiffScopeView;
  };
  'diff:artifact': {
    req: { connectionA: string; connectionB: string; type: string; apiName: string };
    res: ArtifactDiffView;
  };
  'diff:summarize': {
    req: {
      connectionA: string;
      connectionB: string;
      type: 'ApexClass' | 'ApexTrigger' | 'Flow' | 'ValidationRule';
      apiName: string;
    };
    res: { summary: string; cached: boolean };
  };

  'projects:list': { req: Record<string, never>; res: ProjectView[] };
  'projects:create': { req: { name: string; description?: string }; res: ProjectView };
  'projects:update': {
    req: {
      id: string;
      name?: string;
      description?: string | null;
      instructions?: string | null;
    };
    res: ProjectView;
  };
  'projects:delete': { req: { id: string }; res: { ok: boolean } };
  'projects:bind': {
    req: { projectId: string; connectionId: string; envRole: 'dev' | 'qa' | 'uat' | 'prod' | 'other' };
    res: ProjectView;
  };
  'projects:unbind': { req: { projectId: string; connectionId: string }; res: ProjectView };

  'projects:docs:list': { req: { projectId: string }; res: ProjectDocView[] };
  'projects:docs:add': { req: { projectId: string }; res: { added: ProjectDocView[] } };
  'projects:docs:remove': { req: { projectId: string; docId: string }; res: { ok: boolean } };

  'projects:notes:list': { req: { projectId: string }; res: ProjectNoteView[] };
  'projects:notes:add': { req: { projectId: string; body: string }; res: ProjectNoteView };

  'sessions:list': { req: { projectId: string }; res: SessionView[] };
  'sessions:start': {
    req: { projectId: string; model?: string; effort?: EffortLevel };
    res: SessionView;
  };
  'sessions:send': { req: { sessionId: string; text: string }; res: { ok: boolean } };
  'sessions:interrupt': { req: { sessionId: string }; res: { ok: boolean } };
  'sessions:end': { req: { sessionId: string }; res: { ok: boolean } };
  'sessions:transcript': { req: { sessionId: string }; res: TranscriptView };
  'sessions:resume': { req: { sessionId: string }; res: SessionView };

  'mcp:project': { req: { projectId: string }; res: ProjectMcpView };
  'mcp:setToggle': {
    req: { projectId: string; serverKey: string; enabled: boolean };
    res: ProjectMcpView;
  };
  'mcp:servers:list': { req: Record<string, never>; res: CustomMcpServerView[] };
  'mcp:servers:add': {
    req: {
      name: string;
      transport: 'stdio' | 'http' | 'sse';
      urlOrCommand: string;
      args?: string[];
      env?: Record<string, string>;
      headers?: Record<string, string>;
      oauthClientId?: string;
      oauthClientSecret?: string;
    };
    res: CustomMcpServerView;
  };
  'mcp:servers:update': {
    req: {
      id: string;
      name?: string;
      urlOrCommand?: string;
      enabled?: boolean;
      args?: string[];
      env?: Record<string, string>;
      headers?: Record<string, string>;
      oauthClientId?: string;
      oauthClientSecret?: string;
    };
    res: CustomMcpServerView;
  };
  'mcp:servers:remove': { req: { id: string }; res: { ok: boolean } };
  'mcp:servers:test': { req: { id: string }; res: McpServerTestView };
  'mcp:servers:authorize': {
    req: { id: string };
    res: { ok: boolean; detail: string; test: McpServerTestView | null };
  };

  'deploys:list': { req: { connectionId?: string }; res: DeployRequestView[] };
  'deploys:get': { req: { id: string }; res: DeployRequestView };
  'deploys:approve': { req: { id: string; comment?: string }; res: DeployRequestView };
  'deploys:reject': { req: { id: string; comment?: string }; res: DeployRequestView };
}

// Compile-time check: every contract has a schema and vice versa.
type _SchemaCovers = keyof Contracts extends Channel ? true : never;
type _ContractCovers = Channel extends keyof Contracts ? true : never;
const _covered: [_SchemaCovers, _ContractCovers] = [true, true];
void _covered;

// ── push channels (main → renderer) ──────────────────────────────────────

export interface PushEvents {
  'connections:changed': { reason: 'connected' | 'updated' | 'removed' };
  /** Live snapshot-sync progress; `done` closes the stream (error set on failure). */
  'metadata:progress': {
    connectionId: string;
    progress: string;
    elapsedMs: number;
    done: boolean;
    error: string | null;
  };
  /** Streamed agent events for a live session. */
  'session:event': { sessionId: string; event: ChatEvent };
  /** A session started or ended — session lists for this project are stale. */
  'sessions:changed': { projectId: string };
  /** A deploy request appeared or changed state — Deploys screens are stale. */
  'deploys:changed': { requestId: string | null };
}

export type PushChannel = keyof PushEvents;

/** The surface preload exposes on window.contrail. */
export interface ContrailBridge {
  invoke<C extends keyof Contracts>(
    channel: C,
    req: Contracts[C]['req'],
  ): Promise<Contracts[C]['res']>;
  subscribe<C extends PushChannel>(
    channel: C,
    listener: (payload: PushEvents[C]) => void,
  ): () => void;
}
