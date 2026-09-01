import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listAgentIds, tryResolveAmbientOwnerAgentId } from "../agents/agent-scope-config.js";
import {
  discardLegacyRegistryWorktrees,
  hasLegacyRegistryWorktrees,
  listRegistryWorktreesForMigration,
  rewriteRegistryWorktreePathsForMigration,
} from "../agents/worktrees/registry.js";
import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import { getChannelPlugin } from "../channels/plugins/registry.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import { resolveSessionStoreCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import { resolveOAuthDir, resolveStateDir } from "../config/paths.js";
import { migrateLegacyMainSessionKeys } from "../config/sessions/legacy-main-session-migration.js";
import { isPerAgentSessionStoreConfig } from "../config/sessions/session-store-config.js";
import { resolveConfiguredAgentDatabaseTargets } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  collectRelevantDoctorPluginIds,
  listPluginDoctorSessionStoreAgentIds,
} from "../plugins/doctor-contract-registry.js";
import { resolveLegacyInstalledPluginIndexStorePath } from "../plugins/installed-plugin-index-store.js";
import {
  EMPTY_LEGACY_SESSION_SURFACES,
  type PreparedLegacySessionSurfaces,
} from "../plugins/legacy-session-surfaces.types.js";
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
import { migrationFileExists, readSessionStoreJson5, safeReadDir } from "./state-migrations.fs.js";
import {
  inspectLegacyAgentDir,
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
import {
  formatStartupMigrationFailure,
  logStateMigrationResult,
  mergeNotices,
} from "./state-migrations.messages.js";
import {
  detectLegacyNodeHostConfig,
  migrateLegacyNodeHostConfig,
} from "./state-migrations.node-host.js";
import {
  collectPluginDoctorStateMigrationPlans,
  runPluginDoctorStateMigrationPlans,
} from "./state-migrations.plugin-doctor.js";
import {
  migrateLegacyInstalledPluginIndex,
  migrateLegacyPluginStateSidecar,
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
import {
  detectSharedAuthStoreMigration,
  migrateSharedAuthStore,
} from "./state-migrations.shared-auth-store.js";
import {
  autoMigrateLegacyStateDir,
  migrateLegacyProfileWorkspace,
} from "./state-migrations.state-dir.js";
import {
  PLUGIN_STATE_SQLITE_SIDECAR_SUFFIXES,
  TASK_STATE_SQLITE_SIDECAR_SUFFIXES,
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
import { migrateHistoricalTranscriptDirectives } from "./state-migrations.transcript-directives.js";
import {
  detectLegacyTuiLastSessions,
  migrateLegacyTuiLastSessions,
} from "./state-migrations.tui-last-session.js";
import type {
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
    case "commitments-retirement-v7":
      return "retired commitments storage → discarded rows, table, and indexes";
    case "worker-placement-execution-mode-v8":
      return "cloud worker placements → execution-mode claims";
    case "agent-databases-relative-paths-v9":
      return "agent database registry paths → state-relative storage";
    case "state-table-retirement-v10":
      return "retired shared-state tables → removed tables and indexes";
    case "state-table-retirement-v11":
      return "retired skill curator tables → removed tables and indexes";
    case "singleton-state-foldin-v12":
      return "singleton state tables → shared configuration state";
    case "state-consolidation-v13":
      return "cron jobs and subagent runs → canonical JSON storage";
    case "creator-namespace-v14":
      return "historical cron creators → unknown source attribution";
    case "conversation-binding-targets-v15":
      return "conversation bindings → exact target keys without agent/session projections";
    case "skill-workshop-directory-ownership-v16":
      return "Skill Workshop ownership → global directory containment";
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

const DEFERRED_LEGACY_OWNER_MESSAGE =
  "Deferred legacy agent/session migration: select an agent owner";

function tryResolveDoctorStateMigrationAgentId(cfg: OpenClawConfig): string | undefined {
  const agentId = tryResolveAmbientOwnerAgentId(cfg);
  return agentId && listAgentIds(cfg).includes(agentId) ? agentId : undefined;
}

function tryResolveDoctorSessionMigrationAgentId(cfg: OpenClawConfig): string | undefined {
  return (
    tryResolveDoctorStateMigrationAgentId(cfg) ??
    (!isPerAgentSessionStoreConfig(cfg.session?.store)
      ? resolveSessionStoreCompatibilityAgentId(cfg)
      : undefined)
  );
}

function resolveConcreteBindingAccountId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const accountId = value.trim();
  return accountId && accountId !== "*" ? accountId : undefined;
}

async function detectManagedWorktreeStateMigration(params: {
  env: NodeJS.ProcessEnv;
  stateDir: string;
  stateSchemaMigrations: readonly OpenClawStateDatabaseSchemaMigration[];
  doctorOnlyStateMigrations?: boolean;
}): Promise<LegacyStateDetection["worktrees"]> {
  const rawRoot = path.join(params.stateDir, "worktrees");
  const stateEnv = { ...params.env, OPENCLAW_STATE_DIR: params.stateDir };
  const databaseExists = migrationFileExists(resolveOpenClawStateSqlitePath(stateEnv));
  const hasCurrentSchema = params.stateSchemaMigrations.length === 0;
  const hasLegacy =
    params.doctorOnlyStateMigrations === true &&
    hasCurrentSchema &&
    databaseExists &&
    hasLegacyRegistryWorktrees(stateEnv);
  // Detection is read-only for the doctor --lint contract. ManagedWorktreeService.worktreesRoot()
  // owns directory creation; absent roots are canonicalized through their existing state parent.
  let canonicalRoot: string;
  try {
    canonicalRoot = await fs.realpath(rawRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    try {
      canonicalRoot = path.join(await fs.realpath(params.stateDir), "worktrees");
    } catch (stateDirError) {
      if ((stateDirError as NodeJS.ErrnoException).code === "ENOENT") {
        return { hasLegacy, pathRewrites: [] };
      }
      throw stateDirError;
    }
  }
  if (rawRoot === canonicalRoot || !hasCurrentSchema || !databaseExists) {
    return { hasLegacy, pathRewrites: [] };
  }
  const pathRewrites = listRegistryWorktreesForMigration(stateEnv).flatMap((row) => {
    const fromPath = path.join(rawRoot, row.repoFingerprint, row.name);
    return row.path === fromPath
      ? [
          {
            id: row.id,
            fromPath,
            toPath: path.join(canonicalRoot, row.repoFingerprint, row.name),
          },
        ]
      : [];
  });
  return { hasLegacy, pathRewrites };
}

export async function detectLegacyStateMigrations(params: {
  cfg: OpenClawConfig;
  /** Legacy session file inspection belongs to Doctor, including its read-only preview. */
  mode?: "automatic" | "doctor";
  pluginDoctorConfig?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  pluginSessionStoreAgentIds?: readonly string[];
  sessionStoreOwnership?: SessionStoreOwnership;
  doctorOnlyStateMigrations?: boolean;
  allowLegacyDeviceIdentityImport?: boolean;
  legacySessionSurfaces: PreparedLegacySessionSurfaces;
}): Promise<LegacyStateDetection> {
  const env = params.env ?? process.env;
  const homedir = params.homedir ?? os.homedir;
  const stateDir = resolveStateDir(env, homedir);
  const oauthDir = resolveOAuthDir(env, stateDir);
  const detectSessionFiles = params.mode !== "automatic";
  const migrationAgentId = tryResolveDoctorStateMigrationAgentId(params.cfg);
  const sessionMigrationAgentId = tryResolveDoctorSessionMigrationAgentId(params.cfg);
  const targetAgentId = migrationAgentId ?? sessionMigrationAgentId ?? LEGACY_IMPLICIT_AGENT_ID;
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
  const currentSessionStoreOwnership =
    detectSessionFiles && sessionMigrationAgentId
      ? resolveSessionStoreOwnership({
          cfg: params.cfg,
          env,
          stateDir,
          targetAgentId: sessionMigrationAgentId,
          pluginSessionStoreAgentIds,
        })
      : {
          preserveAmbiguousKeys: true,
          preserveForeignMainAliases: true,
          targetStoreAliases: {
            hasDistinctAliases: false,
            hasFinalSymlink: false,
            hasUnresolvedIdentity: false,
          },
        };
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
  const hasLegacySessions =
    detectSessionFiles &&
    (migrationFileExists(sessionsLegacyStorePath) ||
      safeReadDir(sessionsLegacyDir).some((e) => e.isFile() && e.name.endsWith(".jsonl")));

  const targetSessionParsed =
    detectSessionFiles && migrationFileExists(sessionsTargetStorePath)
      ? readSessionStoreJson5(sessionsTargetStorePath)
      : { store: {}, ok: true };
  const legacySessionSurfaces = detectSessionFiles
    ? params.legacySessionSurfaces
    : EMPTY_LEGACY_SESSION_SURFACES;
  const legacyKeys =
    targetSessionParsed.ok && legacySessionSurfaces.failures.length === 0
      ? listLegacySessionKeys({
          store: targetSessionParsed.store,
          agentId: targetAgentId,
          mainKey: targetMainKey,
          scope: targetScope,
          preserveAmbiguousKeys: sessionStoreOwnership.preserveAmbiguousKeys,
          preserveForeignMainAliases,
          legacySessionSurfaces: legacySessionSurfaces.surfaces,
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
  const legacyAgentDirInspection = inspectLegacyAgentDir(legacyAgentDir);
  const hasLegacyAgentDir = legacyAgentDirInspection.status === "payload";
  const pluginStateSidecarPath = resolveLegacyPluginStateSidecarPath(stateDir);
  const hasPluginStateSidecar = migrationFileExists(pluginStateSidecarPath);
  const hasPendingPluginStateSidecarArchive = hasPendingSqliteSidecarArchive(
    pluginStateSidecarPath,
    PLUGIN_STATE_SQLITE_SIDECAR_SUFFIXES,
  );
  const pluginInstallIndexPath = resolveLegacyInstalledPluginIndexStorePath({ stateDir });
  const hasPluginInstallIndex = migrationFileExists(pluginInstallIndexPath);
  const debugProxyCaptureSidecar = detectLegacyDebugProxyCaptureSidecar(stateDir, env);
  const stateSchemaMigrations = detectOpenClawStateDatabaseSchemaMigrations({
    env: { ...env, OPENCLAW_STATE_DIR: stateDir },
  });
  const worktrees = await detectManagedWorktreeStateMigration({
    env,
    stateDir,
    stateSchemaMigrations,
    doctorOnlyStateMigrations: params.doctorOnlyStateMigrations,
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
    migrationFileExists(taskRunsSidecarPath) ||
    migrationFileExists(flowRunsSidecarPath) ||
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
  const hasVoiceWake =
    migrationFileExists(voiceWake.triggersPath) || migrationFileExists(voiceWake.routingPath);
  const updateCheck = {
    sourcePath: resolveLegacyUpdateCheckPath(stateDir),
  };
  const hasUpdateCheck = migrationFileExists(updateCheck.sourcePath);
  const configHealth = {
    sourcePath: resolveLegacyConfigHealthPath(stateDir),
  };
  const hasConfigHealth = migrationFileExists(configHealth.sourcePath);
  const pluginBindingApprovals = {
    sourcePath: resolveLegacyPluginBindingApprovalsPath(env, homedir),
  };
  const hasPluginBindingApprovals =
    path.resolve(path.dirname(pluginBindingApprovals.sourcePath)) === path.resolve(stateDir) &&
    migrationFileExists(pluginBindingApprovals.sourcePath);
  const currentConversationBindings = {
    sourcePath: resolveLegacyCurrentConversationBindingsPath(stateDir),
  };
  const hasCurrentConversationBindings = migrationFileExists(
    currentConversationBindings.sourcePath,
  );
  const detectDoctorOwnedState = <TDetection>(
    detect: (options: { stateDir: string; doctorOnlyStateMigrations?: boolean }) => TDetection,
  ): TDetection =>
    detect({ stateDir, doctorOnlyStateMigrations: params.doctorOnlyStateMigrations });
  const tuiLastSessions = detectDoctorOwnedState(detectLegacyTuiLastSessions);
  const commitments = await detectLegacyCommitments({
    stateDir,
    env,
    doctorOnlyStateMigrations: params.doctorOnlyStateMigrations,
  });
  const auditLogs = detectDoctorOwnedState(detectLegacyAuditLogs);
  const acpReplayLedger = detectDoctorOwnedState(detectLegacyAcpReplayLedger);
  const managedOutgoingImages = detectDoctorOwnedState(detectLegacyManagedOutgoingImages);
  const apns = detectDoctorOwnedState(detectLegacyApnsRegistrations);
  const deviceAuth = detectDoctorOwnedState(detectLegacyDeviceAuth);
  const sharedAuthStore = detectSharedAuthStoreMigration({
    stateDir,
    env,
    doctorOnlyStateMigrations:
      stateSchemaMigrations.length === 0 && params.doctorOnlyStateMigrations === true,
  });
  const deviceIdentity = detectLegacyDeviceIdentity({
    stateDir,
    env,
    doctorOnlyStateMigrations: params.doctorOnlyStateMigrations,
    allowLegacyDeviceIdentityImport: params.allowLegacyDeviceIdentityImport,
  });
  const execApprovals = detectDoctorOwnedState(detectLegacyExecApprovals);
  const mcpOauth = detectDoctorOwnedState(detectLegacyMcpOAuthStores);
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
  const webPush = detectDoctorOwnedState(detectLegacyWebPush);
  const nodeHost = detectDoctorOwnedState(detectLegacyNodeHostConfig);
  const subagentRegistry = detectDoctorOwnedState(detectLegacySubagentRegistry);
  const rescuePending = detectDoctorOwnedState(detectLegacyRescuePending);
  const channelPairing = detectLegacyChannelPairingState({
    sourceDir: oauthDir,
    configuredChannelIds: Object.keys(params.cfg.channels ?? {}),
    resolveAccounts: () => {
      const configuredChannels = Object.entries(params.cfg.channels ?? {});
      // Doctor already resolved this migration owner; plugin defaults must not infer it again.
      let migrationOwnerConfig = params.cfg;
      if (migrationAgentId && listAgentIds(params.cfg).length > 1 && params.cfg.agents) {
        const agents = structuredClone(params.cfg.agents);
        delete agents.ownership;
        for (const [agentId, entry] of Object.entries(agents.entries ?? {})) {
          entry.default = normalizeAgentId(agentId) === targetAgentId;
        }
        for (const entry of agents.list ?? []) {
          entry.default = normalizeAgentId(entry.id) === targetAgentId;
        }
        migrationOwnerConfig = { ...params.cfg, agents };
      }
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
            ...(params.cfg.bindings ?? []).flatMap((binding) => {
              const accountId =
                binding.match?.channel === channelId
                  ? resolveConcreteBindingAccountId(binding.match.accountId)
                  : undefined;
              return accountId ? [accountId] : [];
            }),
          ];
          return [
            channelId,
            Array.from(new Set(accountIds.map((entry) => entry.trim()).filter(Boolean))),
          ];
        }),
      );
      return {
        defaultAccountIds: Object.fromEntries(
          configuredChannels.flatMap(([channelId, value]) => {
            const boundAccountId = params.cfg.bindings?.find(
              (binding) =>
                normalizeAgentId(binding.agentId) === targetAgentId &&
                binding.match?.channel === channelId &&
                resolveConcreteBindingAccountId(binding.match.accountId) !== undefined,
            )?.match.accountId;
            const concreteBoundAccountId = resolveConcreteBindingAccountId(boundAccountId);
            if (concreteBoundAccountId) {
              return [[channelId, concreteBoundAccountId]];
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
              const accountId = resolveChannelDefaultAccountId({
                plugin,
                cfg: migrationOwnerConfig,
              });
              return [[channelId, accountId]];
            }
            return [
              [channelId, configuredAccountIds[channelId]?.toSorted()[0] ?? DEFAULT_ACCOUNT_ID],
            ];
          }),
        ),
        accountIds: configuredAccountIds,
      };
    },
  });
  const pluginPlanWarnings: string[] = [];
  const pluginPlans =
    stateSchemaMigrations.length > 0
      ? []
      : await collectPluginDoctorStateMigrationPlans(
          { config: pluginConfig, env, stateDir, oauthDir },
          {
            includeDoctorOnly: params.doctorOnlyStateMigrations === true,
            warnings: pluginPlanWarnings,
          },
        );

  const sessionsHaveLegacy =
    Boolean(sessionMigrationAgentId) &&
    (hasLegacySessions || legacyKeys.length > 0 || hasStaleSessionFiles);
  const agentDirHasLegacy = Boolean(migrationAgentId) && hasLegacyAgentDir;
  const deferredSessions =
    !sessionMigrationAgentId &&
    (hasLegacySessions || legacyKeys.length > 0 || hasStaleSessionFiles);
  const deferredAgentDir = !migrationAgentId && hasLegacyAgentDir;
  const deferredWarnings =
    deferredSessions || (deferredAgentDir && params.doctorOnlyStateMigrations === true)
      ? [DEFERRED_LEGACY_OWNER_MESSAGE]
      : [];
  const deferredNotices =
    deferredAgentDir && params.doctorOnlyStateMigrations !== true
      ? [DEFERRED_LEGACY_OWNER_MESSAGE]
      : [];
  const preview: string[] = [];
  if (sessionsHaveLegacy && hasLegacySessions) {
    preview.push(`- Sessions: ${sessionsLegacyDir} → ${sessionsTargetDir}`);
  }
  if (sessionsHaveLegacy && legacyKeys.length > 0) {
    preview.push(`- Sessions: canonicalize legacy keys in ${sessionsTargetStorePath}`);
  }
  if (sessionsHaveLegacy && hasStaleSessionFiles) {
    preview.push(`- Sessions: repair migrated transcript paths in ${sessionsTargetStorePath}`);
  }
  if (agentDirHasLegacy) {
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
  if (worktrees.hasLegacy) {
    preview.push("- Managed worktrees: discard rows without provisioned-file ledgers");
  }
  if (worktrees.pathRewrites.length > 0) {
    preview.push(
      `- Managed worktrees: canonicalize ${worktrees.pathRewrites.length} persisted ${worktrees.pathRewrites.length === 1 ? "path" : "paths"} for symlinked state directories`,
    );
  }
  if (migrationFileExists(taskRunsSidecarPath)) {
    preview.push(`- Task registry sidecar: ${taskRunsSidecarPath} → shared SQLite state`);
  } else if (hasPendingTaskRunsSidecarArchive) {
    preview.push(`- Task registry sidecar: finish archive cleanup for ${taskRunsSidecarPath}`);
  }
  if (migrationFileExists(flowRunsSidecarPath)) {
    preview.push(`- Task flow sidecar: ${flowRunsSidecarPath} → shared SQLite state`);
  } else if (hasPendingFlowRunsSidecarArchive) {
    preview.push(`- Task flow sidecar: finish archive cleanup for ${flowRunsSidecarPath}`);
  }
  const stateMigrationPreviews: Array<readonly [hasLegacy: boolean, message: string]> = [
    [
      sharedAuthStore.hasLegacy,
      "- Shared auth store: legacy main-agent rows → shared SQLite state",
    ],
    [hasDeliveryQueues, "- Delivery queues: legacy JSON queue files → shared SQLite state"],
    [hasVoiceWake, "- Voice Wake settings: legacy JSON files → shared SQLite state"],
    [hasUpdateCheck, "- Update-check state: legacy JSON file → shared SQLite state"],
    [hasConfigHealth, "- Config health state: legacy JSON file → shared SQLite state"],
    [
      hasPluginBindingApprovals,
      "- Plugin binding approvals: legacy JSON file → shared SQLite state",
    ],
    [
      hasCurrentConversationBindings,
      "- Current-conversation bindings: legacy JSON file → shared SQLite state",
    ],
    [
      tuiLastSessions.hasLegacy,
      "- TUI last-session pointers: legacy JSON file → shared SQLite state",
    ],
    [
      commitments.hasLegacy,
      "- Commitments: discard retired commitments/commitments.json rows without import, archive, or export",
    ],
    ...auditLogs.sources.map((source): readonly [boolean, string] => [
      true,
      `- ${source.label}: legacy JSONL file → shared SQLite state`,
    ]),
    [acpReplayLedger.hasLegacy, "- ACP replay ledger: legacy JSON file → shared SQLite state"],
    [
      managedOutgoingImages.hasLegacy,
      "- Managed outgoing images: legacy record JSON → shared SQLite state",
    ],
    [apns.hasLegacy, "- APNs registrations: legacy JSON → shared SQLite state"],
    [deviceAuth.hasLegacy, "- Device auth tokens: legacy JSON → shared SQLite state"],
    [deviceIdentity.hasLegacy, "- Primary device identity: legacy JSON → shared SQLite state"],
    [
      deviceIdentity.hasInvalidCanonical && !deviceIdentity.hasLegacy,
      "- Primary device identity: invalid SQLite row → new device identity",
    ],
    [execApprovals.hasLegacy, "- Exec approvals: legacy JSON → shared SQLite state"],
    [mcpOauth.hasLegacy, "- MCP OAuth credentials: legacy JSON → shared SQLite state"],
    [
      meetingTranscripts.hasLegacy,
      "- Meeting transcripts: legacy JSON/JSONL files → shared SQLite state",
    ],
    [restartSentinel.hasLegacy, "- Restart sentinel: legacy JSON → shared SQLite state"],
    [workspace.hasLegacy, "- Workspace setup and attestations: legacy files → shared SQLite state"],
    [
      webPush.hasLegacy,
      "- Web Push subscriptions and VAPID identity: legacy JSON → shared SQLite state",
    ],
    [nodeHost.hasLegacy, "- Node-host config: legacy node.json → shared SQLite state"],
    [
      subagentRegistry.hasLegacy,
      "- Subagent runs: discard retired transient subagents/runs.json state",
    ],
    [
      rescuePending.hasLegacy,
      "- System-agent rescue approvals: discard retired pending JSON capabilities",
    ],
    [channelPairing.hasLegacy, "- Channel pairing state: legacy JSON files → shared SQLite state"],
  ];
  for (const [hasLegacy, message] of stateMigrationPreviews) {
    if (hasLegacy) {
      preview.push(message);
    }
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
      hasLegacy: sessionsHaveLegacy,
      legacyKeys: sessionMigrationAgentId ? legacyKeys : [],
      preserveAmbiguousKeys: sessionStoreOwnership.preserveAmbiguousKeys,
      preserveForeignMainAliases,
      targetStoreAliases: sessionStoreOwnership.targetStoreAliases,
    },
    agentDir: {
      legacyDir: legacyAgentDir,
      targetDir: targetAgentDir,
      hasLegacy: agentDirHasLegacy,
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
    sharedAuthStore,
    worktrees,
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
    warnings: [
      ...pluginPlanWarnings,
      ...legacySessionSurfaces.failures,
      ...(legacyAgentDirInspection.status === "failed" ? [legacyAgentDirInspection.warning] : []),
      ...deferredWarnings,
    ],
    notices: deferredNotices,
    preview,
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
  kind?: "acp-session-metadata" | "legacy-main-session-keys";
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
  legacySessionSurfaces: PreparedLegacySessionSurfaces;
};

function buildLegacyStateMigrationSteps(
  params: LegacyStateMigrationPlan,
): LegacyStateMigrationStep[] {
  const { detected, env } = params;
  const stateDir = detected.stateDir;
  const now = params.now ?? (() => Date.now());
  const isDoctor = params.mode === "doctor";
  const repairSessionFiles =
    (isDoctor || params.doctorOnlyStateMigrations === true) && !params.skipAgentScopedMigrations;
  const sharedStep = (
    run: LegacyStateMigrationStep["run"],
    collectNotices = false,
  ): LegacyStateMigrationStep => ({ phase: "shared", run, collectNotices });
  const finalStep = (
    run: LegacyStateMigrationStep["run"],
    collectNotices = false,
  ): LegacyStateMigrationStep => ({ phase: "final", run, collectNotices });
  const ownerStep = <TDetection>(
    detection: TDetection,
    migrate: (options: {
      detected: TDetection;
      env: NodeJS.ProcessEnv;
      stateDir: string;
    }) => MigrationMessages | Promise<MigrationMessages>,
    phase: LegacyStateMigrationStep["phase"] = "final",
    collectNotices = true,
  ): LegacyStateMigrationStep => ({
    phase,
    collectNotices,
    run: () => migrate({ detected: detection, env, stateDir }),
  });

  const managedWorktreePrelude: LegacyStateMigrationStep[] = [
    finalStep(() => {
      const stateEnv = { ...env, OPENCLAW_STATE_DIR: stateDir };
      const discardedWorktrees =
        isDoctor && detected.worktrees.hasLegacy ? discardLegacyRegistryWorktrees(stateEnv) : 0;
      const canonicalizedWorktrees = rewriteRegistryWorktreePathsForMigration(
        stateEnv,
        detected.worktrees.pathRewrites,
      );
      return {
        changes: [
          ...(discardedWorktrees > 0
            ? [
                `Discarded ${discardedWorktrees} legacy managed worktree ${discardedWorktrees === 1 ? "row" : "rows"}; affected worktrees will provision fresh on next use`,
              ]
            : []),
          ...(canonicalizedWorktrees > 0
            ? [
                `Canonicalized ${canonicalizedWorktrees} managed worktree ${canonicalizedWorktrees === 1 ? "path" : "paths"} for symlinked state directories`,
              ]
            : []),
        ],
        warnings: [],
      };
    }),
  ];

  const sharedSteps: LegacyStateMigrationStep[] = [
    ownerStep(detected.sharedAuthStore, migrateSharedAuthStore, "shared"),
    sharedStep(() => migrateLegacyPluginStateSidecar({ stateDir })),
    sharedStep(() => migrateLegacyInstalledPluginIndex({ stateDir }), true),
    ownerStep(
      detected.debugProxyCaptureSidecar,
      migrateLegacyDebugProxyCaptureSidecar,
      "shared",
      false,
    ),
    sharedStep(() => migrateLegacyTaskStateSidecars({ stateDir })),
    sharedStep(() => migrateLegacyDeliveryQueues({ stateDir })),
    ownerStep(detected.voiceWake, migrateLegacyVoiceWakeSettings, "shared"),
    ownerStep(detected.updateCheck, migrateLegacyUpdateCheckState, "shared"),
    ownerStep(detected.configHealth, migrateLegacyConfigHealth, "shared", false),
    ownerStep(detected.pluginBindingApprovals, migrateLegacyPluginBindingApprovals, "shared"),
    ownerStep(
      detected.currentConversationBindings,
      migrateLegacyCurrentConversationBindings,
      "shared",
    ),
  ];

  const doctorStateSteps: LegacyStateMigrationStep[] = isDoctor
    ? [
        ownerStep(detected.tuiLastSessions, migrateLegacyTuiLastSessions),
        ...(detected.commitments
          ? [ownerStep(detected.commitments, migrateLegacyCommitments)]
          : []),
        ownerStep(detected.auditLogs, migrateLegacyAuditLogs),
        ownerStep(detected.acpReplayLedger, migrateLegacyAcpReplayLedger),
        ownerStep(detected.managedOutgoingImages, migrateLegacyManagedOutgoingImages),
        ownerStep(detected.apns, migrateLegacyApnsRegistrations),
        ownerStep(detected.deviceAuth, migrateLegacyDeviceAuth),
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
        ownerStep(detected.execApprovals, migrateLegacyExecApprovals),
        ownerStep(detected.mcpOauth, migrateLegacyMcpOAuthStores),
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
        ownerStep(detected.workspace, migrateLegacyWorkspaceState),
        ownerStep(detected.webPush, migrateLegacyWebPush),
        ownerStep(detected.nodeHost, migrateLegacyNodeHostConfig),
        ownerStep(detected.subagentRegistry, migrateLegacySubagentRegistry),
        ownerStep(detected.rescuePending, discardLegacyRescuePending, "final", false),
      ]
    : [];

  const finalSteps: LegacyStateMigrationStep[] = [
    ownerStep(detected.restartSentinel, migrateLegacyRestartSentinel),
    ...doctorFinalSteps,
    finalStep(() =>
      migrateLegacyChannelPairingState({
        detected: detected.channelPairing,
        env: { ...env, OPENCLAW_STATE_DIR: stateDir },
      }),
    ),
    finalStep(
      () =>
        isDoctor && detected.stateSchema.hasLegacy
          ? { changes: [], warnings: [] }
          : runPluginDoctorStateMigrationPlans({ detected, config: params.config, env }),
      true,
    ),
  ];

  if (repairSessionFiles) {
    finalSteps.push(
      finalStep(() =>
        migrateLegacySessions(detected, now, {
          recoverCorruptTargetStore: params.recoverCorruptTargetStore,
          legacySessionSurfaces: params.legacySessionSurfaces,
        }),
      ),
    );
  }
  if (!isDoctor) {
    finalSteps.push({
      ...finalStep(async () => {
        const result = await migrateLegacyMainSessionKeys({
          cfg: params.sessionConfig ?? params.config,
          env,
          mode: "automatic",
          now,
        });
        return { changes: result.changes, warnings: [], notices: result.warnings };
      }, true),
      kind: "legacy-main-session-keys",
    });
  }
  if (repairSessionFiles) {
    // ACP metadata must run once after sessions are canonicalized; otherwise
    // existing rows and newly imported rows generate conflicting repeat warnings.
    finalSteps.push({
      ...finalStep(() =>
        migrateLegacyAcpSessionMetadata({
          cfg: params.sessionConfig ?? params.config,
          env: isDoctor ? { ...env, OPENCLAW_STATE_DIR: stateDir } : env,
          now,
          ...(isDoctor ? {} : { pluginSessionStoreAgentIds: params.pluginSessionStoreAgentIds }),
          legacySessionSurfaces: params.legacySessionSurfaces,
        }),
      ),
      kind: "acp-session-metadata",
    });
  }
  if (!params.skipAgentScopedMigrations) {
    finalSteps.push(finalStep(() => migrateLegacyAgentDir(detected, now)));
  }

  return [...managedWorktreePrelude, ...sharedSteps, ...doctorStateSteps, ...finalSteps];
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
  legacySessionSurfaces: PreparedLegacySessionSurfaces;
}): Promise<MigrationMessages> {
  const detected = params.detected;
  const env = params.env ?? process.env;
  const config = params.config ?? ({} as OpenClawConfig);
  const legacySessionSurfaces = params.legacySessionSurfaces;
  const stateSchema = migrateLegacyStateSchema(detected, env);
  if (detected.stateSchema.hasLegacy && stateSchema.warnings.length > 0) {
    return stateSchema;
  }

  const migrations = await runLegacyStateMigrationSteps(
    buildLegacyStateMigrationSteps({
      mode: "doctor",
      detected,
      config,
      env,
      now: params.now,
      recoverCorruptTargetStore: params.recoverCorruptTargetStore,
      doctorOnlyStateMigrations: params.doctorOnlyStateMigrations,
      legacySessionSurfaces,
    }),
  );
  const notices = mergeNotices([
    ...migrations.sharedNoticeSources,
    ...migrations.finalNoticeSources,
  ]);
  return {
    changes: [...stateSchema.changes, ...migrations.sources.flatMap((source) => source.changes)],
    warnings: [
      ...new Set([
        ...stateSchema.warnings,
        ...detected.warnings,
        ...migrations.sources.flatMap((source) => source.warnings),
      ]),
    ],
    ...(notices.length > 0 ? { notices } : {}),
  };
}

/** Run canonical startup migrations and explicit Doctor-owned file repairs. */
export async function autoMigrateLegacyState(params: {
  cfg: OpenClawConfig;
  pluginDoctorConfig?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  log?: MigrationLogger;
  now?: () => number;
  recoverCorruptTargetStore?: boolean;
  doctorOnlyStateMigrations?: boolean;
  allowLegacyDeviceIdentityImport?: boolean;
  legacySessionSurfaces?: PreparedLegacySessionSurfaces;
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
    // A failed canonical schema repair is an error: runtime cannot safely open this store.
    if (params.doctorOnlyStateMigrations !== true) {
      throw new Error(formatStartupMigrationFailure(stateSchema.warnings));
    }
    return {
      migrated: stateDirResult.migrated || stateSchema.changes.length > 0,
      skipped: false,
      changes: [...stateDirResult.changes, ...stateSchema.changes],
      warnings: [...stateDirResult.warnings, ...stateSchema.warnings],
      ...(stateDirResult.notices?.length ? { notices: stateDirResult.notices } : {}),
    };
  }
  // Preserve retired locators before advisory early returns can permit config repair.
  const pluginDoctorConfig = params.pluginDoctorConfig ?? params.cfg;
  const configMachineState = migrateLegacyConfigMachineState({
    config: pluginDoctorConfig,
    env: { ...env, OPENCLAW_STATE_DIR: stateDir },
  });
  const agentMigrationOptions = {
    configuredAgentDatabaseTargets: resolveConfiguredAgentDatabaseTargets(params.cfg, { env }),
    env: { ...env, OPENCLAW_STATE_DIR: stateDir },
  };
  // Media owns the historical cutover and stopped-writer lease before current consumers.
  const mediaPersistence =
    params.doctorOnlyStateMigrations === true
      ? await migrateLegacyMediaPersistence(agentMigrationOptions)
      : { changes: [], warnings: [] };
  const transcriptDirectives =
    mediaPersistence.warnings.length === 0
      ? await migrateHistoricalTranscriptDirectives(agentMigrationOptions)
      : { changes: [], warnings: [] };
  if (transcriptDirectives.warnings.length > 0 || mediaPersistence.warnings.length > 0) {
    return {
      migrated:
        stateDirResult.migrated ||
        stateSchema.changes.length > 0 ||
        configMachineState.changes.length > 0 ||
        transcriptDirectives.changes.length > 0 ||
        mediaPersistence.changes.length > 0,
      skipped: false,
      changes: [
        ...stateDirResult.changes,
        ...stateSchema.changes,
        ...configMachineState.changes,
        ...transcriptDirectives.changes,
        ...mediaPersistence.changes,
      ],
      warnings: [
        ...stateDirResult.warnings,
        ...stateSchema.warnings,
        ...transcriptDirectives.warnings,
        ...mediaPersistence.warnings,
      ],
      ...(stateDirResult.notices?.length ? { notices: stateDirResult.notices } : {}),
    };
  }
  const profileWorkspace =
    params.doctorOnlyStateMigrations === true
      ? migrateLegacyProfileWorkspace({ env, homedir })
      : { changes: [], warnings: [] };
  const pluginSessionStoreAgentIds = listPluginDoctorSessionStoreAgentIds({
    config: pluginDoctorConfig,
    env,
    pluginIds: collectRelevantDoctorPluginIds(pluginDoctorConfig),
  });
  const legacySessionSurfaces =
    params.doctorOnlyStateMigrations === true
      ? (params.legacySessionSurfaces ??
        (await import("../plugins/legacy-session-surfaces.js")).prepareLegacySessionSurfaces({
          config: params.cfg,
          env,
        }))
      : EMPTY_LEGACY_SESSION_SURFACES;
  // Capture ownership before orphan-key rewrites. Atomic replacement can split
  // a configured filesystem alias from the standard target pathname.
  const ownershipAgentId =
    params.doctorOnlyStateMigrations === true
      ? tryResolveDoctorSessionMigrationAgentId(params.cfg)
      : undefined;
  const sessionStoreOwnership = ownershipAgentId
    ? resolveSessionStoreOwnership({
        cfg: params.cfg,
        env,
        stateDir,
        targetAgentId: ownershipAgentId,
        pluginSessionStoreAgentIds,
      })
    : undefined;
  const orphanKeys =
    params.doctorOnlyStateMigrations === true
      ? await migrateOrphanedSessionKeys({
          cfg: params.cfg,
          env,
          additionalAgentIds: pluginSessionStoreAgentIds,
          legacySessionSurfaces,
        })
      : { changes: [], warnings: [] };

  const detected = await detectLegacyStateMigrations({
    cfg: params.cfg,
    mode: params.doctorOnlyStateMigrations === true ? "doctor" : "automatic",
    pluginDoctorConfig: params.pluginDoctorConfig,
    pluginSessionStoreAgentIds,
    sessionStoreOwnership,
    env,
    homedir: params.homedir,
    doctorOnlyStateMigrations: params.doctorOnlyStateMigrations,
    allowLegacyDeviceIdentityImport: params.allowLegacyDeviceIdentityImport,
    legacySessionSurfaces,
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
    allowLegacyDeviceIdentityImport: params.allowLegacyDeviceIdentityImport,
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
    doctorOnlyStateMigrations: params.doctorOnlyStateMigrations,
    legacySessionSurfaces,
  });
  const initialMigrationSources = [
    stateDirResult,
    profileWorkspace,
    stateSchema,
    transcriptDirectives,
    mediaPersistence,
    configMachineState,
    orphanKeys,
  ];
  const initialMigrationWarnings = [
    ...initialMigrationSources.slice(0, -1).flatMap((source) => source.warnings),
    ...detected.warnings,
    ...orphanKeys.warnings,
  ];
  if (
    !hasCustomAgentDir &&
    !detected.sessions.hasLegacy &&
    !detected.agentDir.hasLegacy &&
    !detected.pluginPlans?.hasLegacy &&
    !detected.pluginStateSidecar.hasLegacy &&
    !detected.pluginInstallIndex.hasLegacy &&
    !detected.debugProxyCaptureSidecar.hasLegacy &&
    !detected.stateSchema.hasLegacy &&
    !detected.sharedAuthStore.hasLegacy &&
    !detected.worktrees.hasLegacy &&
    detected.worktrees.pathRewrites.length === 0 &&
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
    // SQLite key migration and Doctor's standalone ACP repair can have no file preview.
    // Preserve their convergence even when the other detectors have no work.
    const alwaysRunSources: MigrationMessages[] = [];
    for (const step of migrationSteps) {
      if (step.kind === "legacy-main-session-keys" || step.kind === "acp-session-metadata") {
        alwaysRunSources.push(await step.run());
      }
    }
    const completedSources = [
      ...initialMigrationSources,
      ...alwaysRunSources,
      deviceAuth,
      deviceIdentity,
      meetingTranscripts,
    ];
    const changes = completedSources.flatMap((source) => source.changes);
    const warnings = [
      ...new Set([
        ...initialMigrationWarnings,
        ...[...alwaysRunSources, deviceAuth, deviceIdentity, meetingTranscripts].flatMap(
          (source) => source.warnings,
        ),
      ]),
    ];
    const notices = mergeNotices([
      stateDirResult,
      detected,
      ...alwaysRunSources,
      deviceAuth,
      deviceIdentity,
    ]);
    logStateMigrationResult({ changes, warnings, notices }, params.log);
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
    ...new Set([
      ...initialMigrationWarnings,
      ...migrations.sharedSources.flatMap((source) => source.warnings),
      ...deviceAuth.warnings,
      ...deviceIdentity.warnings,
      ...(hasCustomAgentDir ? [] : meetingTranscripts.warnings),
      ...migrations.finalSources.flatMap((source) => source.warnings),
    ]),
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
  logStateMigrationResult({ changes, warnings, notices }, params.log);
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
