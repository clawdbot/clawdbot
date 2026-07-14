import os from "node:os";
import path from "node:path";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { listBundledChannelLegacyStateMigrationDetectors } from "../channels/plugins/bundled.js";
import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import { getChannelPlugin } from "../channels/plugins/registry.js";
import type { ChannelLegacyStateMigrationPlan } from "../channels/plugins/types.core.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import { isNamedProfile, resolveOAuthDir, resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  createPluginStateKeyedStore,
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
import { DEFAULT_ACCOUNT_ID, DEFAULT_MAIN_KEY, normalizeAgentId } from "../routing/session-key.js";
import {
  detectOpenClawStateDatabaseSchemaMigrations,
  repairOpenClawStateDatabaseSchema,
} from "../state/openclaw-state-db.js";
import {
  detectLegacyChannelPairingState,
  migrateLegacyChannelPairingState,
} from "./state-migrations.channel-pairing.js";
import {
  detectLegacyDebugProxyCaptureSidecar,
  migrateLegacyDebugProxyCaptureSidecar,
} from "./state-migrations.debug-proxy.js";
import {
  detectLegacyExecApprovalsMigration,
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
  migrateLegacyInstalledPluginIndex,
  migrateLegacyPluginStateSidecar,
  runLegacyMigrationPlans,
} from "./state-migrations.plugin-state.js";
import {
  migrateLegacyConfigHealth,
  migrateLegacyCurrentConversationBindings,
  migrateLegacyPluginBindingApprovals,
  migrateLegacyUpdateCheckState,
  migrateLegacyVoiceWakeSettings,
  resolveLegacyConfigHealthPath,
  resolveLegacyCurrentConversationBindingsPath,
  resolveLegacyPluginBindingApprovalsPath,
  resolveLegacyUpdateCheckPath,
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
import type {
  DetectedPluginDoctorStateMigrationPlan,
  LegacyStateDetection,
  MigrationLogger,
  MigrationMessages,
} from "./state-migrations.types.js";

let autoMigrateChecked = false;

export function resetAutoMigrateLegacyStateForTest(): void {
  autoMigrateChecked = false;
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
  warnings?: string[];
}): Promise<DetectedPluginDoctorStateMigrationPlan[]> {
  const plans: DetectedPluginDoctorStateMigrationPlan[] = [];
  const config = params.pluginDoctorConfig ?? params.cfg;
  for (const entry of listPluginDoctorStateMigrationEntries({
    config,
    env: params.env,
  })) {
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
    openPluginStateKeyedStore<T>(options: OpenKeyedStoreOptions) {
      return createPluginStateKeyedStore<T>(pluginId, {
        ...options,
        env: options.env ?? env,
      });
    },
  };
}

