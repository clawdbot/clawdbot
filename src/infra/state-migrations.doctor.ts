import os from "node:os";
import path from "node:path";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import {
  discardLegacyRegistryWorktrees,
  hasLegacyRegistryWorktrees,
} from "../agents/worktrees/registry.js";
import { listBundledChannelLegacyStateMigrationDetectors } from "../channels/plugins/bundled.js";
import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import { getChannelPlugin } from "../channels/plugins/registry.js";
import type { ChannelLegacyStateMigrationPlan } from "../channels/plugins/types.core.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import { resolveOAuthDir, resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  createPluginStateKeyedStore,
  getPluginStateCapacity as resolvePluginStateCapacity,
  importPluginStateEntriesForDoctor,
  type OpenKeyedStoreOptions,
} from "../plugin-state/plugin-state-store.js";
import {
  collectRelevantDoctorPluginIds,
  listPluginDoctorSessionStoreAgentIds,
  listPluginDoctorStateMigrationEntries,
  type PluginDoctorStateMigrationContext,
  type PluginDoctorStateMigrationDetection,
} from "../plugins/doctor-contract-registry.js";
import { resolveLegacyInstalledPluginIndexStorePath } from "../plugins/installed-plugin-index-store.js";
import {
  DEFAULT_ACCOUNT_ID,
  DEFAULT_MAIN_KEY,
  LEGACY_IMPLICIT_AGENT_ID,
  normalizeAgentId,
} from "../routing/session-key.js";
import {
  detectOpenClawStateDatabaseSchemaMigrations,
  repairOpenClawStateDatabaseSchema,
  repairOpenClawStateDatabaseSchemaIfNeeded,
  type OpenClawStateDatabaseSchemaMigration,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { acquireGatewayLock } from "./gateway-lock.js";
import {
  detectLegacyAcpReplayLedger,
  migrateLegacyAcpReplayLedger,
} from "./state-migrations.acp-replay.js";
import {
  detectLegacyApnsRegistrations,
  migrateLegacyApnsRegistrations,
} from "./state-migrations.apns.js";
import { detectLegacyAuditLogs, migrateLegacyAuditLogs } from "./state-migrations.audit-logs.js";
import {
  detectLegacyChannelPairingState,
  migrateLegacyChannelPairingState,
} from "./state-migrations.channel-pairing.js";
import {
  detectLegacyCommitments,
  migrateLegacyCommitments,
} from "./state-migrations.commitments.js";
import { migrateLegacyConfigMachineState } from "./state-migrations.config-machine-state.js";
import {
  detectLegacyDebugProxyCaptureSidecar,
  migrateLegacyDebugProxyCaptureSidecar,
} from "./state-migrations.debug-proxy.js";
import { detectLegacyDeviceAuth, migrateLegacyDeviceAuth } from "./state-migrations.device-auth.js";
import {
  detectLegacyDeviceIdentity,
  migrateLegacyDeviceIdentity,
} from "./state-migrations.device-identity.js";
import {
  detectLegacyExecApprovals,
  migrateLegacyExecApprovals,
} from "./state-migrations.exec-approvals.js";
import {
  existsDir,
  fileExists,
  readSessionStoreJson5,
  safeReadDir,
} from "./state-migrations.fs.js";
import {
  migrateLegacyAgentDir,
  migrateLegacySessions,
} from "./state-migrations.legacy-sessions.js";
import {
  detectLegacyManagedOutgoingImages,
  migrateLegacyManagedOutgoingImages,
} from "./state-migrations.managed-outgoing-images.js";
import {
  detectLegacyMcpOAuthStores,
  migrateLegacyMcpOAuthStores,
} from "./state-migrations.mcp-oauth.js";
import { migrateLegacyMediaPersistence } from "./state-migrations.media-persistence.js";
import {
  detectLegacyMeetingTranscripts,
  migrateLegacyMeetingTranscripts,
} from "./state-migrations.meeting-transcripts.js";
import { mergeNotices } from "./state-migrations.messages.js";
import {
  detectLegacyNodeHostConfig,
  migrateLegacyNodeHostConfig,
} from "./state-migrations.node-host.js";
import {
  migrateLegacyInstalledPluginIndex,
  migrateLegacyPluginStateSidecar,
  runLegacyMigrationPlans,
} from "./state-migrations.plugin-state.js";
import {
  detectLegacyRescuePending,
  discardLegacyRescuePending,
} from "./state-migrations.rescue-pending.js";
import {
  detectLegacyRestartSentinel,
  migrateLegacyRestartSentinel,
} from "./state-migrations.restart-sentinel.js";
import {
  migrateLegacyConfigHealth,
  migrateLegacyCurrentConversationBindings,
  migrateLegacyPluginBindingApprovals,
  migrateLegacyVoiceWakeSettings,
  resolveLegacyConfigHealthPath,
  resolveLegacyCurrentConversationBindingsPath,
  resolveLegacyPluginBindingApprovalsPath,
  resolveLegacyVoiceWakeRoutingPath,
  resolveLegacyVoiceWakeTriggersPath,
} from "./state-migrations.runtime-state.js";
import {
  listLegacySessionKeys,
  mergeSessionStoreAliasPlans,
  migrateLegacyAcpSessionMetadata,
  migrateOrphanedSessionKeys,
  resolveStaleLegacySessionFile,
  resolveSessionStoreOwnership,
  type SessionStoreOwnership,
} from "./state-migrations.session-store.js";
import { resetLegacySessionSurfacesForTest } from "./state-migrations.session-surfaces.js";
import {
  autoMigrateLegacyStateDir,
  resetAutoMigrateLegacyTaskStateSidecarsForTest,
} from "./state-migrations.state-dir.js";
import {
  PLUGIN_STATE_SQLITE_SIDECAR_SUFFIXES,
  TASK_STATE_SQLITE_SIDECAR_SUFFIXES,
  buildLegacyMigrationPreview,
  hasPendingSqliteSidecarArchive,
  listLegacyDeliveryQueueDeliveredMarkers,
  listLegacyDeliveryQueueFiles,
  migrateLegacyDeliveryQueues,
  migrateLegacyTaskStateSidecars,
  resolveLegacyDeliveryQueuePath,
  resolveLegacyFlowRunsSidecarPath,
  resolveLegacyPluginStateSidecarPath,
  resolveLegacyTaskRunsSidecarPath,
} from "./state-migrations.storage.js";
import {
  detectLegacySubagentRegistry,
  migrateLegacySubagentRegistry,
} from "./state-migrations.subagent-registry.js";
import {
  detectLegacyTuiLastSessions,
  migrateLegacyTuiLastSessions,
} from "./state-migrations.tui-last-session.js";
import type {
  DetectedPluginDoctorStateMigrationPlan,
  LegacyStateDetection,
  MigrationLogger,
  MigrationMessages,
} from "./state-migrations.types.js";
import {
  migrateLegacyUpdateCheckState,
  resolveLegacyUpdateCheckPath,
} from "./state-migrations.update-check.js";
import { detectLegacyWebPush, migrateLegacyWebPush } from "./state-migrations.web-push.js";
import {
  detectLegacyWorkspaceState,
  migrateLegacyWorkspaceState,
} from "./state-migrations.workspace-setup.js";

function describeStateSchemaMigration(migration: OpenClawStateDatabaseSchemaMigration): string {
  switch (migration.kind) {
    case "agent-databases-composite-primary-key":
      return "agent database registry primary key → agent_id,path";
    case "audit-events-v2":
      return "audit event ledger → versioned message lifecycle schema";
    case "operator-approvals-system-agent":
      return "operator approvals → OpenClaw system changes";
    case "session-watch-cursor-provenance-v4":
      return "session watch cursors → provenance column";
    case "strict-tables-v3":
      return "tables → SQLite STRICT typing";
  }
  return migration.kind satisfies never;
}

const autoMigrateChecked = new Set<string>();

const PLUGIN_DOCTOR_MIGRATION_LOCK_TIMEOUT_MS = 250;
const PLUGIN_DOCTOR_MIGRATION_LOCK_POLL_INTERVAL_MS = 25;

export function resetAutoMigrateLegacyStateForTest(): void {
  autoMigrateChecked.clear();
  resetAutoMigrateLegacyTaskStateSidecarsForTest();
  resetLegacySessionSurfacesForTest();
}

async function collectChannelLegacyStateMigrationPlans(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  oauthDir: string;
}): Promise<ChannelLegacyStateMigrationPlan[]> {
  const plans: ChannelLegacyStateMigrationPlan[] = [];
  // Legacy state detection belongs on a narrow setup-entry surface so doctor
  // does not cold-load unrelated runtime channel code.
  const detectors = listBundledChannelLegacyStateMigrationDetectors({ config: params.cfg });
  for (const detectLegacyStateMigrationsLocal of detectors) {
    const detected = await detectLegacyStateMigrationsLocal({
      cfg: params.cfg,
      env: params.env,
      stateDir: params.stateDir,
      oauthDir: params.oauthDir,
    });
    if (detected?.length) {
      for (const detectedPlan of detected) {
        const plan =
          detectedPlan.kind === "plugin-state-import" && !detectedPlan.stateDir
            ? { ...detectedPlan, stateDir: params.stateDir }
            : detectedPlan;
        plans.push(plan);
      }
    }
  }
  return plans;
}

