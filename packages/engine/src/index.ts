/**
 * @contrail/engine — the Salesforce engine proved out in Phase 0, MCP-free.
 *
 * Surfaces consume the engine through two doors:
 *   - createEngineDeps() → EngineDeps: the DI container for direct service use.
 *   - allCapabilities()/invokeCapability(): the named, grant-classified
 *     operation surface (agent tool minting, tests, thin RPC layers).
 */
export { createEngineDeps, type EngineDeps, type EngineOverrides } from './core/deps.js';
export {
  allCapabilities,
  getCapability,
  invokeCapability,
  ok,
  fail,
  guarded,
  type Capability,
  type ToolResult,
} from './capabilities/index.js';
export {
  STANDARD_CATALOG,
  catalogKeyFor,
  isStandardCatalogKey,
  externalServerKey,
  serverEnabled,
  customSkillKey,
  skillEnabled,
  catalogCoverageViolations,
  type CatalogEntry,
} from './capabilities/catalog.js';

// Core
export { ContrailDb } from './core/db.js';
export { KeychainTokenStore, MemoryTokenStore, type TokenStore } from './core/keychain.js';
export { AuditLog } from './core/audit.js';
export { loadConfig, type ContrailConfig } from './core/config.js';
export { getUpdateNotice, refreshUpdateCache, isNewerVersion, type UpdateNotice } from './core/updateCheck.js';
export { dataDir, dbPath, configPath, deploysDir } from './core/paths.js';
export { ContrailError, ConnectionNotFoundError } from './core/errors.js';
export {
  GRANTS,
  GRANT_DEPENDENCIES,
  TOOL_GRANT_MAP,
  GRANT_DESCRIPTIONS,
  grantDependencyViolations,
  grantedList,
  notGrantedList,
  normalizeGrants,
  type Grant,
  type GrantSet,
} from './core/grants.js';
export { assertGrant } from './core/gate.js';
export { log, setLogSink, type LogSink } from './core/log.js';
export {
  probeBetterSqlite3,
  probeKeyring,
  readSecret,
  readSecretResult,
  writeSecret,
  deleteSecret,
  type NativeProbe,
} from './core/native.js';
export type {
  ConnectionRecord,
  ArtifactRecord,
  DependencyEdge,
  DeployRequestKind,
  DeployRequestRecord,
  AuditEvent,
  EnvRole,
  ProjectRecord,
  ProjectDocRecord,
  ProjectFolderRecord,
  ProjectNoteRecord,
  AgentSessionRecord,
  CustomMcpServerRecord,
  CustomMcpServerExtras,
  ServerToggleRecord,
  CustomSkillRecord,
  SkillToggleRecord,
} from './core/types.js';

// Connect / Salesforce
export { ConnectFlowManager, type FlowOps } from './connect/flow.js';
export { AccessTokenManager } from './salesforce/tokens.js';
export { RestClient, stripAttributes } from './salesforce/rest.js';
export { MetadataSoapClient, type TestLevel } from './salesforce/metadataSoap.js';

// Snapshot / graph / diff
export { SnapshotStore } from './snapshot/store.js';
export {
  SnapshotEngine,
  type RefreshOptions,
  type RefreshJobState,
  type RefreshSummary,
} from './snapshot/engine.js';
export {
  inlineSnapshotWork,
  runExtractAndIndex,
  withChildTypes,
  type SnapshotWorkUnits,
  type ExtractIndexInput,
  type ExtractIndexResult,
  type EdgeExtractionInput,
} from './snapshot/work.js';
export {
  indexSnapshotFiles,
  extractChildBlocks,
  findChildBlock,
  type IndexedArtifact,
} from './snapshot/indexer.js';
export { extractAllEdges, buildKnownArtifacts, type KnownArtifacts } from './deps/extract.js';
export { queryDependencies } from './deps/graph.js';
export { semanticDiff, type DiffLimits } from './diff/semantic.js';

// Metadata reads
export {
  fetchArtifactContent,
  readArtifactFromSnapshot,
  clampContent,
  DEFAULT_CONTENT_BYTES,
  MAX_CONTENT_BYTES,
  CALL_CONTENT_BUDGET,
  splitNamespace,
  CHILD_SPEC,
  type ArtifactContent,
} from './metadata/read.js';

// Metadata views
export {
  parsePermissionSet,
  type PermissionSetView,
  type ObjectPermissionView,
  type FieldPermissionView,
} from './metadata/profiles.js';
export {
  parseFlowGraph,
  diffFlowNodes,
  type FlowGraph,
  type FlowGraphNode,
  type FlowGraphEdge,
  type FlowNodeKind,
  type FlowNodeChanges,
} from './metadata/flowgraph.js';

// Deploy
export { DeployEngine } from './deploy/engine.js';
export {
  ApprovalPageServer,
  type ApprovalPresenter,
  type ApprovalPresentation,
  type ApprovalRequestView,
} from './deploy/approval.js';
export { buildDeployZip, analyzeChanges, flowDeactivationXml } from './deploy/package.js';
export { generateConfirmationCode } from './deploy/codes.js';