export async function detectLegacyStateMigrations(params: {
  cfg: OpenClawConfig;
  pluginDoctorConfig?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  pluginSessionStoreAgentIds?: readonly string[];
  sessionStoreOwnership?: SessionStoreOwnership;
  crossStateDirImports?: boolean;
}): Promise<LegacyStateDetection> {
  const env = params.env ?? process.env;
  const homedir = params.homedir ?? os.homedir;
  const stateDir = resolveStateDir(env, homedir);
  const oauthDir = resolveOAuthDir(env, stateDir);
  // Sources under the DEFAULT home state dir are foreign state when
  // OPENCLAW_STATE_DIR points elsewhere: an isolated/test gateway must never
  // import (and archive) another install's files. Only an explicit doctor run
  // opts into the cross-directory import.
  const crossStateDirImports = params.crossStateDirImports === true;
  const notices: string[] = [];
  const detectedExecApprovals = detectLegacyExecApprovalsMigration({ env, homedir, stateDir });
  const execApprovals = crossStateDirImports
    ? detectedExecApprovals
    : { ...detectedExecApprovals, hasLegacy: false };
  if (detectedExecApprovals.hasLegacy && !crossStateDirImports) {
    notices.push(
      `Exec approvals in the default state dir were not imported into OPENCLAW_STATE_DIR automatically (${detectedExecApprovals.sourcePath} -> ${detectedExecApprovals.targetPath}); run \`openclaw doctor --fix\` to import them.`,
    );
  }

  const targetAgentId = normalizeAgentId(resolveDefaultAgentId(params.cfg));
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
  const pluginBindingApprovalsCrossDir =
    path.resolve(path.dirname(pluginBindingApprovals.sourcePath)) !== path.resolve(stateDir);
  const hasPluginBindingApprovals =
    !isNamedProfile(env) &&
    fileExists(pluginBindingApprovals.sourcePath) &&
    (crossStateDirImports || !pluginBindingApprovalsCrossDir);
  if (
    !isNamedProfile(env) &&
    fileExists(pluginBindingApprovals.sourcePath) &&
    pluginBindingApprovalsCrossDir &&
    !crossStateDirImports
  ) {
    notices.push(
      `Plugin binding approvals in the default state dir were not imported into OPENCLAW_STATE_DIR automatically (${pluginBindingApprovals.sourcePath}); run \`openclaw doctor --fix\` to import them.`,
    );
  }
  const currentConversationBindings = {
    sourcePath: resolveLegacyCurrentConversationBindingsPath(stateDir),
  };
  const hasCurrentConversationBindings = fileExists(currentConversationBindings.sourcePath);
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
      preview.push(
        migration.kind === "agent-databases-composite-primary-key"
          ? "- Shared SQLite schema: agent database registry primary key → agent_id,path"
          : "- Shared SQLite schema: audit event ledger → versioned message lifecycle schema",
      );
    }
    preview.push(
      "- Rerun doctor after shared SQLite schema repair to detect plugin state migrations",
    );
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
  if (channelPairing.hasLegacy) {
    preview.push("- Channel pairing state: legacy JSON files → shared SQLite state");
  }
  if (execApprovals.hasLegacy) {
    preview.push(`- Exec approvals: ${execApprovals.sourcePath} → ${execApprovals.targetPath}`);
  }
  if (channelPlans.length > 0) {
    preview.push(...channelPlans.map(buildLegacyMigrationPreview));
  }
  if (pluginPlans.length > 0) {
    preview.push(...pluginPlans.flatMap((plan) => plan.preview));
  }

  return {
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
    channelPairing,
    execApprovals,
    warnings: pluginPlanWarnings,
    notices,
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
    warnings,
  });
  const hasDetectorFailure = warnings.length > 0;
  // Previously detected plans are only safe when refresh found no current work.
  // If any detector failed, skip stale plans instead of migrating on old assumptions.
  const plans =
    refreshedPlans.length > 0 || hasDetectorFailure
      ? refreshedPlans
      : (params.detected.pluginPlans?.plans ?? []);
  for (const plan of plans) {
    try {
      const result = await plan.migration.migrateLegacyState({
        config: params.config,
        env: params.env,
        stateDir: params.detected.stateDir,
        oauthDir: params.detected.oauthDir,
        context: createPluginDoctorStateMigrationContext(plan.pluginId, params.env),
      });
      changes.push(...result.changes);
      warnings.push(...result.warnings);
      notices.push(...(result.notices ?? []));
    } catch (err) {
      warnings.push(`Failed migrating ${plan.migration.label}: ${String(err)}`);
    }
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
  const stateSchema = repairOpenClawStateDatabaseSchema({
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
  for (const plan of plans) {
    try {
      const result = await plan.migration.migrateLegacyState({
        config: params.config,
        env,
        stateDir,
        oauthDir,
        context: createPluginDoctorStateMigrationContext(plan.pluginId, env),
      });
      changes.push(...result.changes);
      warnings.push(...result.warnings);
      notices.push(...(result.notices ?? []));
    } catch (err) {
      warnings.push(`Failed migrating ${plan.migration.label}: ${String(err)}`);
    }
  }
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

export async function runLegacyStateMigrations(params: {
  detected: LegacyStateDetection;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  recoverCorruptTargetStore?: boolean;
}): Promise<MigrationMessages> {
  const now = params.now ?? (() => Date.now());
  const detected = params.detected;
  const env = params.env ?? process.env;
  const stateSchema = migrateLegacyStateSchema(detected, env);
  if (detected.stateSchema.hasLegacy && stateSchema.warnings.length > 0) {
    return stateSchema;
  }
  const pluginStateSidecar = await migrateLegacyPluginStateSidecar({
    stateDir: detected.stateDir,
  });
  const pluginInstallIndex = await migrateLegacyInstalledPluginIndex({
    stateDir: detected.stateDir,
  });
  const debugProxyCaptureSidecar = migrateLegacyDebugProxyCaptureSidecar({
    stateDir: detected.stateDir,
    detected: detected.debugProxyCaptureSidecar,
  });
  const taskStateSidecars = await migrateLegacyTaskStateSidecars({
    stateDir: detected.stateDir,
  });
  const deliveryQueues = await migrateLegacyDeliveryQueues({
    stateDir: detected.stateDir,
  });
  const voiceWake = migrateLegacyVoiceWakeSettings({
    detected: detected.voiceWake,
    stateDir: detected.stateDir,
  });
  const updateCheck = migrateLegacyUpdateCheckState({
    detected: detected.updateCheck,
    stateDir: detected.stateDir,
  });
  const configHealth = migrateLegacyConfigHealth({
    detected: detected.configHealth,
    stateDir: detected.stateDir,
  });
  const pluginBindingApprovals = migrateLegacyPluginBindingApprovals({
    detected: detected.pluginBindingApprovals,
    stateDir: detected.stateDir,
  });
  const currentConversationBindings = migrateLegacyCurrentConversationBindings({
    detected: detected.currentConversationBindings,
    stateDir: detected.stateDir,
  });
  const channelPairing = migrateLegacyChannelPairingState({
    detected: detected.channelPairing,
    env: { ...env, OPENCLAW_STATE_DIR: detected.stateDir },
  });
  const execApprovals = migrateLegacyExecApprovals(detected.execApprovals);
  const preSessionChannelPlans = await runLegacyMigrationPlans(
    detected.channelPlans.plans.filter((plan) => plan.kind === "plugin-state-import"),
  );
  const pluginPlans = detected.stateSchema.hasLegacy
    ? { changes: [], warnings: [] }
    : await runPluginDoctorStateMigrationPlans({
        detected,
        config: params.config ?? ({} as OpenClawConfig),
        env,
      });
  const sessions = await migrateLegacySessions(detected, now, {
    recoverCorruptTargetStore: params.recoverCorruptTargetStore,
  });
  const acpSessionMetadata = await migrateLegacyAcpSessionMetadata({
    cfg: params.config ?? ({} as OpenClawConfig),
    env: { ...env, OPENCLAW_STATE_DIR: detected.stateDir },
    now,
  });
  const agentDir = await migrateLegacyAgentDir(detected, now);
  const channelPlans = await runLegacyMigrationPlans(
    detected.channelPlans.plans.filter((plan) => plan.kind !== "plugin-state-import"),
  );
  return {
    changes: [
      ...stateSchema.changes,
      ...pluginStateSidecar.changes,
      ...pluginInstallIndex.changes,
      ...debugProxyCaptureSidecar.changes,
      ...taskStateSidecars.changes,
      ...deliveryQueues.changes,
      ...voiceWake.changes,
      ...updateCheck.changes,
      ...configHealth.changes,
      ...pluginBindingApprovals.changes,
      ...currentConversationBindings.changes,
      ...channelPairing.changes,
      ...execApprovals.changes,
      ...preSessionChannelPlans.changes,
      ...pluginPlans.changes,
      ...sessions.changes,
      ...acpSessionMetadata.changes,
      ...agentDir.changes,
      ...channelPlans.changes,
    ],
    warnings: [
      ...stateSchema.warnings,
      ...detected.warnings,
      ...pluginStateSidecar.warnings,
      ...pluginInstallIndex.warnings,
      ...debugProxyCaptureSidecar.warnings,
      ...taskStateSidecars.warnings,
      ...deliveryQueues.warnings,
      ...voiceWake.warnings,
      ...updateCheck.warnings,
      ...configHealth.warnings,
      ...pluginBindingApprovals.warnings,
      ...currentConversationBindings.warnings,
      ...channelPairing.warnings,
      ...execApprovals.warnings,
      ...preSessionChannelPlans.warnings,
      ...pluginPlans.warnings,
      ...sessions.warnings,
      ...acpSessionMetadata.warnings,
      ...agentDir.warnings,
      ...channelPlans.warnings,
    ],
    ...(pluginPlans.notices && pluginPlans.notices.length > 0
      ? { notices: [...pluginPlans.notices] }
      : {}),
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
  crossStateDirImports?: boolean;
}): Promise<{
  migrated: boolean;
  skipped: boolean;
  changes: string[];
  warnings: string[];
  notices?: string[];
}> {
  if (autoMigrateChecked) {
    return { migrated: false, skipped: true, changes: [], warnings: [] };
  }
  autoMigrateChecked = true;

  const env = params.env ?? process.env;
  const stateDirResult = await autoMigrateLegacyStateDir({
    env,
    homedir: params.homedir,
    log: params.log,
  });
  const stateDir = resolveStateDir(env, params.homedir ?? os.homedir);
  const stateSchema = repairOpenClawStateDatabaseSchema({
    env: { ...env, OPENCLAW_STATE_DIR: stateDir },
  });
  if (stateSchema.warnings.length > 0) {
    return {
      migrated: stateDirResult.migrated || stateSchema.changes.length > 0,
      skipped: false,
      changes: [...stateDirResult.changes, ...stateSchema.changes],
      warnings: [...stateDirResult.warnings, ...stateSchema.warnings],
      ...(stateDirResult.notices?.length ? { notices: stateDirResult.notices } : {}),
    };
  }
  const pluginDoctorConfig = params.pluginDoctorConfig ?? params.cfg;
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
  const acpSessionMetadata = await migrateLegacyAcpSessionMetadata({
    cfg: params.cfg,
    env,
    now: params.now,
    pluginSessionStoreAgentIds,
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
    crossStateDirImports: params.crossStateDirImports,
  });
  const hasCustomAgentDir = env.OPENCLAW_AGENT_DIR?.trim() || env.PI_CODING_AGENT_DIR?.trim();
  if (hasCustomAgentDir) {
    const pluginStateSidecar = await migrateLegacyPluginStateSidecar({
      stateDir: detected.stateDir,
    });
    const pluginInstallIndex = await migrateLegacyInstalledPluginIndex({
      stateDir: detected.stateDir,
    });
    const debugProxyCaptureSidecar = migrateLegacyDebugProxyCaptureSidecar({
      stateDir: detected.stateDir,
      detected: detected.debugProxyCaptureSidecar,
    });
    const taskStateSidecars = await migrateLegacyTaskStateSidecars({
      stateDir: detected.stateDir,
    });
    const deliveryQueues = await migrateLegacyDeliveryQueues({
      stateDir: detected.stateDir,
    });
    const voiceWake = migrateLegacyVoiceWakeSettings({
      detected: detected.voiceWake,
      stateDir: detected.stateDir,
    });
    const updateCheck = migrateLegacyUpdateCheckState({
      detected: detected.updateCheck,
      stateDir: detected.stateDir,
    });
    const configHealth = migrateLegacyConfigHealth({
      detected: detected.configHealth,
      stateDir: detected.stateDir,
    });
    const pluginBindingApprovals = migrateLegacyPluginBindingApprovals({
      detected: detected.pluginBindingApprovals,
      stateDir: detected.stateDir,
    });
    const currentConversationBindings = migrateLegacyCurrentConversationBindings({
      detected: detected.currentConversationBindings,
      stateDir: detected.stateDir,
    });
    const channelPairing = migrateLegacyChannelPairingState({
      detected: detected.channelPairing,
      env: { ...env, OPENCLAW_STATE_DIR: detected.stateDir },
    });
    const execApprovals = migrateLegacyExecApprovals(detected.execApprovals);
    const preSessionChannelPlans = await runLegacyMigrationPlans(
      detected.channelPlans.plans.filter((plan) => plan.kind === "plugin-state-import"),
    );
    const pluginPlans = await runPluginDoctorStateMigrationPlans({
      detected,
      config: params.pluginDoctorConfig ?? params.cfg,
      env,
    });
    const changes = [
      ...stateDirResult.changes,
      ...stateSchema.changes,
      ...orphanKeys.changes,
      ...acpSessionMetadata.changes,
      ...pluginStateSidecar.changes,
      ...pluginInstallIndex.changes,
      ...debugProxyCaptureSidecar.changes,
      ...taskStateSidecars.changes,
      ...deliveryQueues.changes,
      ...voiceWake.changes,
      ...updateCheck.changes,
      ...configHealth.changes,
      ...pluginBindingApprovals.changes,
      ...currentConversationBindings.changes,
      ...channelPairing.changes,
      ...execApprovals.changes,
      ...preSessionChannelPlans.changes,
      ...pluginPlans.changes,
    ];
    const warnings = [
      ...stateDirResult.warnings,
      ...stateSchema.warnings,
      ...detected.warnings,
      ...orphanKeys.warnings,
      ...acpSessionMetadata.warnings,
      ...pluginStateSidecar.warnings,
      ...pluginInstallIndex.warnings,
      ...debugProxyCaptureSidecar.warnings,
      ...taskStateSidecars.warnings,
      ...deliveryQueues.warnings,
      ...voiceWake.warnings,
      ...updateCheck.warnings,
      ...configHealth.warnings,
      ...pluginBindingApprovals.warnings,
      ...currentConversationBindings.warnings,
      ...channelPairing.warnings,
      ...execApprovals.warnings,
      ...preSessionChannelPlans.warnings,
      ...pluginPlans.warnings,
    ];
    const notices = [
      ...(stateDirResult.notices ?? []),
      ...detected.notices,
      ...(pluginPlans.notices ?? []),
    ];
    logMigrationResults(changes, warnings, notices);
    return {
      migrated:
        stateDirResult.migrated ||
        stateSchema.changes.length > 0 ||
        orphanKeys.changes.length > 0 ||
        acpSessionMetadata.changes.length > 0 ||
        pluginStateSidecar.changes.length > 0 ||
        pluginInstallIndex.changes.length > 0 ||
        debugProxyCaptureSidecar.changes.length > 0 ||
        taskStateSidecars.changes.length > 0 ||
        deliveryQueues.changes.length > 0 ||
        voiceWake.changes.length > 0 ||
        updateCheck.changes.length > 0 ||
        configHealth.changes.length > 0 ||
        pluginBindingApprovals.changes.length > 0 ||
        currentConversationBindings.changes.length > 0 ||
        channelPairing.changes.length > 0 ||
        execApprovals.changes.length > 0 ||
        preSessionChannelPlans.changes.length > 0 ||
        pluginPlans.changes.length > 0,
      skipped: true,
      changes,
      warnings,
      ...(notices.length > 0 ? { notices } : {}),
    };
  }
  if (
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
    !detected.channelPairing.hasLegacy &&
    !detected.execApprovals.hasLegacy
  ) {
    const changes = [
      ...stateDirResult.changes,
      ...stateSchema.changes,
      ...orphanKeys.changes,
      ...acpSessionMetadata.changes,
    ];
    const warnings = [
      ...stateDirResult.warnings,
      ...stateSchema.warnings,
      ...detected.warnings,
      ...orphanKeys.warnings,
      ...acpSessionMetadata.warnings,
    ];
    const notices = [...(stateDirResult.notices ?? []), ...detected.notices];
    logMigrationResults(changes, warnings, notices);
    return {
      migrated:
        stateDirResult.migrated ||
        stateSchema.changes.length > 0 ||
        orphanKeys.changes.length > 0 ||
        acpSessionMetadata.changes.length > 0,
      skipped: false,
      changes,
      warnings,
      ...(notices.length > 0 ? { notices } : {}),
    };
  }

  const now = params.now ?? (() => Date.now());
  const pluginStateSidecar = await migrateLegacyPluginStateSidecar({
    stateDir: detected.stateDir,
  });
  const pluginInstallIndex = await migrateLegacyInstalledPluginIndex({
    stateDir: detected.stateDir,
  });
  const debugProxyCaptureSidecar = migrateLegacyDebugProxyCaptureSidecar({
    stateDir: detected.stateDir,
    detected: detected.debugProxyCaptureSidecar,
  });
  const taskStateSidecars = await migrateLegacyTaskStateSidecars({
    stateDir: detected.stateDir,
  });
  const deliveryQueues = await migrateLegacyDeliveryQueues({
    stateDir: detected.stateDir,
  });
  const voiceWake = migrateLegacyVoiceWakeSettings({
    detected: detected.voiceWake,
    stateDir: detected.stateDir,
  });
  const updateCheck = migrateLegacyUpdateCheckState({
    detected: detected.updateCheck,
    stateDir: detected.stateDir,
  });
  const configHealth = migrateLegacyConfigHealth({
    detected: detected.configHealth,
    stateDir: detected.stateDir,
  });
  const pluginBindingApprovals = migrateLegacyPluginBindingApprovals({
    detected: detected.pluginBindingApprovals,
    stateDir: detected.stateDir,
  });
  const currentConversationBindings = migrateLegacyCurrentConversationBindings({
    detected: detected.currentConversationBindings,
    stateDir: detected.stateDir,
  });
  const channelPairing = migrateLegacyChannelPairingState({
    detected: detected.channelPairing,
    env: { ...env, OPENCLAW_STATE_DIR: detected.stateDir },
  });
  const execApprovals = migrateLegacyExecApprovals(detected.execApprovals);
  const preSessionChannelPlans = await runLegacyMigrationPlans(
    detected.channelPlans.plans.filter((plan) => plan.kind === "plugin-state-import"),
  );
  const pluginPlans = await runPluginDoctorStateMigrationPlans({
    detected,
    config: params.pluginDoctorConfig ?? params.cfg,
    env,
  });
  const sessions = await migrateLegacySessions(detected, now, {
    recoverCorruptTargetStore: params.recoverCorruptTargetStore,
  });
  const postSessionAcpMetadata = await migrateLegacyAcpSessionMetadata({
    cfg: params.cfg,
    env,
    now,
    pluginSessionStoreAgentIds,
  });
  const agentDir = await migrateLegacyAgentDir(detected, now);
  const channelPlans = await runLegacyMigrationPlans(
    detected.channelPlans.plans.filter((plan) => plan.kind !== "plugin-state-import"),
  );
  const changes = [
    ...stateDirResult.changes,
    ...stateSchema.changes,
    ...orphanKeys.changes,
    ...acpSessionMetadata.changes,
    ...pluginStateSidecar.changes,
    ...pluginInstallIndex.changes,
    ...debugProxyCaptureSidecar.changes,
    ...taskStateSidecars.changes,
    ...deliveryQueues.changes,
    ...voiceWake.changes,
    ...updateCheck.changes,
    ...configHealth.changes,
    ...pluginBindingApprovals.changes,
    ...currentConversationBindings.changes,
    ...channelPairing.changes,
    ...execApprovals.changes,
    ...preSessionChannelPlans.changes,
    ...pluginPlans.changes,
    ...sessions.changes,
    ...postSessionAcpMetadata.changes,
    ...agentDir.changes,
    ...channelPlans.changes,
  ];
  const warnings = [
    ...stateDirResult.warnings,
    ...stateSchema.warnings,
    ...detected.warnings,
    ...orphanKeys.warnings,
    ...acpSessionMetadata.warnings,
    ...pluginStateSidecar.warnings,
    ...pluginInstallIndex.warnings,
    ...debugProxyCaptureSidecar.warnings,
    ...taskStateSidecars.warnings,
    ...deliveryQueues.warnings,
    ...voiceWake.warnings,
    ...updateCheck.warnings,
    ...configHealth.warnings,
    ...pluginBindingApprovals.warnings,
    ...currentConversationBindings.warnings,
    ...channelPairing.warnings,
    ...execApprovals.warnings,
    ...preSessionChannelPlans.warnings,
    ...pluginPlans.warnings,
    ...sessions.warnings,
    ...postSessionAcpMetadata.warnings,
    ...agentDir.warnings,
    ...channelPlans.warnings,
  ];
  const notices = [
    ...(stateDirResult.notices ?? []),
    ...detected.notices,
    ...(pluginPlans.notices ?? []),
  ];

  logMigrationResults(changes, warnings, notices);

  return {
    migrated: changes.length > 0,
    skipped: false,
    changes,
    warnings,
    ...(notices.length > 0 ? { notices } : {}),
  };
}