async function collectPluginDoctorStateMigrationPlans(params: {
  cfg: OpenClawConfig;
  pluginDoctorConfig?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  oauthDir: string;
  includeDoctorOnly?: boolean;
  warnings?: string[];
}): Promise<DetectedPluginDoctorStateMigrationPlan[]> {
  const plans: DetectedPluginDoctorStateMigrationPlan[] = [];
  const config = params.pluginDoctorConfig ?? params.cfg;
  for (const entry of listPluginDoctorStateMigrationEntries({
    config,
    env: params.env,
  })) {
    if (entry.migration.doctorOnly === true && params.includeDoctorOnly !== true) {
      continue;
    }
    let detected: PluginDoctorStateMigrationDetection | null;
    try {
      detected = await entry.migration.detectLegacyState({
        config,
        env: params.env,
        stateDir: params.stateDir,
        oauthDir: params.oauthDir,
        context: createPluginDoctorStateMigrationContext(entry.pluginId, params.env),
      });
    } catch (err) {
      params.warnings?.push(`Failed detecting ${entry.migration.label}: ${String(err)}`);
      continue;
    }
    if (detected?.preview.length) {
      plans.push({
        pluginId: entry.pluginId,
        migration: entry.migration,
        preview: detected.preview,
      });
    }
  }
  return plans;
}

function createPluginDoctorStateMigrationContext(
  pluginId: string,
  env: NodeJS.ProcessEnv,
): PluginDoctorStateMigrationContext {
  return {
    getPluginStateCapacity() {
      return resolvePluginStateCapacity(pluginId, env);
    },
    importPluginStateEntries(
      options: OpenKeyedStoreOptions,
      entries: readonly { key: string; value: unknown; createdAt: number; ttlMs?: number }[],
    ) {
      importPluginStateEntriesForDoctor(pluginId, { ...options, env: options.env ?? env }, entries);
    },
    openPluginStateKeyedStore<T>(options: OpenKeyedStoreOptions) {
      return createPluginStateKeyedStore<T>(pluginId, {
        ...options,
        env: options.env ?? env,
      });
    },
  };
}

function resolveDoctorStateMigrationAgentId(cfg: OpenClawConfig): string {
  try {
    return normalizeAgentId(resolveDefaultAgentId(cfg));
  } catch {
    // Detection must still inspect malformed/pre-roster state so Doctor can repair it.
    return LEGACY_IMPLICIT_AGENT_ID;
  }
}

