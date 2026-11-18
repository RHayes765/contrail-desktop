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
export { AuditLog, type AuditQueryFilter } from './core/audit.js';
export {
  DEFAULT_CONFIG,
  loadConfig,
  loadPolicies,
  saveConfigSection,
  readConfigSection,
  type ContrailConfig,
  type PolicyLoad,
} from './core/config.js';
// S46 (B): governance for client work — the config-only policies, their
// evaluation and every sentence Deploy Review shows about them (one text
// source with the plugin's approval page: core/policy.ts is byte-identical).
export {
  POLICY_LIMITS,
  TEST_LEVEL_ORDER,
  DEFAULT_POLICIES,
  APPROVAL_NOTICES,
  hostTimeZone,
  parsePolicies,
  policyInEffect,
  evaluatePolicies,
  unmatchedRules,
  normalizeTicket,
  normalizeJustification,
  normalizeFreezeReason,
  policyRefusalText,
  policyUnreadableText,
  freezeBannerText,
  freezeProposeNote,
  freezePageNotOpenedText,
  freezeExecuteRefusalText,
  freezeStartRefusalText,
  policyChangedText,
  unmatchedRuleText,
  justificationProvenance,
  apexDeletesNote,
  dryRunPolicyNote,
  type PolicyTestLevel,
  type PolicyOrgType,
  type PolicyKind,
  type FreezeWindow,
  type PolicyRule,
  type PolicyConfig,
  type PolicyContext,
  type PolicyFreeze,
  type PolicyInEffect,
  type PolicyViolationCode,
  type PolicyViolation,
  type PolicyVerdict,
  type PolicyPhase,
  type PolicySource,
  type ApprovalSurfaceMode,
  type StoredJustification,
  type ApprovalNoticeCode,
} from './core/policy.js';
export { getUpdateNotice, refreshUpdateCache, isNewerVersion, type UpdateNotice } from './core/updateCheck.js';
export {
  NOTIFY_ACCOUNTS,
  PUSHOVER_KEY_RE,
  PushoverNotifier,
  NullNotifier,
  composePushover,
  describePhoneOutcome,
  FREEZE_TAIL,
  type ApprovalNotifier,
  type ApprovalNotifyOptions,
  type NotifierStatus,
  type NotifyOutcome,
  type NotifyFailure,
  type NotifyMethod,
  type NotifySummary,
  type NotificationsConfig,
  type PhoneNotification,
} from './core/notify.js';
export { dataDir, dbPath, configPath, deploysDir, stagingDir, evidenceDir } from './core/paths.js';
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
  ManifestEntryRecord,
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
  type RefreshComplete,
  type RefreshOutcome,
  type TypeRefreshOutcome,
  type MemberRefreshOutcome,
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
// S46 (C): the member-scoped refresh's write step and its shapes — what the
// snapshot worker, its bridge and main/index.ts import (snapshot/members.ts
// is byte-identical with the plugin's).
export {
  applyMemberUnits,
  MEMBER_REFRESH_MAX,
  REBASELINE_PROGRESS,
  type SnapshotMember,
  type MemberUnit,
  type MemberSkipReason,
  type MemberOutcome,
  type MemberApplyInput,
  type MemberApplyResult,
  type MemberRefreshSummary,
  type RebaselineOutcome,
  type ExecuteSnapshotBlock,
} from './snapshot/members.js';
export {
  indexSnapshotFiles,
  extractChildBlocks,
  findChildBlock,
  type IndexedArtifact,
} from './snapshot/indexer.js';
export { extractAllEdges, buildKnownArtifacts, type KnownArtifacts } from './deps/extract.js';
export { createLocalDiagRunner, type LocalDiagRunnerOptions } from './localdiag/runner.js';
export type {
  LocalDiagRunner,
  LocalDiagResult,
  LocalDiagnostic,
  ApexSourceKind,
  SpawnLsp,
  UnavailableCode,
} from './localdiag/types.js';
export { queryDependencies } from './deps/graph.js';
export {
  semanticDiff,
  type DiffLimits,
  type Change,
  type TextHunk,
  type ArtifactSemanticDiff,
} from './diff/semantic.js';
// S45 F3: the automation card's one text source (the approval page, the
// Deploy Review section and S46's get_object_automation all read it).
export {
  NOT_COVERED,
  collectObjectAutomation,
  formatAutomationLines,
  parseApexObjectTargets,
  type ObjectAutomation,
  type AutomationFlow,
} from './deps/automation.js';

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
export {
  DeployEngine,
  type ExecutionObserver,
  type DeployValidationSummary,
  type LiveCheckSummary,
  // S46 (B): the change record and policy state; (C): the re-baseline hook.
  type StoredGovernance,
  type GovernanceForAgent,
  type GovernanceInput,
  type GovernanceState,
  type DryRunPolicyCheck,
  type PolicyReport,
  type PoliciesStatus,
  type SnapshotRebaseliner,
} from './deploy/engine.js';
export {
  ApprovalPageServer,
  type ApprovalPresenter,
  type ApprovalPresentation,
  type ApprovalRequestView,
  type ApprovalLivePage,
  type ApprovalStatusCheck,
  type ApprovalRoute,
} from './deploy/approval.js';
export type {
  ApprovalPageOptions,
  ApprovalRowDiff,
  ApprovalAutomation,
  ApprovalGovernance,
} from './connect/pages.js';
// S46 (B): the change-evidence dossier (export_change_evidence) and the
// code-free page view every mint stores (deploy/evidence.ts is byte-identical
// with the plugin's).
export {
  codeFreePageView,
  redactRowLabel,
  justificationRecord,
  buildEvidence,
  exportChangeEvidence,
  EVIDENCE_MAX_REQUESTS,
  type StoredPageView,
  type EvidenceIo,
  type EvidenceFilters,
  type EvidenceResult,
  type EvidenceDossier,
} from './deploy/evidence.js';
export {
  buildDeployZip,
  analyzeChanges,
  flowDeactivationXml,
  fileSafeName,
  deployZipEntryPath,
  type ComponentChange,
  type ComponentPreImage,
  type StampSource,
} from './deploy/package.js';
// S46 D1: what the app needs to print the ONE dates-unavailable line for a
// request it did not present (services/deploys.ts mirrors the engine's
// liveCheckWarnings) — the two member-group reasons, the failed-query reason
// and the "can a stamp query name this member" predicate.
export {
  STAMP_NO_ROW_REASON,
  STAMP_NOT_QUERIED_REASON,
  stampQueryFailedReason,
  isProbeable,
} from './deploy/stampprobe.js';
// S45 F1/F2/F4: the live pre-image, the execute-time target check and the
// revert package (written under stagingDir()/_reverts/<requestId>/).
export {
  hhmm,
  revertDirFor,
  revertReadmeText,
  type PreImage,
  type PreImageResult,
  type RevertPlan,
  type RevertPlanMember,
  type RevertPlanComponent,
  type RevertPlanReason,
  type RevertPlanCovered,
  type RevertTargetCheck,
  type DeployMovedMember,
} from './deploy/preimage.js';
export { resolveSourceFile, resolveSourcePath } from './deploy/sources.js';
export { generateConfirmationCode } from './deploy/codes.js';
