import type { GrantSet } from './grants.js';

export type OrgType = 'production' | 'sandbox' | 'developer' | 'trial' | 'unknown';

/**
 * A stored org connection. Tokens are never part of this record — the
 * refresh token lives in the OS keychain under the connection id.
 */
export interface ConnectionRecord {
  /** Stable UUID; keychain alias and audit references point at this. */
  id: string;
  /** Future multi-workspace support (main spec schema discipline); 'default' in Phase 0. */
  workspaceId: string;
  /** Human-chosen label, unique; how the agent names the org. */
  alias: string;
  instanceUrl: string;
  /** Login endpoint the OAuth flow ran against (needed for refresh + revoke). */
  loginUrl: string;
  orgId: string;
  orgName: string | null;
  orgType: OrgType;
  isSandbox: boolean;
  username: string | null;
  userId: string | null;
  grants: GrantSet;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

/** One indexed metadata artifact from a snapshot (or a child, e.g. a field of an object). */
export interface ArtifactRecord {
  id: string;
  workspaceId: string;
  connectionId: string;
  /** Metadata type: ApexClass, ApexTrigger, Flow, CustomObject, CustomField, ValidationRule, CustomLabel, ... */
  type: string;
  /** Full API name; children are dotted (Account.MyField__c). */
  apiName: string;
  /** Path within the snapshot's current/ tree holding the source (parent file for children). */
  filePath: string | null;
  contentHash: string | null;
  lastModifiedDate: string | null;
  lastModifiedBy: string | null;
  retrievedAt: string;
}

export interface DependencyEdge {
  connectionId: string;
  /** The artifact that references... */
  fromType: string;
  fromName: string;
  /** ...the artifact being referenced. */
  toType: string;
  toName: string;
  /** 'org' = MetadataComponentDependency API; 'extractor' = Contrail's own reference extractor. */
  source: 'org' | 'extractor';
}

/**
 * What a deploy_requests row proposes. The claim machinery (supersede,
 * single-use, expiry, lockout) is kind-agnostic — new kinds ride it for free.
 */
export type DeployRequestKind = 'deploy' | 'dml' | 'apex';

/** A validated write awaiting (or past) human approval — deploys, DML, and anonymous Apex share the table. */
export interface DeployRequestRecord {
  id: string;
  workspaceId: string;
  connectionId: string;
  kind: DeployRequestKind;
  confirmationCode: string;
  status:
    | 'validated'
    | 'executing'
    | 'executed'
    | 'expired'
    | 'superseded'
    | 'execution_failed'
    | 'locked';
  createdAt: string;
  expiresAt: string;
  executedAt: string | null;
  /** Deploy zip on disk (deploys). */
  payloadPath: string | null;
  /** Proposed records JSON (DML). */
  payloadJson: string | null;
  summaryJson: string;
  validationId: string | null;
  /** Execution outcome JSON, set once terminal, so late polls still get the result. */
  resultJson: string | null;
  // ── desktop-owned columns (v6/v9); null on rows the v5 plugin wrote ──────
  sessionId: string | null;
  sourceConnectionId: string | null;
  approvedAt: string | null;
  approvedComment: string | null;
  /** Native-approval lifecycle: awaiting_approval | approved | rejected. */
  desktopState: string | null;
  /** 'desktop' for rows created through the app; null = plugin/legacy. */
  origin: string | null;
  /** CODE-FREE review model persisted by the native presenter. */
  reviewJson: string | null;
}

export interface AuditEvent {
  id: string;
  workspaceId: string;
  ts: string;
  eventType: string;
  connectionId: string | null;
  tool: string | null;
  outcome: 'success' | 'refused' | 'error';
  detail: Record<string, unknown> | null;
}

// ── v6 desktop records (projects / sessions — see the v5 freeze contract in db.ts) ──

export type EnvRole = 'dev' | 'qa' | 'uat' | 'prod' | 'other';

/** A project = context silo: instructions, docs, notes, and org bindings. */
export interface ProjectRecord {
  id: string;
  name: string;
  description: string | null;
  instructions: string | null;
  rulesetRef: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectDocRecord {
  id: string;
  projectId: string;
  filename: string;
  mime: string | null;
  sizeBytes: number | null;
  addedAt: string;
}

/**
 * A local folder LINKED to a project (v14) — a live view of the user's own
 * files, never a copy. Unlinking removes only the row; the folder is theirs.
 */
export interface ProjectFolderRecord {
  id: string;
  projectId: string;
  /** Absolute realpath of the linked folder at link time. */
  path: string;
  addedAt: string;
}

export interface ProjectNoteRecord {
  id: string;
  projectId: string;
  sessionId: string | null;
  author: 'user' | 'agent';
  body: string;
  createdAt: string;
}

export interface AgentSessionRecord {
  id: string;
  projectId: string;
  title: string | null;
  status: string;
  transcriptPath: string | null;
  model: string | null;
  /** The Agent SDK's session id — the resume handle into the runtime's own store. */
  sdkSessionId: string | null;
  effort: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  createdAt: string;
  endedAt: string | null;
}

/** Extra transport config for a custom MCP server, stored as config_json. */
export interface CustomMcpServerExtras {
  /** stdio: command arguments. */
  args?: string[];
  /** stdio: extra environment variables. */
  env?: Record<string, string>;
  /** http/sse: request headers (e.g. Authorization). */
  headers?: Record<string, string>;
  /**
   * User-supplied OAuth client, for providers that refuse dynamic client
   * registration (Slack, Google). The secret is auth material: views carry
   * only its presence, never the value.
   */
  oauthClientId?: string;
  oauthClientSecret?: string;
}

export interface CustomMcpServerRecord {
  id: string;
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  urlOrCommand: string;
  /** v1 registers 'independent' only; 'org_bound' is design-doc scope (docs/org-bound-contract.md). */
  authMode: 'independent' | 'org_bound';
  config: CustomMcpServerExtras;
  enabled: boolean;
  /**
   * Whether this connector joins projects that have no explicit toggle row
   * for it. A property of the connector, not the project: "always mine"
   * connectors (Slack, Gmail) default on everywhere; ambiguous ones (a Jira
   * that may be the client's) stay opt-in per project.
   */
  defaultOn: boolean;
  createdAt: string;
}

/** One per-project toggle row; absence has meaning (see capabilities/catalog.ts serverEnabled). */
export interface ServerToggleRecord {
  serverKey: string;
  enabled: boolean;
}

/** A user-uploaded skill in the universal library (v13). Bundled skills are not persisted. */
export interface CustomSkillRecord {
  id: string;
  name: string;
  description: string;
  /** Folder name under dataDir()/skills/ holding SKILL.md (+ assets). */
  dirName: string;
  /** Absent a per-project toggle row, is this skill on for a project? */
  defaultOn: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SkillToggleRecord {
  skillKey: string;
  enabled: boolean;
}

/** A saved AI summary, addressed by what it describes (see db v11). */
export interface SavedSummaryRecord {
  kind: 'artifact' | 'diff';
  connectionId: string;
  /** '' for a single-artifact summary; org B for a diff summary. */
  connectionBId: string;
  type: string;
  apiName: string;
  /** Content hash at generation time — the basis for the staleness check. */
  contentHash: string | null;
  contentHashB: string | null;
  summary: string;
  model: string | null;
  createdAt: string;
}
