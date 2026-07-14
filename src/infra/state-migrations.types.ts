import type { ChannelLegacyStateMigrationPlan } from "../channels/plugins/types.core.js";
import type { SessionScope } from "../config/sessions/types.js";
import type { PluginDoctorStateMigration } from "../plugins/doctor-contract-registry.js";
import type { LegacyChannelPairingStateDetection } from "./state-migrations.channel-pairing.js";

export type SessionStoreAliasPlan = {
  hasDistinctAliases: boolean;
  hasFinalSymlink: boolean;
  hasUnresolvedIdentity: boolean;
};

export type LegacyStateDetection = {
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
  channelPairing: LegacyChannelPairingStateDetection;
  execApprovals: {
    sourcePath: string;
    targetPath: string;
    hasLegacy: boolean;
  };
  warnings: string[];
  notices: string[];
  preview: string[];
};

export type LegacyExecApprovalsMigrationDetection = LegacyStateDetection["execApprovals"];

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
