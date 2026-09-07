import type { DatabaseSync } from "node:sqlite";
import type { SessionScope } from "../config/sessions/types.js";
import type { PluginDoctorStateMigration } from "../plugins/doctor-contract-registry.js";
import type { LegacyAuditLogsDetection } from "./state-migrations.audit-logs.types.js";
import type { LegacyChannelPairingStateDetection } from "./state-migrations.channel-pairing.js";
import type { LegacyDeviceIdentityDetection } from "./state-migrations.device-identity.types.js";
import type { LegacyExecApprovalsDetection } from "./state-migrations.exec-approvals.types.js";
import type { LegacyMcpOAuthDetection } from "./state-migrations.mcp-oauth.types.js";
import type { LegacyMeetingTranscriptsDetection } from "./state-migrations.meeting-transcripts.types.js";
import type { LegacyRestartSentinelDetection } from "./state-migrations.restart-sentinel.types.js";
import type { SharedAuthStoreMigrationDetection } from "./state-migrations.shared-auth-store.types.js";
import type { LegacyWorkspaceStateDetection } from "./state-migrations.workspace-setup.types.js";

export type PluginDoctorRepairAuthority = {
  assertCurrent(): void;
  assertOwnedInTransaction(database: DatabaseSync): void;
};

export type LegacyRescuePendingDetection = {
  sourcePaths: string[];
  hasLegacy: boolean;
};

export type SessionStoreAliasPlan = {
  hasDistinctAliases: boolean;
  hasFinalSymlink: boolean;
  hasUnresolvedIdentity: boolean;
};

export type LegacyStateDetection = {
  doctorOnlyStateMigrations?: boolean;
  targetAgentId: string;
  targetMainKey: string;
  targetScope?: SessionScope;
  stateDir: string;
  oauthDir: string;
  pluginSessionStoreAgentIds: readonly string[];
  sessions: {
    legacyDir: string;
    legacyStorePath: string;
    targetDir: string;
    targetStorePath: string;
    hasLegacy: boolean;
    legacyKeys: string[];
    preserveAmbiguousKeys: boolean;
    preserveForeignMainAliases: boolean;
    targetStoreAliases: SessionStoreAliasPlan;
  };
  agentDir: {
    legacyDir: string;
    targetDir: string;
    hasLegacy: boolean;
  };
  pluginPlans?: {
    hasLegacy: boolean;
    plans: DetectedPluginDoctorStateMigrationPlan[];
  };
  pluginStateSidecar: {
    sourcePath: string;
    hasLegacy: boolean;
  };
  pluginInstallIndex: {
    sourcePath: string;
    hasLegacy: boolean;
  };
  debugProxyCaptureSidecar: {
    sourcePath: string;
    blobDir: string;
    hasLegacy: boolean;
  };
  stateSchema: {
    hasLegacy: boolean;
    preview: string[];
  };
  sharedAuthStore: SharedAuthStoreMigrationDetection;
  worktrees: {
    hasLegacy: boolean;
    legacyIds: string[];
    pathRewrites: Array<{ id: string; fromPath: string; toPath: string }>;
  };
  taskStateSidecars: {
    taskRunsPath: string;
    flowRunsPath: string;
    hasLegacy: boolean;
  };
  deliveryQueues: {
    outboundPath: string;
    sessionPath: string;
    hasLegacy: boolean;
  };
  voiceWake: {
    triggersPath: string;
    routingPath: string;
    hasLegacy: boolean;
  };
  updateCheck: {
    sourcePath: string;
    hasLegacy: boolean;
  };
  configHealth: {
    sourcePath: string;
    hasLegacy: boolean;
  };
  pluginBindingApprovals: {
    sourcePath: string;
    hasLegacy: boolean;
  };
  currentConversationBindings: {
    sourcePath: string;
    hasLegacy: boolean;
  };
  tuiLastSessions: {
    sourcePath: string;
    hasLegacy: boolean;
  };
  commitments?: {
    sourcePath: string;
    hasLegacy: boolean;
  };
  auditLogs: LegacyAuditLogsDetection;
  acpReplayLedger: {
    sourcePath: string;
    hasLegacy: boolean;
  };
  managedOutgoingImages: {
    sourceDir: string;
    hasLegacy: boolean;
  };
  apns: {
    sourcePath: string;
    hasLegacy: boolean;
  };
  deviceAuth: {
    sourcePath: string;
    sourcePresent: boolean;
    hasLegacy: boolean;
  };
  deviceIdentity: LegacyDeviceIdentityDetection;
  execApprovals: LegacyExecApprovalsDetection;
  mcpOauth: LegacyMcpOAuthDetection;
  meetingTranscripts?: LegacyMeetingTranscriptsDetection;
  restartSentinel?: LegacyRestartSentinelDetection;
  workspace: LegacyWorkspaceStateDetection;
  webPush: {
    subscriptionsPath: string;
    vapidKeysPath: string;
    hasLegacy: boolean;
  };
  nodeHost: {
    sourcePath: string;
    hasLegacy: boolean;
  };
  subagentRegistry: {
    sourcePath: string;
    hasLegacy: boolean;
  };
  rescuePending: LegacyRescuePendingDetection;
  channelPairing: LegacyChannelPairingStateDetection;
  warnings: string[];
  notices: string[];
  preview: string[];
};