export async function detectLegacyStateMigrations(params: {
  cfg: OpenClawConfig;
  pluginDoctorConfig?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  pluginSessionStoreAgentIds?: readonly string[];
  sessionStoreOwnership?: SessionStoreOwnership;
  doctorOnlyStateMigrations?: boolean;
}): Promise<LegacyStateDetection> {
  const env = params.env ?? process.env;
  const homedir = params.homedir ?? os.homedir;
  const stateDir = resolveStateDir(env, homedir);
  const oauthDir = resolveOAuthDir(env, stateDir);

  const targetAgentId = resolveDoctorStateMigrationAgentId(params.cfg);
  const rawMainKey = params.cfg.session?.mainKey;
  const targetMainKey =
    typeof rawMainKey === "string" && rawMainKey.trim().length > 0
      ? rawMainKey.trim()
      : DEFAULT_MAIN_KEY;
  const targetScope = params.cfg.session?.scope;

  const sessionsLegacyDir = path.join(stateDir, "sessions");
  const sessionsLegacyStorePath = path.join(sessionsLegacyDir, "sessions.json");
  const sessionsTargetDir = path.join(stateDir, "agents", targetAgentId, "sessions");
  const sessionsTargetStorePath = path.join(sessionsTargetDir, "sessions.json");
  const pluginConfig = params.pluginDoctorConfig ?? params.cfg;
  const pluginSessionStoreAgentIds =
    params.pluginSessionStoreAgentIds ??
    listPluginDoctorSessionStoreAgentIds({
      config: pluginConfig,
      env,
      pluginIds: collectRelevantDoctorPluginIds(pluginConfig),
    });
  const currentSessionStoreOwnership = resolveSessionStoreOwnership({
    cfg: params.cfg,
    env,
    stateDir,
    targetAgentId,
    pluginSessionStoreAgentIds,
  });
  const sessionStoreOwnership: SessionStoreOwnership = {
    preserveAmbiguousKeys:
      params.sessionStoreOwnership?.preserveAmbiguousKeys === true ||
      currentSessionStoreOwnership.preserveAmbiguousKeys,
    preserveForeignMainAliases:
      params.sessionStoreOwnership?.preserveForeignMainAliases === true ||
      currentSessionStoreOwnership.preserveForeignMainAliases,
    targetStoreAliases: mergeSessionStoreAliasPlans(
      params.sessionStoreOwnership?.targetStoreAliases,
      currentSessionStoreOwnership.targetStoreAliases,
    ),
  };
  const { preserveForeignMainAliases } = sessionStoreOwnership;
  const legacySessionEntries = safeReadDir(sessionsLegacyDir);
  const hasLegacySessions =
    fileExists(sessionsLegacyStorePath) ||
    legacySessionEntries.some((e) => e.isFile() && e.name.endsWith(".jsonl"));

  const targetSessionParsed = fileExists(sessionsTargetStorePath)
    ? readSessionStoreJson5(sessionsTargetStorePath)
    : { store: {}, ok: true };
  const legacyKeys = targetSessionParsed.ok
    ? listLegacySessionKeys({
        store: targetSessionParsed.store,
        agentId: targetAgentId,
        mainKey: targetMainKey,
        scope: targetScope,
        preserveAmbiguousKeys: sessionStoreOwnership.preserveAmbiguousKeys,
        preserveForeignMainAliases,
      })
    : [];
  const hasStaleSessionFiles =
    targetSessionParsed.ok &&
    Object.values(targetSessionParsed.store).some((entry) =>
      Boolean(
        resolveStaleLegacySessionFile({
          entry,
          legacyDir: sessionsLegacyDir,
          targetDir: sessionsTargetDir,
        }),
      ),
    );

  const legacyAgentDir = path.join(stateDir, "agent");
  const targetAgentDir = path.join(stateDir, "agents", targetAgentId, "agent");
  const hasLegacyAgentDir = existsDir(legacyAgentDir);
  const pluginStateSidecarPath = resolveLegacyPluginStateSidecarPath(stateDir);
  const hasPluginStateSidecar = fileExists(pluginStateSidecarPath);
  const hasPendingPluginStateSidecarArchive = hasPendingSqliteSidecarArchive(
    pluginStateSidecarPath,
    PLUGIN_STATE_SQLITE_SIDECAR_SUFFIXES,
  );
  const pluginInstallIndexPath = resolveLegacyInstalledPluginIndexStorePath({ stateDir });
  const hasPluginInstallIndex = fileExists(pluginInstallIndexPath);
  const debugProxyCaptureSidecar = detectLegacyDebugProxyCaptureSidecar(stateDir, env);
  const stateSchemaMigrations = detectOpenClawStateDatabaseSchemaMigrations({
    env: { ...env, OPENCLAW_STATE_DIR: stateDir },
  });
  const stateEnv = { ...env, OPENCLAW_STATE_DIR: stateDir };
  const hasLegacyWorktrees =
    params.doctorOnlyStateMigrations === true &&
    stateSchemaMigrations.length === 0 &&
    fileExists(resolveOpenClawStateSqlitePath(stateEnv)) &&
    hasLegacyRegistryWorktrees(stateEnv);
  const taskRunsSidecarPath = resolveLegacyTaskRunsSidecarPath(stateDir);
  const flowRunsSidecarPath = resolveLegacyFlowRunsSidecarPath(stateDir);
  const hasPendingTaskRunsSidecarArchive = hasPendingSqliteSidecarArchive(
    taskRunsSidecarPath,
    TASK_STATE_SQLITE_SIDECAR_SUFFIXES,
  );
  const hasPendingFlowRunsSidecarArchive = hasPendingSqliteSidecarArchive(
    flowRunsSidecarPath,
    TASK_STATE_SQLITE_SIDECAR_SUFFIXES,
  );
  const hasTaskStateSidecars =
    fileExists(taskRunsSidecarPath) ||
    fileExists(flowRunsSidecarPath) ||
    hasPendingTaskRunsSidecarArchive ||
    hasPendingFlowRunsSidecarArchive;
  const deliveryQueuePaths = {
    outboundPath: resolveLegacyDeliveryQueuePath(stateDir, "delivery-queue"),
    sessionPath: resolveLegacyDeliveryQueuePath(stateDir, "session-delivery-queue"),
  };
  const hasDeliveryQueues =
    listLegacyDeliveryQueueFiles(deliveryQueuePaths.outboundPath).length > 0 ||
    listLegacyDeliveryQueueDeliveredMarkers(deliveryQueuePaths.outboundPath).length > 0 ||
    listLegacyDeliveryQueueFiles(deliveryQueuePaths.sessionPath).length > 0 ||
    listLegacyDeliveryQueueDeliveredMarkers(deliveryQueuePaths.sessionPath).length > 0;
  const voiceWake = {
    triggersPath: resolveLegacyVoiceWakeTriggersPath(stateDir),
    routingPath: resolveLegacyVoiceWakeRoutingPath(stateDir),
  };
  const hasVoiceWake = fileExists(voiceWake.triggersPath) || fileExists(voiceWake.routingPath);
  const updateCheck = {
    sourcePath: resolveLegacyUpdateCheckPath(stateDir),
  };
  const hasUpdateCheck = fileExists(updateCheck.sourcePath);
  const configHealth = {
    sourcePath: resolveLegacyConfigHealthPath(stateDir),
  };
  const hasConfigHealth = fileExists(configHealth.sourcePath);
  const pluginBindingApprovals = {
    sourcePath: resolveLegacyPluginBindingApprovalsPath(env, homedir),
  };
  const hasPluginBindingApprovals =
    path.resolve(path.dirname(pluginBindingApprovals.sourcePath)) === path.resolve(stateDir) &&
    fileExists(pluginBindingApprovals.sourcePath);
  const currentConversationBindings = {
    sourcePath: resolveLegacyCurrentConversationBindingsPath(stateDir),
  };
  const hasCurrentConversationBindings = fileExists(currentConversationBindings.sourcePath);
  const tuiLastSessions = detectLegacyTuiLastSessions({
    stateDir,
    doctorOnlyStateMigrations: params.doctorOnlyStateMigrations,
  });
  const commitments = detectLegacyCommitments({
    stateDir,
    doctorOnlyStateMigrations: params.doctorOnlyStateMigrations,
  });
  const auditLogs = detectLegacyAuditLogs({
    stateDir,
    doctorOnlyStateMigrations: params.doctorOnlyStateMigrations,
  });
  const acpReplayLedger = detectLegacyAcpReplayLedger({
    stateDir,
    doctorOnlyStateMigrations: params.doctorOnlyStateMigrations,
  });
  const managedOutgoingImages = detectLegacyManagedOutgoingImages({
    stateDir,
    doctorOnlyStateMigrations: params.doctorOnlyStateMigrations,
  });
  const apns = detectLegacyApnsRegistrations({
    stateDir,
    doctorOnlyStateMigrations: params.doctorOnlyStateMigrations,
  });
  const deviceAuth = detectLegacyDeviceAuth({
    stateDir,
    doctorOnlyStateMigrations: params.doctorOnlyStateMigrations,
  });
  const deviceIdentity = detectLegacyDeviceIdentity({
    stateDir,
    env,
    doctorOnlyStateMigrations: params.doctorOnlyStateMigrations,
  });
  const execApprovals = detectLegacyExecApprovals({
    stateDir,
    doctorOnlyStateMigrations: params.doctorOnlyStateMigrations,
  });
  const mcpOauth = detectLegacyMcpOAuthStores({
    stateDir,
    doctorOnlyStateMigrations: params.doctorOnlyStateMigrations,
  });
  const meetingTranscripts = detectLegacyMeetingTranscripts({
    stateDir,
    env,
    doctorOnlyStateMigrations: params.doctorOnlyStateMigrations,
  });
  const restartSentinel = detectLegacyRestartSentinel({ stateDir });
  const workspace = detectLegacyWorkspaceState({
    cfg: params.cfg,
    stateDir,
    env,
    homedir,
    doctorOnlyStateMigrations: params.doctorOnlyStateMigrations,
  });
  const webPush = detectLegacyWebPush({
    stateDir,
    doctorOnlyStateMigrations: params.doctorOnlyStateMigrations,
  });
  const nodeHost = detectLegacyNodeHostConfig({
    stateDir,
    doctorOnlyStateMigrations: params.doctorOnlyStateMigrations,
  });
  const subagentRegistry = detectLegacySubagentRegistry({
    stateDir,
    doctorOnlyStateMigrations: params.doctorOnlyStateMigrations,
  });
  const rescuePending = detectLegacyRescuePending({
    stateDir,
    doctorOnlyStateMigrations: params.doctorOnlyStateMigrations,
  });
  const configuredChannels = Object.entries(params.cfg.channels ?? {});
  const configuredAccountIds = Object.fromEntries(
    configuredChannels.map(([channelId, value]) => {
      const channelConfig =
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as { accounts?: unknown; defaultAccount?: unknown })
          : undefined;
      const plugin = getChannelPlugin(channelId as ChannelId);
      const accountIds = [
        ...(plugin?.config.listAccountIds(params.cfg) ?? []),
        ...(channelConfig?.accounts &&
        typeof channelConfig.accounts === "object" &&
        !Array.isArray(channelConfig.accounts)
          ? Object.keys(channelConfig.accounts)
          : []),
        ...(typeof channelConfig?.defaultAccount === "string"
          ? [channelConfig.defaultAccount]
          : []),
        ...(params.cfg.bindings ?? []).flatMap((binding) =>
          binding.match?.channel === channelId && typeof binding.match.accountId === "string"
            ? [binding.match.accountId]
            : [],
        ),
      ];
      return [
        channelId,
        Array.from(new Set(accountIds.map((entry) => entry.trim()).filter(Boolean))),
      ];
    }),
  );
  const channelPairing = detectLegacyChannelPairingState({
    sourceDir: oauthDir,
    configuredChannelIds: configuredChannels.map(([channelId]) => channelId),
    configuredDefaultAccountIds: Object.fromEntries(
      configuredChannels.flatMap(([channelId, value]) => {
        const boundAccountId = params.cfg.bindings?.find(
          (binding) =>
            normalizeAgentId(binding.agentId) === targetAgentId &&
            binding.match?.channel === channelId &&
            typeof binding.match.accountId === "string",
        )?.match.accountId;
        if (typeof boundAccountId === "string" && boundAccountId.trim()) {
          return [[channelId, boundAccountId.trim()]];
        }
        const defaultAccount =
          value && typeof value === "object" && !Array.isArray(value)
            ? (value as { defaultAccount?: unknown }).defaultAccount
            : undefined;
        if (typeof defaultAccount === "string" && defaultAccount.trim()) {
          return [[channelId, defaultAccount.trim()]];
        }
        const plugin = getChannelPlugin(channelId as ChannelId);
        if (plugin) {
          return [[channelId, resolveChannelDefaultAccountId({ plugin, cfg: params.cfg })]];
        }
        return [[channelId, configuredAccountIds[channelId]?.toSorted()[0] ?? DEFAULT_ACCOUNT_ID]];
      }),
    ),
    configuredAccountIds,
  });
  const channelPlans = await collectChannelLegacyStateMigrationPlans({
    cfg: params.cfg,
    env,
    stateDir,
    oauthDir,
  });
  const pluginPlanWarnings: string[] = [];
  const pluginPlans =
    stateSchemaMigrations.length > 0
      ? []
      : await collectPluginDoctorStateMigrationPlans({
          cfg: params.cfg,
          pluginDoctorConfig: params.pluginDoctorConfig,
          env,
          stateDir,
          oauthDir,
          includeDoctorOnly: params.doctorOnlyStateMigrations === true,
          warnings: pluginPlanWarnings,
        });

  const preview: string[] = [];
  if (hasLegacySessions) {
    preview.push(`- Sessions: ${sessionsLegacyDir} → ${sessionsTargetDir}`);
  }
  if (legacyKeys.length > 0) {
    preview.push(`- Sessions: canonicalize legacy keys in ${sessionsTargetStorePath}`);
  }
  if (hasStaleSessionFiles) {
    preview.push(`- Sessions: repair migrated transcript paths in ${sessionsTargetStorePath}`);
  }
  if (hasLegacyAgentDir) {
    preview.push(`- Agent dir: ${legacyAgentDir} → ${targetAgentDir}`);
  }
  if (hasPluginStateSidecar) {
    preview.push(`- Plugin state sidecar: ${pluginStateSidecarPath} → shared SQLite state`);
  } else if (hasPendingPluginStateSidecarArchive) {
    preview.push(`- Plugin state sidecar: finish archive cleanup for ${pluginStateSidecarPath}`);
  }
  if (hasPluginInstallIndex) {
    preview.push(`- Plugin install index: ${pluginInstallIndexPath} → shared SQLite state`);
  }
  if (debugProxyCaptureSidecar.hasLegacy) {
    preview.push(
      `- Debug proxy capture sidecar: ${debugProxyCaptureSidecar.sourcePath} → shared SQLite state`,
    );
  }
  if (stateSchemaMigrations.length > 0) {
    for (const migration of stateSchemaMigrations) {
      preview.push(`- Shared SQLite schema: ${describeStateSchemaMigration(migration)}`);
    }
    preview.push(
      "- Rerun doctor after shared SQLite schema repair to detect plugin state migrations",
    );
  }
  if (hasLegacyWorktrees) {
    preview.push("- Managed worktrees: discard rows without provisioned-file ledgers");
  }
  if (fileExists(taskRunsSidecarPath)) {
    preview.push(`- Task registry sidecar: ${taskRunsSidecarPath} → shared SQLite state`);
  } else if (hasPendingTaskRunsSidecarArchive) {
    preview.push(`- Task registry sidecar: finish archive cleanup for ${taskRunsSidecarPath}`);
  }
  if (fileExists(flowRunsSidecarPath)) {
    preview.push(`- Task flow sidecar: ${flowRunsSidecarPath} → shared SQLite state`);
  } else if (hasPendingFlowRunsSidecarArchive) {
    preview.push(`- Task flow sidecar: finish archive cleanup for ${flowRunsSidecarPath}`);
  }
  if (hasDeliveryQueues) {
    preview.push("- Delivery queues: legacy JSON queue files → shared SQLite state");
  }
  if (hasVoiceWake) {
    preview.push("- Voice Wake settings: legacy JSON files → shared SQLite state");
  }
  if (hasUpdateCheck) {
    preview.push("- Update-check state: legacy JSON file → shared SQLite state");
  }
  if (hasConfigHealth) {
    preview.push("- Config health state: legacy JSON file → shared SQLite state");
  }
  if (hasPluginBindingApprovals) {
    preview.push("- Plugin binding approvals: legacy JSON file → shared SQLite state");
  }
  if (hasCurrentConversationBindings) {
    preview.push("- Current-conversation bindings: legacy JSON file → shared SQLite state");
  }
  if (tuiLastSessions.hasLegacy) {
    preview.push("- TUI last-session pointers: legacy JSON file → shared SQLite state");
  }
  if (commitments.hasLegacy) {
    preview.push("- Commitments: legacy JSON file → shared SQLite state");
  }
  for (const source of auditLogs.sources) {
    preview.push(`- ${source.label}: legacy JSONL file → shared SQLite state`);
  }
  if (acpReplayLedger.hasLegacy) {
    preview.push("- ACP replay ledger: legacy JSON file → shared SQLite state");
  }
  if (managedOutgoingImages.hasLegacy) {
    preview.push("- Managed outgoing images: legacy record JSON → shared SQLite state");
  }
  if (apns.hasLegacy) {
    preview.push("- APNs registrations: legacy JSON → shared SQLite state");
  }
  if (deviceAuth.hasLegacy) {
    preview.push("- Device auth tokens: legacy JSON → shared SQLite state");
  }
  if (deviceIdentity.hasLegacy) {
    preview.push("- Primary device identity: legacy JSON → shared SQLite state");
  }
  if (deviceIdentity.hasInvalidCanonical && !deviceIdentity.hasLegacy) {
    preview.push("- Primary device identity: invalid SQLite row → new device identity");
  }
  if (execApprovals.hasLegacy) {
    preview.push("- Exec approvals: legacy JSON → shared SQLite state");
  }
  if (mcpOauth.hasLegacy) {
    preview.push("- MCP OAuth credentials: legacy JSON → shared SQLite state");
  }
  if (meetingTranscripts.hasLegacy) {
    preview.push("- Meeting transcripts: legacy JSON/JSONL files → shared SQLite state");
  }
  if (restartSentinel.hasLegacy) {
    preview.push("- Restart sentinel: legacy JSON → shared SQLite state");
  }
  if (workspace.hasLegacy) {
    preview.push("- Workspace setup and attestations: legacy files → shared SQLite state");
  }
  if (webPush.hasLegacy) {
    preview.push("- Web Push subscriptions and VAPID identity: legacy JSON → shared SQLite state");
  }
  if (nodeHost.hasLegacy) {
    preview.push("- Node-host config: legacy node.json → shared SQLite state");
  }
  if (subagentRegistry.hasLegacy) {
    preview.push("- Subagent runs: discard retired transient subagents/runs.json state");
  }
  if (rescuePending.hasLegacy) {
    preview.push("- System-agent rescue approvals: discard retired pending JSON capabilities");
  }
  if (channelPairing.hasLegacy) {
    preview.push("- Channel pairing state: legacy JSON files → shared SQLite state");
  }
  if (channelPlans.length > 0) {
    preview.push(...channelPlans.map(buildLegacyMigrationPreview));
  }
  if (pluginPlans.length > 0) {
    preview.push(...pluginPlans.flatMap((plan) => plan.preview));
  }

  return {
    doctorOnlyStateMigrations: params.doctorOnlyStateMigrations === true,
    targetAgentId,
    targetMainKey,
    targetScope,
    stateDir,
    oauthDir,
    sessions: {
      legacyDir: sessionsLegacyDir,
      legacyStorePath: sessionsLegacyStorePath,
      targetDir: sessionsTargetDir,
      targetStorePath: sessionsTargetStorePath,
      hasLegacy: hasLegacySessions || legacyKeys.length > 0 || hasStaleSessionFiles,
      legacyKeys,
      preserveAmbiguousKeys: sessionStoreOwnership.preserveAmbiguousKeys,
      preserveForeignMainAliases,
      targetStoreAliases: sessionStoreOwnership.targetStoreAliases,
    },
    agentDir: {
      legacyDir: legacyAgentDir,
      targetDir: targetAgentDir,
      hasLegacy: hasLegacyAgentDir,
    },
    channelPlans: {
      hasLegacy: channelPlans.length > 0,
      plans: channelPlans,
    },
    pluginPlans: {
      hasLegacy: pluginPlans.length > 0,
      plans: pluginPlans,
    },
    pluginStateSidecar: {
      sourcePath: pluginStateSidecarPath,
      hasLegacy: hasPluginStateSidecar || hasPendingPluginStateSidecarArchive,
    },
    pluginInstallIndex: {
      sourcePath: pluginInstallIndexPath,
      hasLegacy: hasPluginInstallIndex,
    },
    debugProxyCaptureSidecar,
    stateSchema: {
      hasLegacy: stateSchemaMigrations.length > 0,
      preview: stateSchemaMigrations.map((migration) => migration.path),
    },
    worktrees: { hasLegacy: hasLegacyWorktrees },
    taskStateSidecars: {
      taskRunsPath: taskRunsSidecarPath,
      flowRunsPath: flowRunsSidecarPath,
      hasLegacy: hasTaskStateSidecars,
    },
    deliveryQueues: {
      ...deliveryQueuePaths,
      hasLegacy: hasDeliveryQueues,
    },
    voiceWake: {
      ...voiceWake,
      hasLegacy: hasVoiceWake,
    },
    updateCheck: {
      ...updateCheck,
      hasLegacy: hasUpdateCheck,
    },
    configHealth: {
      ...configHealth,
      hasLegacy: hasConfigHealth,
    },
    pluginBindingApprovals: {
      ...pluginBindingApprovals,
      hasLegacy: hasPluginBindingApprovals,
    },
    currentConversationBindings: {
      ...currentConversationBindings,
      hasLegacy: hasCurrentConversationBindings,
    },
    tuiLastSessions,
    commitments,
    auditLogs,
    acpReplayLedger,
    managedOutgoingImages,
    apns,
    deviceAuth,
    deviceIdentity,
    execApprovals,
    mcpOauth,
    meetingTranscripts,
    restartSentinel,
    workspace,
    webPush,
    nodeHost,
    subagentRegistry,
    rescuePending,
    channelPairing,
    warnings: pluginPlanWarnings,
    notices: [],
    preview,
  };
}

