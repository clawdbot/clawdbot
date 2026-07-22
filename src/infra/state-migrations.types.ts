import type { ChannelLegacyStateMigrationPlan } from "../channels/plugins/types.core.js";
import type { SessionScope } from "../config/sessions/types.js";
import type { PluginDoctorStateMigration } from "../plugins/doctor-contract-registry.js";
import type { LegacyAuditLogsDetection } from "./state-migrations.audit-logs.types.js";
import type { LegacyChannelPairingStateDetection } from "./state-migrations.channel-pairing.js";
import type { LegacyDeviceIdentityDetection } from "./state-migrations.device-identity.types.js";
import type { LegacyMcpOAuthDetection } from "./state-migrations.mcp-oauth.types.js";
import type { LegacyRestartSentinelDetection } from "./state-migrations.restart-sentinel.types.js";
import type { LegacyWorkspaceStateDetection } from "./state-migrations.workspace-setup.types.js";

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
  channelPlans: {
    hasLegacy: boolean;
    plans: ChannelLegacyStateMigrationPlan[];
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
  commitments: {
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
  mcpOauth: LegacyMcpOAuthDetection;
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
  migration: PluginDoctorStateMigration;
  preview: string[];
};

export type MigrationMessages = {
  changes: string[];
  warnings: string[];
  notices?: string[];
};