export type MigrationLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

export type DetectedPluginDoctorStateMigrationPlan = {
  pluginId: string;
  /** Only bundled/trusted-official owners may reach durable channel ingress queues. */
  trustedForDurableStores?: boolean;
  channelIds: string[];
  migration: PluginDoctorStateMigration;
  preview: string[];
};

export type MigrationMessages = {
  changes: string[];
  warnings: string[];
  notices?: string[];
  /** The owner completed its required work and classified every warning as advisory. */
  warningDisposition?: "recoverable";
};

export const LEGACY_STATE_MIGRATION_PLAN_SCHEMA_VERSION =
  "openclaw.legacyStateMigrationPlan.v1" as const;

export type LegacyStateMigrationMode = "automatic" | "doctor";

export type LegacyStateMigrationEndpoint =
  | { kind: "path"; path: string }
  | { kind: "sqlite"; path: string }
  | { kind: "owner"; id: string };

export type LegacyStateMigrationStepPlan = {
  id: string;
  phase: "shared" | "final";
  source: LegacyStateMigrationEndpoint[];
  target: LegacyStateMigrationEndpoint[];
  requiredness: "required" | "conditional" | "not-required";
  reversibility: "checkpoint-required" | "not-applicable";
  outcome: "planned" | "skipped" | "deferred";
  refusal?: { code: string; message: string };
};

export type LegacyStateMigrationStepReceipt = Omit<LegacyStateMigrationStepPlan, "outcome"> & {
  outcome: "completed" | "skipped" | "warning" | "refused";
  changes: string[];
  warnings: string[];
  notices?: string[];
  refusal?: { code: string; message: string };
};

export type PlannedPluginDoctorAction = {
  pluginId: string;
  id: string;
};

/** Immutable authority prepared before state mutation for the later session repair writer. */
export type PreparedPostSessionPluginMigration = {
  step: Omit<LegacyStateMigrationStepPlan, "outcome">;
  plannedActions: readonly PlannedPluginDoctorAction[];
};

type LegacyStateMigrationCandidate = {
  root: string;
  version: string;
  artifact: {
    outcome: "deferred";
    refusal: { code: "candidate-artifact-digest-required"; message: string };
  };
};

export type LegacyStateMigrationPlan = {
  schemaVersion: typeof LEGACY_STATE_MIGRATION_PLAN_SCHEMA_VERSION;
  mutationAllowed: false;
  outcome: "planned" | "refused";
  warnings: string[];
  refusal?: { code: string; message: string };
  mode: LegacyStateMigrationMode;
  candidate: LegacyStateMigrationCandidate;
  snapshot: {
    homeDir: string;
    configPath: string;
    configDigest?: string;
    stateDir: string;
    stateDigest?: string;
  };
  steps: LegacyStateMigrationStepPlan[];
  planDigest: string;
};