async function runPluginDoctorStateMigrationPlans(params: {
  detected: LegacyStateDetection;
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): Promise<MigrationMessages> {
  const changes: string[] = [];
  const warnings: string[] = [];
  const notices: string[] = [];
  const refreshedPlans = await collectPluginDoctorStateMigrationPlans({
    cfg: params.config,
    env: params.env,
    stateDir: params.detected.stateDir,
    oauthDir: params.detected.oauthDir,
    includeDoctorOnly: params.detected.doctorOnlyStateMigrations,
    warnings,
  });
  const hasDetectorFailure = warnings.length > 0;
  // Previously detected plans are only safe when refresh found no current work.
  // If any detector failed, skip stale plans instead of migrating on old assumptions.
  const plans =
    refreshedPlans.length > 0 || hasDetectorFailure
      ? refreshedPlans
      : (params.detected.pluginPlans?.plans ?? []);
  const migrated = await migratePluginDoctorStatePlans({
    plans,
    config: params.config,
    env: params.env,
    stateDir: params.detected.stateDir,
    oauthDir: params.detected.oauthDir,
  });
  changes.push(...migrated.changes);
  warnings.push(...migrated.warnings);
  notices.push(...(migrated.notices ?? []));
  return notices.length > 0 ? { changes, warnings, notices } : { changes, warnings };
}

async function migratePluginDoctorStatePlans(params: {
  plans: readonly DetectedPluginDoctorStateMigrationPlan[];
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  oauthDir: string;
}): Promise<MigrationMessages> {
  const changes: string[] = [];
  const warnings: string[] = [];
  const notices: string[] = [];
  if (params.plans.length === 0) {
    return { changes, warnings };
  }

  let lock: Awaited<ReturnType<typeof acquireGatewayLock>>;
  try {
    lock = await acquireGatewayLock({
      allowInTests: true,
      env: { ...params.env, OPENCLAW_STATE_DIR: params.stateDir },
      pollIntervalMs: PLUGIN_DOCTOR_MIGRATION_LOCK_POLL_INTERVAL_MS,
      role: "sqlite-maintenance",
      timeoutMs: PLUGIN_DOCTOR_MIGRATION_LOCK_TIMEOUT_MS,
    });
  } catch (error) {
    return {
      changes,
      warnings: [
        `Skipped plugin doctor state migrations because exclusive state ownership is unavailable: ${String(error)}`,
      ],
    };
  }
  if (!lock) {
    return {
      changes,
      warnings: [
        "Skipped plugin doctor state migrations because exclusive state ownership is unavailable",
      ],
    };
  }

  try {
    // Plugin migrations may claim retired files after verified import. Keep the
    // predecessor Gateway excluded for the full read, import, and archive window.
    for (const plan of params.plans) {
      try {
        const result = await plan.migration.migrateLegacyState({
          config: params.config,
          env: params.env,
          stateDir: params.stateDir,
          oauthDir: params.oauthDir,
          context: createPluginDoctorStateMigrationContext(plan.pluginId, params.env),
        });
        changes.push(...result.changes);
        warnings.push(...result.warnings);
        notices.push(...(result.notices ?? []));
      } catch (err) {
        warnings.push(`Failed migrating ${plan.migration.label}: ${String(err)}`);
      }
    }
  } finally {
    await lock.release();
  }
  return notices.length > 0 ? { changes, warnings, notices } : { changes, warnings };
}

export async function autoMigrateLegacyPluginDoctorState(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  log?: MigrationLogger;
}): Promise<{
  migrated: boolean;
  skipped: boolean;
  changes: string[];
  warnings: string[];
  notices?: string[];
}> {
  const env = params.env ?? process.env;
  const stateDirResult = await autoMigrateLegacyStateDir({
    env,
    homedir: params.homedir,
    log: params.log,
  });
  const stateDir = resolveStateDir(env, params.homedir ?? os.homedir);
  const oauthDir = resolveOAuthDir(env, stateDir);
  const stateSchema = repairOpenClawStateDatabaseSchemaIfNeeded({
    env: { ...env, OPENCLAW_STATE_DIR: stateDir },
  });
  const changes = [...stateDirResult.changes, ...stateSchema.changes];
  const warnings = [...stateDirResult.warnings, ...stateSchema.warnings];
  const notices = [...(stateDirResult.notices ?? [])];
  if (stateSchema.warnings.length > 0) {
    return {
      migrated: stateDirResult.migrated || stateSchema.changes.length > 0,
      skipped: false,
      changes,
      warnings,
      ...(notices.length > 0 ? { notices } : {}),
    };
  }
  const plans = await collectPluginDoctorStateMigrationPlans({
    cfg: params.config,
    env,
    stateDir,
    oauthDir,
    warnings,
  });
  const migrated = await migratePluginDoctorStatePlans({
    plans,
    config: params.config,
    env,
    stateDir,
    oauthDir,
  });
  changes.push(...migrated.changes);
  warnings.push(...migrated.warnings);
  notices.push(...(migrated.notices ?? []));
  return {
    migrated: stateDirResult.migrated || stateSchema.changes.length > 0 || plans.length > 0,
    skipped: false,
    changes,
    warnings,
    ...(notices.length > 0 ? { notices } : {}),
  };
}

function migrateLegacyStateSchema(
  detected: LegacyStateDetection,
  env: NodeJS.ProcessEnv,
): {
  changes: string[];
  warnings: string[];
} {
  return repairOpenClawStateDatabaseSchema({
    env: { ...env, OPENCLAW_STATE_DIR: detected.stateDir },
  });
}

type LegacyStateMigrationStep = {
  phase: "shared" | "final";
  kind?: "acp-session-metadata";
  collectNotices?: boolean;
  run: () => MigrationMessages | Promise<MigrationMessages>;
};

type LegacyStateMigrationPlan = {
  mode: "doctor" | "automatic";
  detected: LegacyStateDetection;
  config: OpenClawConfig;
  sessionConfig?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  now?: () => number;
  pluginSessionStoreAgentIds?: readonly string[];
  recoverCorruptTargetStore?: boolean;
  doctorOnlyStateMigrations?: boolean;
  skipAgentScopedMigrations?: boolean;
};

function buildLegacyStateMigrationSteps(
  params: LegacyStateMigrationPlan,
): LegacyStateMigrationStep[] {
  const { detected, env } = params;
  const stateDir = detected.stateDir;
  const now = params.now ?? (() => Date.now());
  const isDoctor = params.mode === "doctor";
  const sharedStep = (
    run: LegacyStateMigrationStep["run"],
    collectNotices = false,
  ): LegacyStateMigrationStep => ({ phase: "shared", run, collectNotices });
  const finalStep = (
    run: LegacyStateMigrationStep["run"],
    collectNotices = false,
  ): LegacyStateMigrationStep => ({ phase: "final", run, collectNotices });

  const doctorPrelude: LegacyStateMigrationStep[] = isDoctor
    ? [
        finalStep(() => {
          const discardedWorktrees = detected.worktrees.hasLegacy
            ? discardLegacyRegistryWorktrees({ ...env, OPENCLAW_STATE_DIR: stateDir })
            : 0;
          return {
            changes:
              discardedWorktrees > 0
                ? [
                    `Discarded ${discardedWorktrees} legacy managed worktree ${discardedWorktrees === 1 ? "row" : "rows"}; affected worktrees will provision fresh on next use`,
                  ]
                : [],
            warnings: [],
          };
        }),
      ]
    : [];

  const sharedSteps: LegacyStateMigrationStep[] = [
    sharedStep(() => migrateLegacyPluginStateSidecar({ stateDir })),
    sharedStep(() => migrateLegacyInstalledPluginIndex({ stateDir }), true),
    sharedStep(() =>
      migrateLegacyDebugProxyCaptureSidecar({
        stateDir,
        detected: detected.debugProxyCaptureSidecar,
      }),
    ),
    sharedStep(() => migrateLegacyTaskStateSidecars({ stateDir })),
    sharedStep(() => migrateLegacyDeliveryQueues({ stateDir })),
    sharedStep(() => migrateLegacyVoiceWakeSettings({ detected: detected.voiceWake, stateDir })),
    sharedStep(
      () => migrateLegacyUpdateCheckState({ detected: detected.updateCheck, stateDir }),
      true,
    ),
    sharedStep(() => migrateLegacyConfigHealth({ detected: detected.configHealth, stateDir })),
    sharedStep(() =>
      migrateLegacyPluginBindingApprovals({
        detected: detected.pluginBindingApprovals,
        stateDir,
      }),
    ),
    sharedStep(() =>
      migrateLegacyCurrentConversationBindings({
        detected: detected.currentConversationBindings,
        stateDir,
      }),
    ),
  ];

  const doctorStateSteps: LegacyStateMigrationStep[] = isDoctor
    ? [
        finalStep(
          () => migrateLegacyTuiLastSessions({ detected: detected.tuiLastSessions, stateDir }),
          true,
        ),
        finalStep(
          () => migrateLegacyCommitments({ detected: detected.commitments, stateDir }),
          true,
        ),
        finalStep(() => migrateLegacyAuditLogs({ detected: detected.auditLogs, stateDir }), true),
        finalStep(
          () => migrateLegacyAcpReplayLedger({ detected: detected.acpReplayLedger, stateDir }),
          true,
        ),
        finalStep(
          () =>
            migrateLegacyManagedOutgoingImages({
              detected: detected.managedOutgoingImages,
              stateDir,
            }),
          true,
        ),
        finalStep(
          () => migrateLegacyApnsRegistrations({ detected: detected.apns, env, stateDir }),
          true,
        ),
        finalStep(
          () => migrateLegacyDeviceAuth({ detected: detected.deviceAuth, env, stateDir }),
          true,
        ),
        finalStep(
          () =>
            migrateLegacyDeviceIdentity({
              detected: detected.deviceIdentity,
              env,
              stateDir,
              doctorOnlyStateMigrations: params.doctorOnlyStateMigrations,
            }),
          true,
        ),
        finalStep(
          () => migrateLegacyExecApprovals({ detected: detected.execApprovals, env, stateDir }),
          true,
        ),
        finalStep(
          () => migrateLegacyMcpOAuthStores({ detected: detected.mcpOauth, env, stateDir }),
          true,
        ),
        finalStep(
          () =>
            migrateLegacyMeetingTranscripts({
              detected: detected.meetingTranscripts,
              env,
              stateDir,
              now,
            }),
          true,
        ),
      ]
    : [];

  const doctorFinalSteps: LegacyStateMigrationStep[] = isDoctor
    ? [
        finalStep(
          () => migrateLegacyWorkspaceState({ detected: detected.workspace, env, stateDir }),
          true,
        ),
        finalStep(() => migrateLegacyWebPush({ detected: detected.webPush, env, stateDir }), true),
        finalStep(
          () => migrateLegacyNodeHostConfig({ detected: detected.nodeHost, env, stateDir }),
          true,
        ),
        finalStep(
          () =>
            migrateLegacySubagentRegistry({ detected: detected.subagentRegistry, env, stateDir }),
          true,
        ),
        finalStep(() => discardLegacyRescuePending({ detected: detected.rescuePending, stateDir })),
      ]
    : [];

  const finalSteps: LegacyStateMigrationStep[] = [
    finalStep(
      () => migrateLegacyRestartSentinel({ detected: detected.restartSentinel, env, stateDir }),
      true,
    ),
    ...doctorFinalSteps,
    finalStep(() =>
      migrateLegacyChannelPairingState({
        detected: detected.channelPairing,
        env: { ...env, OPENCLAW_STATE_DIR: stateDir },
      }),
    ),
    finalStep(() =>
      runLegacyMigrationPlans(
        detected.channelPlans.plans.filter((plan) => plan.kind === "plugin-state-import"),
      ),
    ),
    finalStep(
      () =>
        isDoctor && detected.stateSchema.hasLegacy
          ? { changes: [], warnings: [] }
          : runPluginDoctorStateMigrationPlans({ detected, config: params.config, env }),
      true,
    ),
  ];

  if (!params.skipAgentScopedMigrations) {
    // ACP metadata must run once after sessions are canonicalized; otherwise
    // existing rows and newly imported rows generate conflicting repeat warnings.
    finalSteps.push(
      finalStep(() =>
        migrateLegacySessions(detected, now, {
          recoverCorruptTargetStore: params.recoverCorruptTargetStore,
        }),
      ),
      {
        ...finalStep(() =>
          migrateLegacyAcpSessionMetadata({
            cfg: params.sessionConfig ?? params.config,
            env: isDoctor ? { ...env, OPENCLAW_STATE_DIR: stateDir } : env,
            now,
            ...(isDoctor ? {} : { pluginSessionStoreAgentIds: params.pluginSessionStoreAgentIds }),
          }),
        ),
        kind: "acp-session-metadata",
      },
      finalStep(() => migrateLegacyAgentDir(detected, now)),
      finalStep(() =>
        runLegacyMigrationPlans(
          detected.channelPlans.plans.filter((plan) => plan.kind !== "plugin-state-import"),
        ),
      ),
    );
  }

  return [...doctorPrelude, ...sharedSteps, ...doctorStateSteps, ...finalSteps];
}

async function runLegacyStateMigrationSteps(steps: readonly LegacyStateMigrationStep[]): Promise<{
  sources: MigrationMessages[];
  sharedSources: MigrationMessages[];
  finalSources: MigrationMessages[];
  sharedNoticeSources: MigrationMessages[];
  finalNoticeSources: MigrationMessages[];
}> {
  const sources: MigrationMessages[] = [];
  const sharedSources: MigrationMessages[] = [];
  const finalSources: MigrationMessages[] = [];
  const sharedNoticeSources: MigrationMessages[] = [];
  const finalNoticeSources: MigrationMessages[] = [];

  // Later owners require the SQLite commit and verified source archive of
  // every preceding owner; migration planning must never run steps in parallel.
  for (const step of steps) {
    const result = await step.run();
    sources.push(result);
    (step.phase === "shared" ? sharedSources : finalSources).push(result);
    if (step.collectNotices) {
      (step.phase === "shared" ? sharedNoticeSources : finalNoticeSources).push(result);
    }
  }

  return { sources, sharedSources, finalSources, sharedNoticeSources, finalNoticeSources };
}

export async function runLegacyStateMigrations(params: {
  detected: LegacyStateDetection;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  recoverCorruptTargetStore?: boolean;
  doctorOnlyStateMigrations?: boolean;
}): Promise<MigrationMessages> {
  const detected = params.detected;
  const env = params.env ?? process.env;
  const stateSchema = migrateLegacyStateSchema(detected, env);
  if (detected.stateSchema.hasLegacy && stateSchema.warnings.length > 0) {
    return stateSchema;
  }

  const migrations = await runLegacyStateMigrationSteps(
    buildLegacyStateMigrationSteps({
      mode: "doctor",
      detected,
      config: params.config ?? ({} as OpenClawConfig),
      env,
      now: params.now,
      recoverCorruptTargetStore: params.recoverCorruptTargetStore,
      doctorOnlyStateMigrations: params.doctorOnlyStateMigrations,
    }),
  );
  const notices = mergeNotices([
    ...migrations.sharedNoticeSources,
    ...migrations.finalNoticeSources,
  ]);
  return {
    changes: [...stateSchema.changes, ...migrations.sources.flatMap((source) => source.changes)],
    warnings: [
      ...stateSchema.warnings,
      ...detected.warnings,
      ...migrations.sources.flatMap((source) => source.warnings),
    ],
    ...(notices.length > 0 ? { notices } : {}),
  };
}

/**
 * Canonicalize orphaned raw session keys in all known agent session stores.
 *
 * Keys written by resolveSessionKey() used DEFAULT_AGENT_ID="main" regardless
 * of the configured default agent; reads always use resolveSessionStoreKey()
 * which canonicalizes via canonicalizeMainSessionAlias. This migration renames
 * any orphaned raw keys to their canonical form in-place, merging with any
 * existing canonical entry by preferring the most recently updated.
 *
 * Safe to run multiple times (idempotent). See #29683.
 */
export async function autoMigrateLegacyState(params: {
  cfg: OpenClawConfig;
  pluginDoctorConfig?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  log?: MigrationLogger;
  now?: () => number;
  recoverCorruptTargetStore?: boolean;
  doctorOnlyStateMigrations?: boolean;
}): Promise<{
  migrated: boolean;
  skipped: boolean;
  changes: string[];
  warnings: string[];
  notices?: string[];
}> {
  const env = params.env ?? process.env;
  const homedir = params.homedir ?? os.homedir;
  const migrationMode = params.doctorOnlyStateMigrations === true ? "doctor-repair" : "automatic";
  const initialStateDir = resolveStateDir(env, homedir);
  const checkKey = `${path.resolve(initialStateDir)}\0${migrationMode}`;
  if (autoMigrateChecked.has(checkKey)) {
    return { migrated: false, skipped: true, changes: [], warnings: [] };
  }
  autoMigrateChecked.add(checkKey);

  const stateDirResult = await autoMigrateLegacyStateDir({
    env,
    homedir,
    log: params.log,
  });
  const stateDir = resolveStateDir(env, homedir);
  autoMigrateChecked.add(`${path.resolve(stateDir)}\0${migrationMode}`);
  const stateSchemaOptions = { env: { ...env, OPENCLAW_STATE_DIR: stateDir } };
  const stateSchema =
    params.doctorOnlyStateMigrations === true
      ? repairOpenClawStateDatabaseSchema(stateSchemaOptions)
      : repairOpenClawStateDatabaseSchemaIfNeeded(stateSchemaOptions);
  if (stateSchema.warnings.length > 0) {
    return {
      migrated: stateDirResult.migrated || stateSchema.changes.length > 0,
      skipped: false,
      changes: [...stateDirResult.changes, ...stateSchema.changes],
      warnings: [...stateDirResult.warnings, ...stateSchema.warnings],
      ...(stateDirResult.notices?.length ? { notices: stateDirResult.notices } : {}),
    };
  }
  const mediaPersistence =
    params.doctorOnlyStateMigrations === true
      ? migrateLegacyMediaPersistence({ env: { ...env, OPENCLAW_STATE_DIR: stateDir } })
      : { changes: [], warnings: [] };
  if (mediaPersistence.warnings.length > 0) {
    return {
      migrated:
        stateDirResult.migrated ||
        stateSchema.changes.length > 0 ||
        mediaPersistence.changes.length > 0,
      skipped: false,
      changes: [...stateDirResult.changes, ...stateSchema.changes, ...mediaPersistence.changes],
      warnings: [...stateDirResult.warnings, ...stateSchema.warnings, ...mediaPersistence.warnings],
      ...(stateDirResult.notices?.length ? { notices: stateDirResult.notices } : {}),
    };
  }
  const pluginDoctorConfig = params.pluginDoctorConfig ?? params.cfg;
  const configMachineState = migrateLegacyConfigMachineState({
    config: pluginDoctorConfig,
    env: { ...env, OPENCLAW_STATE_DIR: stateDir },
  });
  const pluginSessionStoreAgentIds = listPluginDoctorSessionStoreAgentIds({
    config: pluginDoctorConfig,
    env,
    pluginIds: collectRelevantDoctorPluginIds(pluginDoctorConfig),
  });
  // Capture ownership before orphan-key rewrites. Atomic replacement can split
  // a configured filesystem alias from the standard target pathname.
  const sessionStoreOwnership = resolveSessionStoreOwnership({
    cfg: params.cfg,
    env,
    stateDir,
    targetAgentId: normalizeAgentId(resolveDefaultAgentId(params.cfg)),
    pluginSessionStoreAgentIds,
  });
  // Canonicalize orphaned session keys regardless of whether legacy migration
  // is needed — the orphan-key bug (#29683) affects all installs with
  // non-default agent IDs or mainKey configuration.
  const orphanKeys = await migrateOrphanedSessionKeys({
    cfg: params.cfg,
    env,
    additionalAgentIds: pluginSessionStoreAgentIds,
  });

  const logMigrationResults = (changes: string[], warnings: string[], notices: string[]) => {
    const logger = params.log ?? createSubsystemLogger("state-migrations");
    if (changes.length > 0) {
      logger.info(
        `Auto-migrated legacy state:\n${changes.map((entry) => `- ${entry}`).join("\n")}`,
      );
    }
    if (warnings.length > 0) {
      logger.warn(
        `Legacy state migration warnings:\n${warnings.map((entry) => `- ${entry}`).join("\n")}`,
      );
    }
    if (notices.length > 0) {
      logger.info(
        `Legacy state migration notes:\n${notices.map((entry) => `- ${entry}`).join("\n")}`,
      );
    }
  };

  const detected = await detectLegacyStateMigrations({
    cfg: params.cfg,
    pluginDoctorConfig: params.pluginDoctorConfig,
    pluginSessionStoreAgentIds,
    sessionStoreOwnership,
    env,
    homedir: params.homedir,
    doctorOnlyStateMigrations: params.doctorOnlyStateMigrations,
  });
  const deviceAuth = await migrateLegacyDeviceAuth({
    detected: detected.deviceAuth,
    env,
    stateDir: detected.stateDir,
  });
  const deviceIdentity = await migrateLegacyDeviceIdentity({
    detected: detected.deviceIdentity,
    env,
    stateDir: detected.stateDir,
    doctorOnlyStateMigrations: params.doctorOnlyStateMigrations,
  });
  const meetingTranscripts = await migrateLegacyMeetingTranscripts({
    detected: detected.meetingTranscripts,
    env,
    stateDir: detected.stateDir,
    now: params.now,
  });
  const hasCustomAgentDir = env.OPENCLAW_AGENT_DIR?.trim() || env.PI_CODING_AGENT_DIR?.trim();
  const migrationSteps = buildLegacyStateMigrationSteps({
    mode: "automatic",
    detected,
    config: pluginDoctorConfig,
    sessionConfig: params.cfg,
    env,
    now: params.now,
    pluginSessionStoreAgentIds,
    recoverCorruptTargetStore: params.recoverCorruptTargetStore,
    skipAgentScopedMigrations: Boolean(hasCustomAgentDir),
  });
  const initialMigrationSources = [
    stateDirResult,
    stateSchema,
    mediaPersistence,
    configMachineState,
    orphanKeys,
  ];
  if (
    !hasCustomAgentDir &&
    !detected.sessions.hasLegacy &&
    !detected.agentDir.hasLegacy &&
    !detected.channelPlans.hasLegacy &&
    !detected.pluginPlans?.hasLegacy &&
    !detected.pluginStateSidecar.hasLegacy &&
    !detected.pluginInstallIndex.hasLegacy &&
    !detected.debugProxyCaptureSidecar.hasLegacy &&
    !detected.stateSchema.hasLegacy &&
    !detected.taskStateSidecars.hasLegacy &&
    !detected.deliveryQueues.hasLegacy &&
    !detected.voiceWake.hasLegacy &&
    !detected.updateCheck.hasLegacy &&
    !detected.configHealth.hasLegacy &&
    !detected.pluginBindingApprovals.hasLegacy &&
    !detected.currentConversationBindings.hasLegacy &&
    !detected.deviceAuth.hasLegacy &&
    !detected.restartSentinel?.hasLegacy &&
    !detected.workspace.hasLegacy &&
    !detected.channelPairing.hasLegacy
  ) {
    const acpSessionMetadataStep = migrationSteps.find(
      (step) => step.kind === "acp-session-metadata",
    );
    const acpSessionMetadata = acpSessionMetadataStep
      ? await acpSessionMetadataStep.run()
      : { changes: [], warnings: [] };
    const completedSources = [
      ...initialMigrationSources,
      acpSessionMetadata,
      deviceAuth,
      deviceIdentity,
      meetingTranscripts,
    ];
    const changes = completedSources.flatMap((source) => source.changes);
    const warnings = [
      ...stateDirResult.warnings,
      ...stateSchema.warnings,
      ...mediaPersistence.warnings,
      ...configMachineState.warnings,
      ...detected.warnings,
      ...orphanKeys.warnings,
      ...acpSessionMetadata.warnings,
      ...deviceAuth.warnings,
      ...deviceIdentity.warnings,
      ...meetingTranscripts.warnings,
    ];
    const notices = mergeNotices([stateDirResult, detected, deviceAuth, deviceIdentity]);
    logMigrationResults(changes, warnings, notices);
    return {
      migrated: stateDirResult.migrated || changes.length > 0,
      skipped: false,
      changes,
      warnings,
      ...(notices.length > 0 ? { notices } : {}),
    };
  }

  const migrations = await runLegacyStateMigrationSteps(migrationSteps);
  const completedSources = [
    ...initialMigrationSources,
    ...migrations.sharedSources,
    deviceAuth,
    deviceIdentity,
    ...(hasCustomAgentDir ? [] : [meetingTranscripts]),
    ...migrations.finalSources,
  ];
  const changes = completedSources.flatMap((source) => source.changes);
  const warnings = [
    ...stateDirResult.warnings,
    ...stateSchema.warnings,
    ...mediaPersistence.warnings,
    ...configMachineState.warnings,
    ...detected.warnings,
    ...orphanKeys.warnings,
    ...migrations.sharedSources.flatMap((source) => source.warnings),
    ...deviceAuth.warnings,
    ...deviceIdentity.warnings,
    ...(hasCustomAgentDir ? [] : meetingTranscripts.warnings),
    ...migrations.finalSources.flatMap((source) => source.warnings),
  ];
  const notices = mergeNotices([
    stateDirResult,
    detected,
    ...migrations.sharedNoticeSources,
    deviceAuth,
    deviceIdentity,
    meetingTranscripts,
    ...migrations.finalNoticeSources,
  ]);
  logMigrationResults(changes, warnings, notices);
  return {
    // Custom agent roots omit transcript changes from their shared-state report.
    // Preserve the completed migration status without claiming agent ownership.
    migrated:
      stateDirResult.migrated || changes.length > 0 || meetingTranscripts.changes.length > 0,
    skipped: Boolean(hasCustomAgentDir),
    changes,
    warnings,
    ...(notices.length > 0 ? { notices } : {}),
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
