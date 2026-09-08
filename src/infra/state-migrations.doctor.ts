import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listAgentIds, tryResolveAmbientOwnerAgentId } from "../agents/agent-scope-config.js";
import { resolveSharedMainAuthAgentDir } from "../agents/auth-profiles/shared-main-dir.js";
import {
  discardLegacyRegistryWorktrees,
  listLegacyRegistryWorktreesForMigration,
  listRegistryWorktreesForMigration,
  rewriteRegistryWorktreePathsForMigration,
} from "../agents/worktrees/registry.js";
import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import { getChannelPlugin } from "../channels/plugins/registry.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import { migrateLegacySkillWorkshopProposals } from "../commands/doctor-skill-workshop-sqlite.js";
import { resolveSessionStoreCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import { resolveConfigPath, resolveOAuthDir, resolveStateDir } from "../config/paths.js";
import { migrateLegacyMainSessionKeys } from "../config/sessions/legacy-main-session-migration.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { isPerAgentSessionStoreConfig } from "../config/sessions/session-store-config.js";
import {
  listConfiguredSessionStoreAgentIds,
  resolveAllAgentSessionStoreCandidateTargetsSync,
  resolveConfiguredAgentDatabaseTargets,
} from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  collectRelevantDoctorPluginIds,
  listPluginDoctorSessionStoreAgentIds,
  type PluginDoctorStateMigrationInventory,
  resolveLivePluginDoctorStateMigrationInventory,
  resolvePluginDoctorStateMigrationInventory,
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
import { inspectOpenClawRegisteredAgentDatabases } from "../state/openclaw-agent-db-registry.js";
import {
  detectOpenClawStateDatabaseSchemaMigrations,
  repairOpenClawStateDatabaseSchema,
  repairOpenClawStateDatabaseSchemaIfNeeded,
  type OpenClawStateDatabaseSchemaMigration,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { resolveIdentityPathViaExistingAncestorSync } from "./boundary-path.js";
import { isPathInside } from "./path-guards.js";
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
  createLegacyStateMigrationStepReceipt,
  formatStartupMigrationFailure,
  logStateMigrationResult,
  mergeNotices,
} from "./state-migrations.messages.js";
import {
  detectLegacyNodeHostConfig,
  migrateLegacyNodeHostConfig,
} from "./state-migrations.node-host.js";
import {
  captureLegacyStateSnapshotIdentity,
  createLegacyStateMigrationCallerEnv,
  createLegacyStateMigrationPlanEnv,
  createLegacyStateMigrationPlan,
  readLegacyStateMigrationPlanConfig,
  refuseLegacyStateMigrationPlan,
  type PreparedLegacyStateMigrationStep,
} from "./state-migrations.plan.js";
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
  resolveLegacyProfileWorkspaceMigrationPaths,
  resolvePendingLegacyStateDirMigrationPaths,
  resolvePendingLegacyProfileWorkspaceMigrationPaths,
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
  LegacyStateMigrationEndpoint,
  LegacyStateMigrationMode,
  LegacyStateMigrationPlan,
  LegacyStateMigrationStepReceipt,
  MigrationLogger,
  MigrationMessages,
  PlannedPluginDoctorAction,
  PreparedPostSessionPluginMigration,
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
      return "Skill Workshop ownership → per-agent directory containment";
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

function hasCustomAgentDirOverride(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.OPENCLAW_AGENT_DIR?.trim() || env.PI_CODING_AGENT_DIR?.trim());
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
  doctorOnlyStateMigrations?: boolean;
  artifactPreservingReadOnly?: boolean;
}): Promise<LegacyStateDetection["worktrees"]> {
  const rawRoot = path.join(params.stateDir, "worktrees");
  const stateEnv = { ...params.env, OPENCLAW_STATE_DIR: params.stateDir };
  const databaseExists = migrationFileExists(resolveOpenClawStateSqlitePath(stateEnv));
  const legacyIds =
    params.doctorOnlyStateMigrations === true && databaseExists
      ? listLegacyRegistryWorktreesForMigration(stateEnv, {
          artifactPreservingReadOnly: params.artifactPreservingReadOnly,
        }).map((worktree) => worktree.id)
      : [];
  const hasLegacy = legacyIds.length > 0;
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
        return { hasLegacy, legacyIds, pathRewrites: [] };
      }
      throw stateDirError;
    }
  }
  if (rawRoot === canonicalRoot || !databaseExists) {
    return { hasLegacy, legacyIds, pathRewrites: [] };
  }
  const pathRewrites = listRegistryWorktreesForMigration(stateEnv, {
    artifactPreservingReadOnly: params.artifactPreservingReadOnly,
  }).flatMap((row) => {
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
  return { hasLegacy, legacyIds, pathRewrites };
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
  /** Candidate planning must not load plugin-owned Doctor contracts. */
  pluginPlanning?: "enabled" | "deferred";
  /** Candidate planning must not update SQLite coordination artifacts or runtime caches. */
  artifactPreservingReadOnly?: boolean;
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
  const pluginPlanningEnabled = params.pluginPlanning !== "deferred";
  const pluginSessionStoreAgentIds =
    params.pluginSessionStoreAgentIds ??
    (pluginPlanningEnabled
      ? listPluginDoctorSessionStoreAgentIds({
          config: pluginConfig,
          env,
          pluginIds: collectRelevantDoctorPluginIds(pluginConfig),
        })
      : []);
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
  const stateSchemaMigrations = detectOpenClawStateDatabaseSchemaMigrations(
    { env: { ...env, OPENCLAW_STATE_DIR: stateDir } },
    { artifactPreservingReadOnly: params.artifactPreservingReadOnly },
  );
  const worktrees = await detectManagedWorktreeStateMigration({
    env,
    stateDir,
    doctorOnlyStateMigrations: params.doctorOnlyStateMigrations,
    artifactPreservingReadOnly: params.artifactPreservingReadOnly,
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
    artifactPreservingReadOnly: params.artifactPreservingReadOnly,
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
    artifactPreservingReadOnly: params.artifactPreservingReadOnly,
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
    deferConfiguredAccountDiscovery: !pluginPlanningEnabled,
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
          const plugin = pluginPlanningEnabled
            ? getChannelPlugin(channelId as ChannelId)
            : undefined;
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
            const plugin = pluginPlanningEnabled
              ? getChannelPlugin(channelId as ChannelId)
              : undefined;
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
    stateSchemaMigrations.length > 0 || !pluginPlanningEnabled
      ? []
      : await collectPluginDoctorStateMigrationPlans(
          { config: pluginConfig, env, stateDir, oauthDir },
          {
            includeDoctorOnly: params.doctorOnlyStateMigrations === true,
            warnings: pluginPlanWarnings,
            // Keep preview facts so execution can receipt the exact frozen endpoints.
            // The writer validates every declared action before phase filtering.
            validateDeclarations: false,
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
    pluginSessionStoreAgentIds,
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

type LegacyStateMigrationStep = PreparedLegacyStateMigrationStep & {
  runWithoutFileDetection?: boolean;
  collectNotices?: boolean;
  deferredExecution?: {
    kind: "post-session-plugin";
    plannedActions: readonly PlannedPluginDoctorAction[];
  };
  run: () => MigrationMessages | Promise<MigrationMessages>;
};

const unresolvedMigrationStepLayout = [
  ["device-auth", "shared", "all"],
  ["device-identity", "shared", "all"],
  ["meeting-transcripts", "shared", "all"],
  ["managed-worktrees", "shared", "all"],
  ["shared-auth-store", "shared", "all"],
  ["plugin-state-sidecar", "shared", "all"],
  ["debug-proxy-capture", "shared", "all"],
  ["task-state-sidecars", "shared", "all"],
  ["delivery-queues", "shared", "all"],
  ["voice-wake", "shared", "all"],
  ["update-check", "shared", "all"],
  ["config-health", "shared", "all"],
  ["plugin-binding-approvals", "shared", "all"],
  ["current-conversation-bindings", "shared", "all"],
  ["tui-last-session", "final", "doctor"],
  ["commitments", "final", "doctor"],
  ["audit-logs", "final", "doctor"],
  ["acp-replay-ledger", "final", "doctor"],
  ["managed-outgoing-images", "final", "doctor"],
  ["apns-registrations", "final", "doctor"],
  ["exec-approvals", "final", "doctor"],
  ["mcp-oauth", "final", "doctor"],
  ["restart-sentinel", "final", "all"],
  ["workspace-state", "final", "all"],
  ["web-push", "final", "doctor"],
  ["node-host", "final", "doctor"],
  ["subagent-registry", "final", "doctor"],
  ["rescue-pending", "final", "doctor"],
  ["skill-workshop", "final", "all"],
  ["channel-pairing", "final", "all"],
  ["plugin-doctor-state", "final", "all"],
  ["sessions", "final", "doctor-agent"],
  ["legacy-main-session-keys", "final", "automatic"],
  ["acp-session-metadata", "final", "doctor-agent"],
  ["agent-dir", "final", "agent"],
  ["plugin-doctor-post-session-state", "final", "doctor"],
] as const satisfies ReadonlyArray<
  readonly [
    id: string,
    phase: LegacyStateMigrationStep["phase"],
    scope: "all" | "doctor" | "automatic" | "doctor-agent" | "agent",
  ]
>;

type PlannedPluginStateMigrationDescriptor = {
  actions: PluginDoctorStateMigrationInventory["descriptors"];
  source: LegacyStateMigrationEndpoint[];
  target: LegacyStateMigrationEndpoint[];
  requiredness: PreparedLegacyStateMigrationStep["requiredness"];
  refusal?: PreparedLegacyStateMigrationStep["refusal"];
};

function buildPlannedPluginStateMigrationDescriptor(params: {
  inventory: PluginDoctorStateMigrationInventory;
  mode: LegacyStateMigrationMode;
  phase?: "after-session-repair";
}): PlannedPluginStateMigrationDescriptor {
  const actions = params.inventory.descriptors.filter(
    (descriptor) =>
      descriptor.phase === params.phase &&
      (params.mode === "doctor" || descriptor.doctorOnly !== true),
  );
  const unresolvedPluginIds = params.inventory.unresolvedPluginIds;
  const source = [
    ...actions.map((descriptor) => ({
      kind: "owner" as const,
      id: `plugin:${descriptor.pluginId}:${descriptor.id}`,
    })),
    ...unresolvedPluginIds.map((pluginId) => ({
      kind: "owner" as const,
      id: `plugin:${pluginId}:state-migrations`,
    })),
  ];
  const target = [
    ...new Set([...actions.map((descriptor) => descriptor.pluginId), ...unresolvedPluginIds]),
  ].map((pluginId) => ({
    kind: "owner" as const,
    id: `plugin:${pluginId}:doctor-state`,
  }));
  return {
    actions,
    source,
    target,
    requiredness:
      source.length > 0 || params.inventory.resolutionFailure ? "conditional" : "not-required",
    ...(params.inventory.resolutionFailure
      ? { refusal: params.inventory.resolutionFailure }
      : unresolvedPluginIds.length > 0
        ? {
            refusal: {
              code: "plugin-planning-deferred",
              message: `Plugin migration identities are not declared for: ${unresolvedPluginIds.join(", ")}.`,
            },
          }
        : {}),
  };
}

function buildUnresolvedBlockedMigrationSteps(params: {
  mode: LegacyStateMigrationMode;
  skipAgentScopedMigrations: boolean;
  pluginStateMigrationInventory?: PluginDoctorStateMigrationInventory;
}): LegacyStateMigrationStep[] {
  return unresolvedMigrationStepLayout.flatMap(([id, phase, scope]) => {
    const included =
      scope === "all" ||
      (scope === "doctor" && params.mode === "doctor") ||
      (scope === "automatic" && params.mode === "automatic") ||
      (scope === "doctor-agent" && params.mode === "doctor" && !params.skipAgentScopedMigrations) ||
      (scope === "agent" && !params.skipAgentScopedMigrations);
    if (!included) {
      return [];
    }
    const pluginDescriptor =
      (id === "plugin-doctor-state" || id === "plugin-doctor-post-session-state") &&
      params.pluginStateMigrationInventory
        ? buildPlannedPluginStateMigrationDescriptor({
            inventory: params.pluginStateMigrationInventory,
            mode: params.mode,
            ...(id === "plugin-doctor-post-session-state"
              ? { phase: "after-session-repair" as const }
              : {}),
          })
        : undefined;
    return [
      {
        id,
        phase,
        // Artifact endpoints are unknowable after detection itself fails. Empty
        // endpoints preserve that fact while the receipt closes every stable owner.
        source: pluginDescriptor?.source ?? [],
        target: pluginDescriptor?.target ?? [],
        requiredness: pluginDescriptor?.requiredness ?? "conditional",
        reversibility: "checkpoint-required",
        run: () => ({ changes: [], warnings: [] }),
      },
    ];
  });
}

function buildUnresolvedBlockedPreludeSteps(
  mode: LegacyStateMigrationMode,
): LegacyStateMigrationStep[] {
  const ids =
    mode === "automatic"
      ? ["transcript-directives"]
      : [
          "media-persistence",
          "transcript-directives",
          "profile-workspace",
          "plugin-migration-preparation",
          "orphan-session-keys",
        ];
  return ids.map((id) => ({
    id,
    phase: "shared",
    source: [],
    target: [],
    requiredness: "conditional",
    reversibility: "checkpoint-required",
    run: () => ({ changes: [], warnings: [] }),
  }));
}

function createStateSchemaMigrationStep(params: {
  stateDir: string;
  env: NodeJS.ProcessEnv;
  mode: LegacyStateMigrationMode;
  requiredness: PreparedLegacyStateMigrationStep["requiredness"];
}): LegacyStateMigrationStep {
  const stateEnv = { ...params.env, OPENCLAW_STATE_DIR: params.stateDir };
  const database: LegacyStateMigrationEndpoint = {
    kind: "sqlite",
    path: resolveOpenClawStateSqlitePath(stateEnv),
  };
  return {
    id: "state-schema",
    phase: "shared",
    source: [database],
    target: [database],
    requiredness: params.requiredness,
    reversibility: "checkpoint-required",
    run: () =>
      params.mode === "doctor"
        ? repairOpenClawStateDatabaseSchema({ env: stateEnv })
        : repairOpenClawStateDatabaseSchemaIfNeeded({ env: stateEnv }),
  };
}

function createPluginInstallIndexStep(params: {
  stateDir: string;
  env: NodeJS.ProcessEnv;
  hasLegacy: boolean;
}): LegacyStateMigrationStep {
  return {
    id: "plugin-install-index",
    phase: "shared",
    source: [{ kind: "path", path: resolveLegacyInstalledPluginIndexStorePath(params) }],
    target: [
      {
        kind: "sqlite",
        path: resolveOpenClawStateSqlitePath({
          ...params.env,
          OPENCLAW_STATE_DIR: params.stateDir,
        }),
      },
    ],
    requiredness: params.hasLegacy ? "required" : "not-required",
    reversibility: "checkpoint-required",
    collectNotices: true,
    run: () => migrateLegacyInstalledPluginIndex({ stateDir: params.stateDir }),
  };
}

function createAgentTargetDiscoveryStep(params: {
  configPath: string;
  configIncludedPaths: readonly string[];
  stateDir: string;
  env: NodeJS.ProcessEnv;
  run: LegacyStateMigrationStep["run"];
  refusal?: PreparedLegacyStateMigrationStep["refusal"];
}): LegacyStateMigrationStep {
  return {
    id: "agent-migration-targets",
    phase: "shared",
    source: [
      ...createConfigMigrationSources(params.configPath, params.configIncludedPaths),
      {
        kind: "sqlite",
        path: resolveOpenClawStateSqlitePath({
          ...params.env,
          OPENCLAW_STATE_DIR: params.stateDir,
        }),
      },
      { kind: "path", path: path.join(params.stateDir, "agents") },
    ],
    target: [],
    requiredness: "required",
    reversibility: "not-applicable",
    ...(params.refusal ? { refusal: params.refusal } : {}),
    run: params.run,
  };
}

function createConfigMachineStateStep(params: {
  config: OpenClawConfig;
  configPath: string;
  configIncludedPaths: readonly string[];
  stateDir: string;
  env: NodeJS.ProcessEnv;
}): LegacyStateMigrationStep {
  const stateEnv = { ...params.env, OPENCLAW_STATE_DIR: params.stateDir };
  return {
    id: "config-machine-state",
    phase: "shared",
    source: createConfigMigrationSources(params.configPath, params.configIncludedPaths),
    target: [{ kind: "sqlite", path: resolveOpenClawStateSqlitePath(stateEnv) }],
    requiredness: "conditional",
    reversibility: "checkpoint-required",
    run: () => migrateLegacyConfigMachineState({ config: params.config, env: stateEnv }),
  };
}

function createMigrationDetectionStep(params: {
  configPath: string;
  configIncludedPaths: readonly string[];
  stateDir: string;
  run: LegacyStateMigrationStep["run"];
  refusal?: PreparedLegacyStateMigrationStep["refusal"];
}): LegacyStateMigrationStep {
  return {
    id: "migration-detection",
    phase: "shared",
    source: [
      ...createConfigMigrationSources(params.configPath, params.configIncludedPaths),
      { kind: "path", path: params.stateDir },
    ],
    target: [],
    requiredness: "required",
    reversibility: "not-applicable",
    ...(params.refusal ? { refusal: params.refusal } : {}),
    run: params.run,
  };
}

function createPluginMigrationPreparationStep(params: {
  configPath: string;
  configIncludedPaths: readonly string[];
  pluginIds: readonly string[];
  run: LegacyStateMigrationStep["run"];
  refusal?: PreparedLegacyStateMigrationStep["refusal"];
}): LegacyStateMigrationStep {
  return {
    id: "plugin-migration-preparation",
    phase: "shared",
    source: [
      ...createConfigMigrationSources(params.configPath, params.configIncludedPaths),
      ...params.pluginIds.map((pluginId): LegacyStateMigrationEndpoint => ({
        kind: "owner",
        id: `plugin:${pluginId}`,
      })),
    ],
    target: [],
    requiredness: "required",
    reversibility: "not-applicable",
    ...(params.refusal ? { refusal: params.refusal } : {}),
    run: params.run,
  };
}

function uniqueMigrationEndpoints(
  endpoints: readonly LegacyStateMigrationEndpoint[],
): LegacyStateMigrationEndpoint[] {
  const seen = new Set<string>();
  return endpoints.filter((endpoint) => {
    const key =
      endpoint.kind === "owner" ? `owner\0${endpoint.id}` : `${endpoint.kind}\0${endpoint.path}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function listMigrationEndpointsOutsideRoot(
  endpoints: readonly LegacyStateMigrationEndpoint[],
  root: string,
): LegacyStateMigrationEndpoint[] {
  const resolvedRoot = path.resolve(root);
  const identityRoot = resolveIdentityPathViaExistingAncestorSync(resolvedRoot);
  return uniqueMigrationEndpoints(
    endpoints.filter((endpoint) => {
      if (endpoint.kind === "owner") {
        return false;
      }
      const resolvedPath = path.resolve(endpoint.path);
      const identityPath = resolveIdentityPathViaExistingAncestorSync(resolvedPath);
      return (
        (resolvedPath !== resolvedRoot && !isPathInside(resolvedRoot, resolvedPath)) ||
        (identityPath !== identityRoot && !isPathInside(identityRoot, identityPath))
      );
    }),
  );
}

function createSessionTargetOutsideSnapshotRefusal(
  endpoints: readonly LegacyStateMigrationEndpoint[],
): NonNullable<PreparedLegacyStateMigrationStep["refusal"]> {
  return {
    code: "session-target-outside-snapshot",
    message: `Configured session migration endpoints are outside the copied state root and require a separately bound snapshot: ${endpoints
      .map((endpoint) => (endpoint.kind === "owner" ? endpoint.id : path.resolve(endpoint.path)))
      .toSorted()
      .join(", ")}`,
  };
}

function createDeferredPluginSessionStoreRefusal(
  endpoints: readonly LegacyStateMigrationEndpoint[],
): PreparedLegacyStateMigrationStep["refusal"] | undefined {
  return endpoints.length > 0
    ? {
        code: "plugin-planning-deferred",
        message: "Plugin-owned session migration targets are deferred to candidate validation.",
      }
    : undefined;
}

function createDeferredPluginSessionStoreEndpoints(
  config: OpenClawConfig,
  inventory: PluginDoctorStateMigrationInventory,
): LegacyStateMigrationEndpoint[] {
  const knownPluginIds = new Set(inventory.knownPluginIds);
  const sessionStoreOwnerPluginIds = new Set(inventory.sessionStoreOwnerPluginIds);
  return collectRelevantDoctorPluginIds(config)
    .filter((pluginId) => !knownPluginIds.has(pluginId) || sessionStoreOwnerPluginIds.has(pluginId))
    .map((pluginId) => ({
      kind: "owner",
      id: `plugin:${pluginId}:session-store`,
    }));
}

function createPluginMigrationPreparationRefusal(params: {
  inventory: PluginDoctorStateMigrationInventory;
  deferredSessionStoreEndpoints: readonly LegacyStateMigrationEndpoint[];
}): PreparedLegacyStateMigrationStep["refusal"] | undefined {
  if (
    params.deferredSessionStoreEndpoints.length === 0 &&
    params.inventory.unresolvedPluginIds.length === 0
  ) {
    return undefined;
  }
  return {
    code: "plugin-planning-deferred",
    message:
      "Plugin migration preparation requires candidate-bound plugin and session-store descriptors.",
  };
}

function resolveConfiguredSessionStoreEndpoints(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): LegacyStateMigrationEndpoint[] {
  return uniqueMigrationEndpoints(
    [
      ...new Set([
        ...listConfiguredSessionStoreAgentIds(config),
        resolveSessionStoreCompatibilityAgentId(config),
      ]),
    ].map((agentId) => ({
      kind: "path" as const,
      path: resolveSessionStorePathCore(config.session?.store, { agentId, env }),
    })),
  );
}

function bindAgentDatabaseTargetsToStateRoot(
  targets: readonly { agentId: string; path: string }[],
  stateDir: string,
): {
  targets: Array<{ agentId: string; path: string }>;
  outsideEndpoints: LegacyStateMigrationEndpoint[];
  refusal?: PreparedLegacyStateMigrationStep["refusal"];
} {
  const outsideEndpoints = listMigrationEndpointsOutsideRoot(
    targets.map(({ path: databasePath }) => ({
      kind: "sqlite" as const,
      path: databasePath,
    })),
    stateDir,
  );
  const outsidePaths = new Set(
    outsideEndpoints.flatMap((endpoint) =>
      endpoint.kind === "owner" ? [] : [path.resolve(endpoint.path)],
    ),
  );
  if (outsidePaths.size === 0) {
    return { targets: [...targets], outsideEndpoints: [] };
  }
  return {
    targets: targets.filter((target) => !outsidePaths.has(path.resolve(target.path))),
    outsideEndpoints,
    refusal: createSessionTargetOutsideSnapshotRefusal(outsideEndpoints),
  };
}

function createConfigMigrationSources(
  configPath: string,
  includedPaths: readonly string[],
): LegacyStateMigrationEndpoint[] {
  return uniqueMigrationEndpoints(
    [configPath, ...includedPaths].map((inputPath) => ({
      kind: "path" as const,
      path: path.resolve(inputPath),
    })),
  );
}

function inspectOrphanSessionStoreEndpoints(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  pluginSessionStoreAgentIds: readonly string[];
  registeredDatabases?: readonly { agentId: string; path: string }[];
}): { endpoints: LegacyStateMigrationEndpoint[]; warnings: string[] } {
  try {
    const paths = resolveAllAgentSessionStoreCandidateTargetsSync(params.config, {
      env: params.env,
      registeredDatabases: params.registeredDatabases,
    }).map((target) => target.storePath);
    for (const agentId of params.pluginSessionStoreAgentIds) {
      paths.push(
        resolveSessionStorePathCore(params.config.session?.store, {
          agentId,
          env: params.env,
        }),
      );
    }
    return {
      endpoints: uniqueMigrationEndpoints(
        paths
          .filter((storePath) => !storePath.endsWith(".sqlite"))
          .map((storePath) => ({ kind: "path" as const, path: storePath })),
      ),
      warnings: [],
    };
  } catch (error) {
    return {
      endpoints: [{ kind: "owner", id: "core:session-store-targets" }],
      warnings: [`Could not inspect session migration targets: ${String(error)}`],
    };
  }
}

function buildLegacyStateMigrationPreludeSteps(params: {
  mode: LegacyStateMigrationMode;
  config: OpenClawConfig;
  configPath: string;
  configIncludedPaths: readonly string[];
  stateDir: string;
  env: NodeJS.ProcessEnv;
  homedir: () => string;
  agentDatabaseTargets: readonly { agentId: string; path: string }[];
  registeredDatabases?: readonly { agentId: string; path: string }[];
  pluginSessionStoreAgentIds: readonly string[];
  legacySessionSurfaces: PreparedLegacySessionSurfaces;
  deferredPluginSessionStoreEndpoints?: readonly LegacyStateMigrationEndpoint[];
  readOnlyPlanning?: boolean;
  pluginPreparation?: LegacyStateMigrationStep;
}): LegacyStateMigrationStep[] {
  const stateEnv = { ...params.env, OPENCLAW_STATE_DIR: params.stateDir };
  const stateDatabase: LegacyStateMigrationEndpoint = {
    kind: "sqlite",
    path: resolveOpenClawStateSqlitePath(stateEnv),
  };
  const configSources = createConfigMigrationSources(params.configPath, params.configIncludedPaths);
  const agentPersistence = uniqueMigrationEndpoints([
    stateDatabase,
    { kind: "path", path: path.join(params.stateDir, "agents") },
    ...params.agentDatabaseTargets.map(({ path: databasePath }): LegacyStateMigrationEndpoint => ({
      kind: "sqlite",
      path: databasePath,
    })),
  ]);
  const sharedStep = (
    id: string,
    source: LegacyStateMigrationEndpoint[],
    target: LegacyStateMigrationEndpoint[],
    run: LegacyStateMigrationStep["run"],
    refusal?: PreparedLegacyStateMigrationStep["refusal"],
    requiredness: PreparedLegacyStateMigrationStep["requiredness"] = "conditional",
  ): LegacyStateMigrationStep => ({
    id,
    phase: "shared",
    source,
    target,
    requiredness,
    reversibility: "checkpoint-required",
    ...(refusal ? { refusal } : {}),
    run,
  });
  const agentMigrationOptions = {
    configuredAgentDatabaseTargets: params.agentDatabaseTargets,
    env: stateEnv,
  };
  const steps: LegacyStateMigrationStep[] = [];
  if (params.mode === "doctor") {
    steps.push(
      sharedStep("media-persistence", agentPersistence, agentPersistence, () =>
        migrateLegacyMediaPersistence(agentMigrationOptions),
      ),
    );
  }
  steps.push(
    sharedStep("transcript-directives", agentPersistence, agentPersistence, () =>
      migrateHistoricalTranscriptDirectives(agentMigrationOptions),
    ),
  );
  if (params.mode !== "doctor") {
    return steps;
  }
  const profileWorkspace = (
    params.readOnlyPlanning
      ? resolveLegacyProfileWorkspaceMigrationPaths
      : resolvePendingLegacyProfileWorkspaceMigrationPaths
  )({ env: params.env, homedir: params.homedir });
  const profileRefusal =
    profileWorkspace && params.readOnlyPlanning
      ? {
          code: "profile-workspace-snapshot-deferred",
          message:
            "Profile workspace migration is outside the bound state root and requires a separately bound snapshot.",
        }
      : undefined;
  steps.push(
    sharedStep(
      "profile-workspace",
      profileWorkspace ? [{ kind: "path", path: profileWorkspace.source }] : [],
      profileWorkspace ? [{ kind: "path", path: profileWorkspace.target }] : [],
      () => migrateLegacyProfileWorkspace({ env: params.env, homedir: params.homedir }),
      profileRefusal,
      profileWorkspace ? "conditional" : "not-required",
    ),
  );
  if (params.pluginPreparation) {
    steps.push(params.pluginPreparation);
  }
  const orphanSessionStores = inspectOrphanSessionStoreEndpoints({
    config: params.config,
    env: stateEnv,
    pluginSessionStoreAgentIds: params.pluginSessionStoreAgentIds,
    registeredDatabases: params.registeredDatabases,
  });
  const deferredPluginOwners = params.deferredPluginSessionStoreEndpoints ?? [];
  const orphanTargets = uniqueMigrationEndpoints([
    ...orphanSessionStores.endpoints,
    ...deferredPluginOwners,
  ]);
  const pluginRefusal =
    orphanSessionStores.warnings.length > 0
      ? {
          code: "session-target-discovery-failed",
          message: orphanSessionStores.warnings.join("\n"),
        }
      : createDeferredPluginSessionStoreRefusal(deferredPluginOwners);
  steps.push(
    sharedStep(
      "orphan-session-keys",
      uniqueMigrationEndpoints([...configSources, ...orphanTargets]),
      orphanTargets,
      () =>
        orphanSessionStores.warnings.length > 0
          ? { changes: [], warnings: orphanSessionStores.warnings }
          : migrateOrphanedSessionKeys({
              cfg: params.config,
              env: stateEnv,
              additionalAgentIds: params.pluginSessionStoreAgentIds,
              legacySessionSurfaces: params.legacySessionSurfaces,
            }),
      pluginRefusal,
    ),
  );
  return steps;
}

type LegacyStateMigrationExecutionPlan = {
  mode: LegacyStateMigrationMode;
  detected: LegacyStateDetection;
  config: OpenClawConfig;
  sessionConfig?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  now?: () => number;
  agentDatabaseEndpoints?: LegacyStateMigrationEndpoint[];
  legacySessionStoreEndpoints?: LegacyStateMigrationEndpoint[];
  legacySessionStoreRefusal?: PreparedLegacyStateMigrationStep["refusal"];
  recoverCorruptTargetStore?: boolean;
  allowLegacyDeviceIdentityImport?: boolean;
  skipAgentScopedMigrations?: boolean;
  pluginStateMigrationInventory?: PluginDoctorStateMigrationInventory;
  deferPostSessionPluginMigrations?: boolean;
  legacySessionSurfaces: PreparedLegacySessionSurfaces;
  beforeWorkspaceStateMigration?: (config: OpenClawConfig) => Promise<void>;
};

function buildLegacyStateMigrationSteps(
  params: LegacyStateMigrationExecutionPlan,
): LegacyStateMigrationStep[] {
  const { detected, env } = params;
  const stateDir = detected.stateDir;
  const stateDatabase: LegacyStateMigrationEndpoint = {
    kind: "sqlite",
    path: resolveOpenClawStateSqlitePath({ ...env, OPENCLAW_STATE_DIR: stateDir }),
  };
  const now = params.now ?? (() => Date.now());
  const isDoctor = params.mode === "doctor";
  const repairSessionFiles = isDoctor && !params.skipAgentScopedMigrations;
  const pathEndpoints = (...paths: Array<string | undefined>): LegacyStateMigrationEndpoint[] =>
    paths.flatMap((entry) => (entry ? [{ kind: "path" as const, path: entry }] : []));
  const sqliteEndpoints = (...paths: Array<string | undefined>): LegacyStateMigrationEndpoint[] =>
    paths.flatMap((entry) => (entry ? [{ kind: "sqlite" as const, path: entry }] : []));
  type StepSpec = readonly [
    source: LegacyStateMigrationEndpoint[],
    required: boolean | PreparedLegacyStateMigrationStep["requiredness"],
    target?: LegacyStateMigrationEndpoint[],
    reversibility?: PreparedLegacyStateMigrationStep["reversibility"],
  ];
  // Detection owns plugin session-store discovery. Carry the prepared owner set
  // into receipts and execution so planning cannot observe a different plugin load.
  const pluginSessionStoreAgentIds = detected.pluginSessionStoreAgentIds;
  const legacySessionStores =
    params.legacySessionStoreEndpoints ??
    inspectOrphanSessionStoreEndpoints({
      config: params.sessionConfig ?? params.config,
      env,
      pluginSessionStoreAgentIds,
    }).endpoints;
  const agentDatabases = params.agentDatabaseEndpoints ?? [
    { kind: "owner" as const, id: "configured-agent-databases" },
  ];
  const canonicalSessionStores = uniqueMigrationEndpoints([
    ...legacySessionStores,
    ...agentDatabases,
  ]);
  // Interactive Doctor confirmation can authorize core migrations without --fix.
  // Plugin doctor-only actions retain detection's explicit-repair authority.
  const pluginMigrationMode = detected.doctorOnlyStateMigrations === true ? "doctor" : "automatic";
  const plannedPluginDescriptor = params.pluginStateMigrationInventory
    ? buildPlannedPluginStateMigrationDescriptor({
        inventory: params.pluginStateMigrationInventory,
        mode: pluginMigrationMode,
      })
    : undefined;
  const plannedPostSessionPluginDescriptor = params.pluginStateMigrationInventory
    ? buildPlannedPluginStateMigrationDescriptor({
        inventory: params.pluginStateMigrationInventory,
        mode: pluginMigrationMode,
        phase: "after-session-repair",
      })
    : undefined;
  const pluginMigrationSources = plannedPluginDescriptor
    ? plannedPluginDescriptor.source
    : (detected.pluginPlans?.plans ?? []).map((plan) => ({
        kind: "owner" as const,
        id: `plugin:${plan.pluginId}:${plan.migration.id}`,
      }));
  const pluginMigrationTargets = plannedPluginDescriptor
    ? plannedPluginDescriptor.target
    : [...new Set((detected.pluginPlans?.plans ?? []).map((plan) => plan.pluginId))].map(
        (pluginId) => ({
          kind: "owner" as const,
          id: `plugin:${pluginId}:doctor-state`,
        }),
      );
  const stepSpecs = {
    "managed-worktrees": [
      [
        stateDatabase,
        ...[
          ...new Set([
            ...detected.worktrees.legacyIds,
            ...detected.worktrees.pathRewrites.map((rewrite) => rewrite.id),
          ]),
        ]
          .toSorted()
          .map((id) => ({
            kind: "owner" as const,
            id: `core:managed-worktree:${id}`,
          })),
      ],
      (isDoctor && detected.worktrees.hasLegacy) || detected.worktrees.pathRewrites.length > 0,
      [stateDatabase],
    ],
    "shared-auth-store": [
      detected.sharedAuthStore.sourcePath
        ? [{ kind: "sqlite" as const, path: detected.sharedAuthStore.sourcePath }]
        : [],
      detected.sharedAuthStore.sourcePath ? "conditional" : false,
    ],
    "plugin-state-sidecar": [
      detected.pluginStateSidecar.sourcePath
        ? [{ kind: "sqlite" as const, path: detected.pluginStateSidecar.sourcePath }]
        : [],
      detected.pluginStateSidecar.hasLegacy,
    ],
    "debug-proxy-capture": [
      pathEndpoints(
        detected.debugProxyCaptureSidecar.sourcePath,
        detected.debugProxyCaptureSidecar.blobDir,
      ),
      detected.debugProxyCaptureSidecar.hasLegacy,
    ],
    "task-state-sidecars": [
      sqliteEndpoints(
        detected.taskStateSidecars.taskRunsPath,
        detected.taskStateSidecars.flowRunsPath,
      ),
      detected.taskStateSidecars.hasLegacy,
    ],
    "delivery-queues": [
      pathEndpoints(detected.deliveryQueues.outboundPath, detected.deliveryQueues.sessionPath),
      detected.deliveryQueues.hasLegacy,
    ],
    "voice-wake": [
      pathEndpoints(detected.voiceWake.triggersPath, detected.voiceWake.routingPath),
      detected.voiceWake.hasLegacy,
    ],
    "update-check": [
      pathEndpoints(detected.updateCheck.sourcePath),
      detected.updateCheck.hasLegacy,
    ],
    "config-health": [
      pathEndpoints(detected.configHealth.sourcePath),
      detected.configHealth.hasLegacy,
    ],
    "plugin-binding-approvals": [
      pathEndpoints(detected.pluginBindingApprovals.sourcePath),
      detected.pluginBindingApprovals.hasLegacy,
    ],
    "current-conversation-bindings": [
      pathEndpoints(detected.currentConversationBindings.sourcePath),
      detected.currentConversationBindings.hasLegacy,
    ],
    "tui-last-session": [
      pathEndpoints(detected.tuiLastSessions.sourcePath),
      detected.tuiLastSessions.hasLegacy,
    ],
    commitments: [
      pathEndpoints(detected.commitments?.sourcePath),
      detected.commitments?.hasLegacy === true,
    ],
    "audit-logs": [
      pathEndpoints(...detected.auditLogs.sources.map((source) => source.sourcePath)),
      detected.auditLogs.hasLegacy,
    ],
    "acp-replay-ledger": [
      pathEndpoints(detected.acpReplayLedger.sourcePath),
      detected.acpReplayLedger.hasLegacy,
    ],
    "managed-outgoing-images": [
      pathEndpoints(detected.managedOutgoingImages.sourceDir),
      detected.managedOutgoingImages.hasLegacy,
    ],
    "apns-registrations": [pathEndpoints(detected.apns.sourcePath), detected.apns.hasLegacy],
    "device-auth": [pathEndpoints(detected.deviceAuth.sourcePath), detected.deviceAuth.hasLegacy],
    "device-identity": [
      pathEndpoints(
        detected.deviceIdentity.sourcePath,
        detected.deviceIdentity.claimPath,
        detected.deviceIdentity.nativeClaimPath,
      ),
      detected.deviceIdentity.hasLegacy || detected.deviceIdentity.hasInvalidCanonical,
    ],
    "exec-approvals": [
      pathEndpoints(detected.execApprovals.sourcePath),
      detected.execApprovals.hasLegacy,
    ],
    "mcp-oauth": [
      pathEndpoints(detected.mcpOauth.sourceDir, ...detected.mcpOauth.sourcePaths),
      detected.mcpOauth.hasLegacy,
    ],
    "meeting-transcripts": [
      [...pathEndpoints(detected.meetingTranscripts?.sourceDir), stateDatabase],
      detected.meetingTranscripts?.hasLegacy === true,
    ],
    "workspace-state": [
      pathEndpoints(...detected.workspace.sources.map((source) => source.sourcePath)),
      detected.workspace.hasLegacy,
    ],
    "skill-workshop": [
      [
        stateDatabase,
        ...pathEndpoints(path.join(stateDir, "skill-workshop")),
        { kind: "owner", id: "core:skill-workshop" },
      ],
      "conditional",
      [stateDatabase, { kind: "owner", id: "core:skill-workshop" }],
    ],
    "web-push": [
      pathEndpoints(detected.webPush.subscriptionsPath, detected.webPush.vapidKeysPath),
      detected.webPush.hasLegacy,
    ],
    "node-host": [pathEndpoints(detected.nodeHost.sourcePath), detected.nodeHost.hasLegacy],
    "subagent-registry": [
      pathEndpoints(detected.subagentRegistry.sourcePath),
      detected.subagentRegistry.hasLegacy,
    ],
    "rescue-pending": [
      pathEndpoints(...detected.rescuePending.sourcePaths),
      detected.rescuePending.hasLegacy,
      [],
      "checkpoint-required",
    ],
    "restart-sentinel": [
      pathEndpoints(detected.restartSentinel?.sourcePath),
      detected.restartSentinel?.hasLegacy === true,
    ],
    "channel-pairing": [
      pathEndpoints(
        ...detected.channelPairing.files.map((file) =>
          path.join(detected.channelPairing.sourceDir, file),
        ),
      ),
      detected.channelPairing.hasLegacy,
    ],
    "plugin-doctor-state": [
      pluginMigrationSources,
      plannedPluginDescriptor?.requiredness ?? detected.pluginPlans?.hasLegacy === true,
      pluginMigrationTargets,
    ],
    "plugin-doctor-post-session-state": [
      plannedPostSessionPluginDescriptor?.source ?? [],
      plannedPostSessionPluginDescriptor?.requiredness ?? false,
      plannedPostSessionPluginDescriptor?.target ?? [],
    ],
    sessions: [
      pathEndpoints(detected.sessions.legacyDir, detected.sessions.legacyStorePath),
      detected.sessions.hasLegacy,
      pathEndpoints(detected.sessions.targetDir, detected.sessions.targetStorePath),
    ],
    "legacy-main-session-keys": [canonicalSessionStores, "conditional", canonicalSessionStores],
    "acp-session-metadata": [
      legacySessionStores,
      "conditional",
      uniqueMigrationEndpoints([...legacySessionStores, stateDatabase]),
    ],
    "agent-dir": [
      pathEndpoints(detected.agentDir.legacyDir),
      detected.agentDir.hasLegacy,
      pathEndpoints(detected.agentDir.targetDir),
    ],
  } satisfies Record<string, StepSpec>;
  type StepId = keyof typeof stepSpecs;
  const requiredness = (
    required: boolean | PreparedLegacyStateMigrationStep["requiredness"],
  ): PreparedLegacyStateMigrationStep["requiredness"] =>
    typeof required === "string" ? required : required ? "required" : "not-required";
  const descriptor = (
    id: StepId,
    phase: LegacyStateMigrationStep["phase"],
  ): PreparedLegacyStateMigrationStep => {
    const [source, required, target = [stateDatabase], reversibility = "checkpoint-required"] =
      stepSpecs[id];
    return { id, phase, source, target, requiredness: requiredness(required), reversibility };
  };
  const sharedStep = (
    id: StepId,
    run: LegacyStateMigrationStep["run"],
    collectNotices = false,
  ): LegacyStateMigrationStep => ({
    ...descriptor(id, "shared"),
    run,
    collectNotices,
  });
  const finalStep = (
    id: StepId,
    run: LegacyStateMigrationStep["run"],
    collectNotices = false,
    refusal?: PreparedLegacyStateMigrationStep["refusal"],
  ): LegacyStateMigrationStep => ({
    ...descriptor(id, "final"),
    ...(refusal ? { refusal } : {}),
    run,
    collectNotices,
  });
  const ownerStep = <TDetection>(
    id: StepId,
    detection: TDetection,
    migrate: (options: {
      detected: TDetection;
      env: NodeJS.ProcessEnv;
      stateDir: string;
    }) => MigrationMessages | Promise<MigrationMessages>,
    phase: LegacyStateMigrationStep["phase"] = "final",
    collectNotices = true,
  ): LegacyStateMigrationStep => ({
    ...descriptor(id, phase),
    collectNotices,
    run: () => migrate({ detected: detection, env, stateDir }),
  });

  const managedWorktreePrelude: LegacyStateMigrationStep[] = [
    sharedStep("managed-worktrees", () => {
      const stateEnv = { ...env, OPENCLAW_STATE_DIR: stateDir };
      const discardedWorktrees =
        isDoctor && detected.worktrees.hasLegacy
          ? discardLegacyRegistryWorktrees(stateEnv, detected.worktrees.legacyIds)
          : 0;
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
    ownerStep("shared-auth-store", detected.sharedAuthStore, migrateSharedAuthStore, "shared"),
    sharedStep("plugin-state-sidecar", () => migrateLegacyPluginStateSidecar({ stateDir })),
    ownerStep(
      "debug-proxy-capture",
      detected.debugProxyCaptureSidecar,
      migrateLegacyDebugProxyCaptureSidecar,
      "shared",
      false,
    ),
    sharedStep("task-state-sidecars", () => migrateLegacyTaskStateSidecars({ stateDir })),
    sharedStep("delivery-queues", () => migrateLegacyDeliveryQueues({ stateDir })),
    ownerStep("voice-wake", detected.voiceWake, migrateLegacyVoiceWakeSettings, "shared"),
    ownerStep("update-check", detected.updateCheck, migrateLegacyUpdateCheckState, "shared"),
    ownerStep("config-health", detected.configHealth, migrateLegacyConfigHealth, "shared", false),
    ownerStep(
      "plugin-binding-approvals",
      detected.pluginBindingApprovals,
      migrateLegacyPluginBindingApprovals,
      "shared",
    ),
    ownerStep(
      "current-conversation-bindings",
      detected.currentConversationBindings,
      migrateLegacyCurrentConversationBindings,
      "shared",
    ),
  ];

  const eagerStateSteps: LegacyStateMigrationStep[] = [
    ownerStep("device-auth", detected.deviceAuth, migrateLegacyDeviceAuth, "shared"),
    sharedStep(
      "device-identity",
      () =>
        migrateLegacyDeviceIdentity({
          detected: detected.deviceIdentity,
          env,
          stateDir,
          doctorOnlyStateMigrations: isDoctor,
          allowLegacyDeviceIdentityImport: params.allowLegacyDeviceIdentityImport,
        }),
      true,
    ),
    sharedStep(
      "meeting-transcripts",
      () =>
        migrateLegacyMeetingTranscripts({
          detected: detected.meetingTranscripts,
          env,
          stateDir,
          now,
        }),
      true,
    ),
  ];

  const doctorStateSteps: LegacyStateMigrationStep[] = isDoctor
    ? [
        ownerStep("tui-last-session", detected.tuiLastSessions, migrateLegacyTuiLastSessions),
        ...(detected.commitments
          ? [ownerStep("commitments", detected.commitments, migrateLegacyCommitments)]
          : []),
        ownerStep("audit-logs", detected.auditLogs, migrateLegacyAuditLogs),
        ownerStep("acp-replay-ledger", detected.acpReplayLedger, migrateLegacyAcpReplayLedger),
        ownerStep(
          "managed-outgoing-images",
          detected.managedOutgoingImages,
          migrateLegacyManagedOutgoingImages,
        ),
        ownerStep("apns-registrations", detected.apns, migrateLegacyApnsRegistrations),
        ownerStep("exec-approvals", detected.execApprovals, migrateLegacyExecApprovals),
        ownerStep("mcp-oauth", detected.mcpOauth, migrateLegacyMcpOAuthStores),
      ]
    : [];

  const doctorFinalSteps: LegacyStateMigrationStep[] = isDoctor
    ? [
        ownerStep("web-push", detected.webPush, migrateLegacyWebPush),
        ownerStep("node-host", detected.nodeHost, migrateLegacyNodeHostConfig),
        ownerStep("subagent-registry", detected.subagentRegistry, migrateLegacySubagentRegistry),
        ownerStep(
          "rescue-pending",
          detected.rescuePending,
          discardLegacyRescuePending,
          "final",
          false,
        ),
      ]
    : [];

  const channelPairingRefusal = detected.channelPairing.accountDiscoveryDeferred
    ? {
        code: "plugin-planning-deferred",
        message: "Channel pairing account discovery is deferred to plugin validation.",
      }
    : undefined;
  const finalSteps: LegacyStateMigrationStep[] = [
    ownerStep("restart-sentinel", detected.restartSentinel, migrateLegacyRestartSentinel),
    {
      ...ownerStep("workspace-state", detected.workspace, async (options) => {
        // Shared/agent schemas are ready here. Repair alias ownership before
        // carried legacy files can be imported under the wrong workspace key.
        if (isDoctor) {
          await params.beforeWorkspaceStateMigration?.(params.sessionConfig ?? params.config);
        }
        return migrateLegacyWorkspaceState(options);
      }),
      runWithoutFileDetection: isDoctor && params.beforeWorkspaceStateMigration !== undefined,
    },
    ...doctorFinalSteps,
    {
      // Workspace attestations must settle before Workshop relocation can retire them.
      ...finalStep("skill-workshop", () =>
        migrateLegacySkillWorkshopProposals({
          config: params.sessionConfig ?? params.config,
          env: { ...env, OPENCLAW_STATE_DIR: stateDir },
          retireMissingDrafts: isDoctor,
        }),
      ),
      runWithoutFileDetection: true,
    },
    finalStep(
      "channel-pairing",
      channelPairingRefusal
        ? () => ({ changes: [], warnings: [channelPairingRefusal.message] })
        : () =>
            migrateLegacyChannelPairingState({
              detected: detected.channelPairing,
              env: { ...env, OPENCLAW_STATE_DIR: stateDir },
            }),
      false,
      channelPairingRefusal,
    ),
    finalStep(
      "plugin-doctor-state",
      () =>
        plannedPluginDescriptor?.refusal
          ? { changes: [], warnings: [plannedPluginDescriptor.refusal.message] }
          : runPluginDoctorStateMigrationPlans({
              detected,
              config: params.config,
              env,
              ...(plannedPluginDescriptor
                ? {
                    plannedActions: plannedPluginDescriptor.actions.map((action) => ({
                      pluginId: action.pluginId,
                      id: action.id,
                    })),
                  }
                : {}),
            }),
      true,
      plannedPluginDescriptor?.refusal,
    ),
  ];

  if (repairSessionFiles) {
    finalSteps.push(
      finalStep("sessions", () =>
        migrateLegacySessions(detected, now, {
          recoverCorruptTargetStore: params.recoverCorruptTargetStore,
          legacySessionSurfaces: params.legacySessionSurfaces,
        }),
      ),
    );
  }
  if (!isDoctor) {
    const legacySessionStoreRefusal = params.legacySessionStoreRefusal;
    finalSteps.push({
      ...finalStep(
        "legacy-main-session-keys",
        legacySessionStoreRefusal
          ? () => ({ changes: [], warnings: [legacySessionStoreRefusal.message] })
          : async () => {
              const result = await migrateLegacyMainSessionKeys({
                cfg: params.sessionConfig ?? params.config,
                env,
                mode: "automatic",
                now,
              });
              return { changes: result.changes, warnings: [], notices: result.warnings };
            },
        true,
        legacySessionStoreRefusal,
      ),
      runWithoutFileDetection: true,
    });
  }
  if (repairSessionFiles) {
    // ACP metadata must run once after sessions are canonicalized; otherwise
    // existing rows and newly imported rows generate conflicting repeat warnings.
    finalSteps.push({
      ...finalStep("acp-session-metadata", () =>
        migrateLegacyAcpSessionMetadata({
          cfg: params.sessionConfig ?? params.config,
          env: isDoctor ? { ...env, OPENCLAW_STATE_DIR: stateDir } : env,
          now,
          pluginSessionStoreAgentIds,
          legacySessionSurfaces: params.legacySessionSurfaces,
        }),
      ),
      runWithoutFileDetection: true,
    });
  }
  if (!params.skipAgentScopedMigrations) {
    finalSteps.push(finalStep("agent-dir", () => migrateLegacyAgentDir(detected, now)));
  }
  if (
    isDoctor &&
    plannedPostSessionPluginDescriptor &&
    params.deferPostSessionPluginMigrations !== false
  ) {
    finalSteps.push(
      finalStep(
        "plugin-doctor-post-session-state",
        () => ({ changes: [], warnings: [] }),
        true,
        plannedPostSessionPluginDescriptor.refusal,
      ),
    );
    const step = finalSteps.at(-1);
    if (!step || step.id !== "plugin-doctor-post-session-state") {
      throw new Error("legacy state migration plan is missing its post-session plugin step");
    }
    step.deferredExecution = {
      kind: "post-session-plugin",
      plannedActions: plannedPostSessionPluginDescriptor.actions.map(({ pluginId, id }) => ({
        pluginId,
        id,
      })),
    };
  }

  return [
    createStateSchemaMigrationStep({
      stateDir,
      env,
      mode: params.mode,
      requiredness: detected.stateSchema.hasLegacy ? "required" : "conditional",
    }),
    createPluginInstallIndexStep({
      stateDir,
      env,
      hasLegacy: detected.pluginInstallIndex.hasLegacy,
    }),
    ...eagerStateSteps,
    ...managedWorktreePrelude,
    ...sharedSteps,
    ...doctorStateSteps,
    ...finalSteps,
  ];
}

function migrationStepPlan(step: LegacyStateMigrationStep): PreparedLegacyStateMigrationStep {
  return {
    id: step.id,
    phase: step.phase,
    source: step.source,
    target: step.target,
    requiredness: step.requiredness,
    reversibility: step.reversibility,
    ...(step.refusal ? { refusal: step.refusal } : {}),
  };
}

function closeMigrationPlanTail(
  steps: readonly LegacyStateMigrationStep[],
  blocker: LegacyStateMigrationStep,
): PreparedLegacyStateMigrationStep[] {
  const blockerIndex = steps.indexOf(blocker);
  return steps.map((step, index) => {
    const plannedStep = migrationStepPlan(step);
    if (index > blockerIndex) {
      plannedStep.refusal = {
        code: "blocked-by-prior-refusal",
        message: `Migration step "${step.id}" is blocked by prior refusal at "${blocker.id}".`,
      };
    }
    return plannedStep;
  });
}

function remapMigrationEndpointRoot(
  endpoint: LegacyStateMigrationEndpoint,
  sourceRoot: string,
  targetRoot: string,
): LegacyStateMigrationEndpoint {
  if (endpoint.kind === "owner") {
    return endpoint;
  }
  const endpointPath = path.resolve(endpoint.path);
  const source = path.resolve(sourceRoot);
  if (endpointPath !== source && !isPathInside(source, endpointPath)) {
    return endpoint;
  }
  return {
    ...endpoint,
    path: path.resolve(targetRoot, path.relative(source, endpointPath)),
  };
}

/**
 * Inspect a copied state/config snapshot without loading plugins or acquiring write authority.
 * Plugin action identities come from manifests; undeclared owners remain an explicit refusal.
 */
export async function planLegacyStateMigrationsReadOnly(params: {
  mode: LegacyStateMigrationMode;
  candidate: Pick<LegacyStateMigrationPlan["candidate"], "root" | "version">;
  snapshot: LegacyStateMigrationPlan["snapshot"];
  env?: NodeJS.ProcessEnv;
  initialWarnings?: readonly string[];
  legacySessionSurfaces?: PreparedLegacySessionSurfaces;
}): Promise<LegacyStateMigrationPlan> {
  const expectedConfigDigest = params.snapshot.configDigest;
  const expectedStateDigest = params.snapshot.stateDigest;
  const requestedSnapshot = {
    homeDir: path.resolve(params.snapshot.homeDir),
    configPath: path.resolve(params.snapshot.configPath),
    stateDir: path.resolve(params.snapshot.stateDir),
  };
  const callerEnv = createLegacyStateMigrationCallerEnv({
    env: params.env,
    snapshot: requestedSnapshot,
  });
  const rawOAuthDir = (params.env ?? process.env).OPENCLAW_OAUTH_DIR?.trim();
  const callerOAuthDir = rawOAuthDir
    ? resolveOAuthDir({ ...callerEnv, OPENCLAW_OAUTH_DIR: rawOAuthDir }, requestedSnapshot.stateDir)
    : undefined;
  const oauthDirOutsideSnapshot =
    callerOAuthDir !== undefined &&
    path.resolve(callerOAuthDir) !== requestedSnapshot.stateDir &&
    !isPathInside(requestedSnapshot.stateDir, callerOAuthDir);
  const pendingStateDirMigration = resolvePendingLegacyStateDirMigrationPaths({
    env: callerEnv,
    homedir: () => requestedSnapshot.homeDir,
  });
  // This exported boundary authorizes the paths recorded in the plan. Capture
  // their identity here so direct callers cannot substitute a symlink or digest.
  const identityBefore = await captureLegacyStateSnapshotIdentity(requestedSnapshot);
  const env = createLegacyStateMigrationPlanEnv({
    env: params.env,
    snapshot: requestedSnapshot,
  });
  if (callerOAuthDir && !oauthDirOutsideSnapshot) {
    env.OPENCLAW_OAUTH_DIR = callerOAuthDir;
  }
  const configBefore = await readLegacyStateMigrationPlanConfig({
    configPath: requestedSnapshot.configPath,
    homeDir: requestedSnapshot.homeDir,
    env,
  });
  const snapshot = {
    ...requestedSnapshot,
    ...(configBefore.configDigest ? { configDigest: configBefore.configDigest } : {}),
    ...(identityBefore.stateDigest ? { stateDigest: identityBefore.stateDigest } : {}),
  };
  if (identityBefore.warnings.length > 0 || !configBefore.configDigest) {
    const warnings = [
      ...(params.initialWarnings ?? []),
      ...identityBefore.warnings,
      ...configBefore.warnings,
    ];
    return createLegacyStateMigrationPlan({
      mode: params.mode,
      candidate: params.candidate,
      snapshot,
      steps: [],
      warnings,
      refusal: {
        code: "snapshot-identity-unavailable",
        message: warnings.join("\n"),
      },
    });
  }
  if (identityBefore.configDigest !== configBefore.rootDigest) {
    const message = "Copied config changed while migration planning was starting.";
    return createLegacyStateMigrationPlan({
      mode: params.mode,
      candidate: params.candidate,
      snapshot,
      steps: [],
      warnings: [...(params.initialWarnings ?? []), ...configBefore.warnings, message],
      refusal: { code: "snapshot-identity-changed", message },
    });
  }
  const mismatchedSnapshotDigests = [
    expectedConfigDigest && expectedConfigDigest !== configBefore.configDigest
      ? "config"
      : undefined,
    expectedStateDigest && expectedStateDigest !== identityBefore.stateDigest ? "state" : undefined,
  ].filter((label): label is string => label !== undefined);
  if (mismatchedSnapshotDigests.length > 0) {
    const message = `Caller-provided copied ${mismatchedSnapshotDigests.join(" and ")} digest did not match the observed snapshot.`;
    return createLegacyStateMigrationPlan({
      mode: params.mode,
      candidate: params.candidate,
      snapshot,
      steps: [],
      warnings: [...(params.initialWarnings ?? []), message],
      refusal: { code: "snapshot-identity-mismatch", message },
    });
  }
  const pluginStateMigrationInventory = resolvePluginDoctorStateMigrationInventory({
    config: configBefore.config,
    env,
    candidateRoot: params.candidate.root,
    artifactPreservingReadOnly: true,
  });
  const pluginInstallIndexStep = createPluginInstallIndexStep({
    stateDir: snapshot.stateDir,
    env,
    hasLegacy: migrationFileExists(
      resolveLegacyInstalledPluginIndexStorePath({ stateDir: snapshot.stateDir }),
    ),
  });
  if (
    pendingStateDirMigration &&
    path.resolve(pendingStateDirMigration.source) !== requestedSnapshot.stateDir
  ) {
    const message = `Pending legacy state root is outside the copied state snapshot: ${pendingStateDirMigration.source}`;
    return createLegacyStateMigrationPlan({
      mode: params.mode,
      candidate: params.candidate,
      snapshot,
      steps: [],
      warnings: [...(params.initialWarnings ?? []), message],
      refusal: { code: "state-dir-source-outside-snapshot", message },
    });
  }
  // Live Doctor honors the selected auth owner. Copied planning must refuse an
  // unbound source before discovery, not silently substitute the standard root.
  const outsideSharedAuthSources =
    params.mode === "doctor"
      ? listMigrationEndpointsOutsideRoot(
          [
            {
              kind: "sqlite",
              path: path.join(resolveSharedMainAuthAgentDir(env), "openclaw-agent.sqlite"),
            },
          ],
          snapshot.stateDir,
        )
      : [];
  if ((callerOAuthDir && oauthDirOutsideSnapshot) || outsideSharedAuthSources.length > 0) {
    const refusal =
      callerOAuthDir && oauthDirOutsideSnapshot
        ? {
            code: "oauth-dir-outside-snapshot",
            message: `Configured OAuth migration directory is outside the copied state snapshot: ${callerOAuthDir}`,
          }
        : {
            code: "shared-auth-source-outside-snapshot",
            message: "Selected shared-auth migration source is outside the copied state snapshot.",
          };
    const detectionStep = createMigrationDetectionStep({
      configPath: snapshot.configPath,
      configIncludedPaths: configBefore.configIncludedPaths,
      stateDir: snapshot.stateDir,
      refusal,
      run: () => ({ changes: [], warnings: [refusal.message] }),
    });
    detectionStep.source = uniqueMigrationEndpoints([
      ...detectionStep.source,
      ...(callerOAuthDir && oauthDirOutsideSnapshot
        ? [{ kind: "path" as const, path: callerOAuthDir }]
        : []),
      ...outsideSharedAuthSources,
    ]);
    const steps = [
      createStateSchemaMigrationStep({
        stateDir: snapshot.stateDir,
        env,
        mode: params.mode,
        requiredness: "conditional",
      }),
      pluginInstallIndexStep,
      createConfigMachineStateStep({
        config: configBefore.config,
        configPath: snapshot.configPath,
        configIncludedPaths: configBefore.configIncludedPaths,
        stateDir: snapshot.stateDir,
        env,
      }),
      createAgentTargetDiscoveryStep({
        configPath: snapshot.configPath,
        configIncludedPaths: configBefore.configIncludedPaths,
        stateDir: snapshot.stateDir,
        env,
        run: () => ({ changes: [], warnings: [] }),
      }),
      ...buildUnresolvedBlockedPreludeSteps(params.mode),
      detectionStep,
      ...buildUnresolvedBlockedMigrationSteps({
        mode: params.mode,
        skipAgentScopedMigrations: hasCustomAgentDirOverride(env),
        pluginStateMigrationInventory,
      }),
    ];
    return createLegacyStateMigrationPlan({
      mode: params.mode,
      candidate: params.candidate,
      snapshot,
      steps: closeMigrationPlanTail(steps, detectionStep),
      warnings: [...(params.initialWarnings ?? []), ...configBefore.warnings, refusal.message],
      refusal,
    });
  }
  const configuredSessionStoreEndpoints = resolveConfiguredSessionStoreEndpoints(
    configBefore.config,
    env,
  );
  const outsideSessionStoreEndpoints = listMigrationEndpointsOutsideRoot(
    configuredSessionStoreEndpoints,
    snapshot.stateDir,
  );
  if (outsideSessionStoreEndpoints.length > 0) {
    const refusal = createSessionTargetOutsideSnapshotRefusal(outsideSessionStoreEndpoints);
    const discoveryStep = createAgentTargetDiscoveryStep({
      configPath: snapshot.configPath,
      configIncludedPaths: configBefore.configIncludedPaths,
      stateDir: snapshot.stateDir,
      env,
      refusal,
      run: () => ({ changes: [], warnings: [refusal.message] }),
    });
    discoveryStep.source = uniqueMigrationEndpoints([
      ...discoveryStep.source,
      ...outsideSessionStoreEndpoints,
    ]);
    const blockedSteps = [
      createStateSchemaMigrationStep({
        stateDir: snapshot.stateDir,
        env,
        mode: params.mode,
        requiredness: "conditional",
      }),
      pluginInstallIndexStep,
      createConfigMachineStateStep({
        config: configBefore.config,
        configPath: snapshot.configPath,
        configIncludedPaths: configBefore.configIncludedPaths,
        stateDir: snapshot.stateDir,
        env,
      }),
      discoveryStep,
      ...buildUnresolvedBlockedPreludeSteps(params.mode),
      createMigrationDetectionStep({
        configPath: snapshot.configPath,
        configIncludedPaths: configBefore.configIncludedPaths,
        stateDir: snapshot.stateDir,
        run: () => ({ changes: [], warnings: [] }),
      }),
      ...buildUnresolvedBlockedMigrationSteps({
        mode: params.mode,
        skipAgentScopedMigrations: hasCustomAgentDirOverride(env),
        pluginStateMigrationInventory,
      }),
    ];
    return createLegacyStateMigrationPlan({
      mode: params.mode,
      candidate: params.candidate,
      snapshot,
      steps: closeMigrationPlanTail(blockedSteps, discoveryStep),
      warnings: [...(params.initialWarnings ?? []), ...configBefore.warnings],
      refusal,
    });
  }
  const doctorOnlyStateMigrations = params.mode === "doctor";
  const legacySessionSurfaces = params.legacySessionSurfaces ?? EMPTY_LEGACY_SESSION_SURFACES;
  let detected: LegacyStateDetection;
  try {
    detected = await detectLegacyStateMigrations({
      cfg: configBefore.config,
      mode: params.mode,
      env,
      homedir: () => snapshot.homeDir,
      pluginSessionStoreAgentIds: [],
      doctorOnlyStateMigrations,
      pluginPlanning: "deferred",
      artifactPreservingReadOnly: true,
      legacySessionSurfaces,
    });
  } catch (error) {
    const message = `Could not inspect copied state migrations: ${String(error)}`;
    return createLegacyStateMigrationPlan({
      mode: params.mode,
      candidate: params.candidate,
      snapshot,
      steps: [],
      warnings: [...(params.initialWarnings ?? []), ...configBefore.warnings, message],
      refusal: { code: "migration-detection-failed", message },
    });
  }
  const planningWarnings = [
    ...(params.initialWarnings ?? []),
    ...configBefore.warnings,
    ...detected.warnings,
  ];
  let agentDatabaseTargets: Array<{ agentId: string; path: string }> = [];
  let registeredDatabases: readonly { agentId: string; path: string }[] = [];
  let agentTargetRefusal: PreparedLegacyStateMigrationStep["refusal"];
  let agentTargetRefusalEndpoints: LegacyStateMigrationEndpoint[] = [];
  try {
    registeredDatabases = inspectOpenClawRegisteredAgentDatabases({
      env,
      includeIncompatibleSchemaVersions: true,
    });
    agentDatabaseTargets = hasCustomAgentDirOverride(env)
      ? []
      : resolveConfiguredAgentDatabaseTargets(configBefore.config, { env, registeredDatabases });
    const boundTargets = bindAgentDatabaseTargetsToStateRoot(
      agentDatabaseTargets,
      snapshot.stateDir,
    );
    agentDatabaseTargets = boundTargets.targets;
    if (boundTargets.refusal) {
      planningWarnings.push(boundTargets.refusal.message);
      agentTargetRefusal = boundTargets.refusal;
      agentTargetRefusalEndpoints = boundTargets.outsideEndpoints;
    }
  } catch (error) {
    const message = `Could not resolve configured agent migration targets: ${String(error)}`;
    planningWarnings.push(message);
    agentTargetRefusal = { code: "agent-target-discovery-failed", message };
  }
  const pluginIds = collectRelevantDoctorPluginIds(configBefore.config);
  const deferredPluginSessionStores = createDeferredPluginSessionStoreEndpoints(
    configBefore.config,
    pluginStateMigrationInventory,
  );
  const copiedSessionStores = inspectOrphanSessionStoreEndpoints({
    config: configBefore.config,
    env,
    pluginSessionStoreAgentIds: [],
    registeredDatabases,
  });
  planningWarnings.push(...copiedSessionStores.warnings);
  const sessionTargetRefusal =
    copiedSessionStores.warnings.length > 0
      ? {
          code: "session-target-discovery-failed",
          message: copiedSessionStores.warnings.join("\n"),
        }
      : createDeferredPluginSessionStoreRefusal(deferredPluginSessionStores);
  const skipAgentScopedMigrations = hasCustomAgentDirOverride(env);
  const mainSteps = buildLegacyStateMigrationSteps({
    mode: params.mode,
    detected,
    config: configBefore.config,
    env,
    agentDatabaseEndpoints: agentDatabaseTargets.map(({ path: databasePath }) => ({
      kind: "sqlite",
      path: databasePath,
    })),
    legacySessionStoreEndpoints: uniqueMigrationEndpoints([
      ...copiedSessionStores.endpoints,
      ...deferredPluginSessionStores,
    ]),
    legacySessionStoreRefusal: sessionTargetRefusal,
    skipAgentScopedMigrations,
    pluginStateMigrationInventory,
    legacySessionSurfaces,
  });
  for (const step of mainSteps) {
    if (step.id === "skill-workshop") {
      // Recorded legacy targets can name workspaces outside copied state.
      // Keep the owner visible without inspecting or granting those paths.
      step.refusal = {
        code: "skill-workshop-planning-deferred",
        message: "Skill Workshop relocation requires separately bound workspace and skill targets.",
      };
    }
  }
  const [stateSchemaStep, plannedPluginInstallIndexStep, ...remainingMainSteps] = mainSteps;
  if (!stateSchemaStep || stateSchemaStep.id !== "state-schema") {
    throw new Error("legacy state migration plan is missing its state-schema prelude");
  }
  if (plannedPluginInstallIndexStep?.id !== "plugin-install-index") {
    throw new Error("legacy state migration plan is missing its plugin-install-index prelude");
  }
  const pluginPreparationRefusal = createPluginMigrationPreparationRefusal({
    inventory: pluginStateMigrationInventory,
    deferredSessionStoreEndpoints: deferredPluginSessionStores,
  });
  const plannedAgentTargetDiscoveryStep = createAgentTargetDiscoveryStep({
    configPath: snapshot.configPath,
    configIncludedPaths: configBefore.configIncludedPaths,
    stateDir: snapshot.stateDir,
    env,
    refusal: agentTargetRefusal,
    run: () => ({
      changes: [],
      warnings: agentTargetRefusal ? [agentTargetRefusal.message] : [],
    }),
  });
  plannedAgentTargetDiscoveryStep.source = uniqueMigrationEndpoints([
    ...plannedAgentTargetDiscoveryStep.source,
    ...agentTargetRefusalEndpoints,
  ]);
  const migrationDetectionStep = createMigrationDetectionStep({
    configPath: snapshot.configPath,
    configIncludedPaths: configBefore.configIncludedPaths,
    stateDir: snapshot.stateDir,
    refusal:
      detected.warnings.length > 0
        ? {
            code: "migration-detection-warning",
            message: detected.warnings.join("\n"),
          }
        : undefined,
    run: () => ({ changes: [], warnings: detected.warnings }),
  });
  const executionSteps = [
    stateSchemaStep,
    plannedPluginInstallIndexStep,
    createConfigMachineStateStep({
      config: configBefore.config,
      configPath: snapshot.configPath,
      configIncludedPaths: configBefore.configIncludedPaths,
      stateDir: snapshot.stateDir,
      env,
    }),
    plannedAgentTargetDiscoveryStep,
    ...buildLegacyStateMigrationPreludeSteps({
      mode: params.mode,
      config: configBefore.config,
      configPath: snapshot.configPath,
      configIncludedPaths: configBefore.configIncludedPaths,
      stateDir: snapshot.stateDir,
      env,
      homedir: () => snapshot.homeDir,
      agentDatabaseTargets,
      registeredDatabases,
      pluginSessionStoreAgentIds: [],
      legacySessionSurfaces,
      deferredPluginSessionStoreEndpoints: deferredPluginSessionStores,
      readOnlyPlanning: true,
      ...(params.mode === "doctor"
        ? {
            pluginPreparation: createPluginMigrationPreparationStep({
              configPath: snapshot.configPath,
              configIncludedPaths: configBefore.configIncludedPaths,
              pluginIds,
              refusal: pluginPreparationRefusal,
              run: () => ({
                changes: [],
                warnings: pluginPreparationRefusal ? [pluginPreparationRefusal.message] : [],
              }),
            }),
          }
        : {}),
    }),
    migrationDetectionStep,
    ...remainingMainSteps,
  ];
  const steps = executionSteps.map(migrationStepPlan);
  if (detected.stateSchema.hasLegacy) {
    const sharedAuthStep = steps.find((step) => step.id === "shared-auth-store");
    if (sharedAuthStep) {
      sharedAuthStep.requiredness = "conditional";
      sharedAuthStep.refusal = {
        code: "state-schema-planning-deferred",
        message:
          "Shared auth migration inspection is deferred until the copied state schema is repaired.",
      };
    }
  }
  if (sessionTargetRefusal) {
    for (const step of steps) {
      if (step.id === "acp-session-metadata") {
        step.refusal = sessionTargetRefusal;
      }
    }
  }
  const channelPairingStep = steps.find((step) => step.id === "channel-pairing");
  if (channelPairingStep && detected.channelPairing.accountDiscoveryDeferred) {
    channelPairingStep.requiredness = "conditional";
    channelPairingStep.refusal = {
      code: "plugin-planning-deferred",
      message: "Channel pairing account discovery is deferred to candidate plugin validation.",
    };
  }
  const firstRefusalIndex = steps.findIndex((step) => step.refusal !== undefined);
  const firstRefusal = steps[firstRefusalIndex];
  if (firstRefusal) {
    for (const step of steps.slice(firstRefusalIndex + 1)) {
      step.refusal = {
        code: "blocked-by-prior-refusal",
        message: `Migration step "${step.id}" is blocked by prior refusal at "${firstRefusal.id}".`,
      };
    }
  }
  const stateDirRefusal = pendingStateDirMigration
    ? {
        code: "state-dir-planning-deferred",
        message:
          "Legacy state-root relocation must complete before copied-state migrations are planned.",
      }
    : undefined;
  const plannedSteps = pendingStateDirMigration
    ? [
        {
          id: "state-dir",
          phase: "shared" as const,
          source: [{ kind: "path" as const, path: pendingStateDirMigration.source }],
          target: [{ kind: "path" as const, path: pendingStateDirMigration.target }],
          requiredness: "required" as const,
          reversibility: "checkpoint-required" as const,
          refusal: stateDirRefusal,
        },
        ...steps.map((step) => ({
          ...step,
          source: step.source.map((endpoint) =>
            remapMigrationEndpointRoot(
              endpoint,
              pendingStateDirMigration.source,
              pendingStateDirMigration.target,
            ),
          ),
          target: step.target.map((endpoint) =>
            remapMigrationEndpointRoot(
              endpoint,
              pendingStateDirMigration.source,
              pendingStateDirMigration.target,
            ),
          ),
          refusal: {
            code: "blocked-by-prior-refusal",
            message: `Migration step "${step.id}" is deferred until legacy state-root relocation is complete.`,
          },
        })),
      ]
    : steps;
  const plan = createLegacyStateMigrationPlan({
    mode: params.mode,
    candidate: params.candidate,
    snapshot,
    steps: plannedSteps,
    warnings: planningWarnings,
    ...(stateDirRefusal ? { refusal: stateDirRefusal } : {}),
  });
  // Validate the config owner's exact inputs and state at one final boundary;
  // a separate concurrent config read can finish before the state traversal.
  const identityAfter = await captureLegacyStateSnapshotIdentity({
    ...requestedSnapshot,
    configInputHashes: configBefore.configInputHashes,
  });
  if (identityAfter.warnings.length > 0) {
    const message = identityAfter.warnings.join("\n");
    return refuseLegacyStateMigrationPlan(plan, {
      code: "snapshot-identity-unavailable",
      message,
    });
  }
  if (
    identityAfter.configDigest !== configBefore.rootDigest ||
    identityBefore.stateDigest !== identityAfter.stateDigest
  ) {
    return refuseLegacyStateMigrationPlan(plan, {
      code: "snapshot-identity-changed",
      message: "Copied config or state changed while migration planning was in progress.",
    });
  }
  return plan;
}

function refusedStepReceipt(
  step: LegacyStateMigrationStep,
  error: unknown,
): LegacyStateMigrationStepReceipt {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ...migrationStepPlan(step),
    outcome: "refused",
    changes: [],
    warnings: [message],
    refusal: { code: "step-threw", message },
  };
}

function blockedStepReceipts(params: {
  steps: readonly LegacyStateMigrationStep[];
  blocker: LegacyStateMigrationStep;
  onStepReceipt?: (receipt: LegacyStateMigrationStepReceipt) => void;
}): LegacyStateMigrationStepReceipt[] {
  return params.steps.map((step) => {
    const message = `Migration step "${step.id}" was not run because prior step "${params.blocker.id}" refused execution.`;
    const receipt: LegacyStateMigrationStepReceipt = {
      ...migrationStepPlan(step),
      outcome: "refused",
      changes: [],
      warnings: [message],
      refusal: { code: "blocked-by-prior-refusal", message },
    };
    params.onStepReceipt?.(receipt);
    return receipt;
  });
}

async function runLegacyStateMigrationSteps(
  steps: readonly LegacyStateMigrationStep[],
  onStepReceipt?: (receipt: LegacyStateMigrationStepReceipt) => void,
  shouldRun?: (step: LegacyStateMigrationStep) => boolean,
  options?: { onUnexpectedFailure?: (error: unknown) => void },
): Promise<{
  sources: MigrationMessages[];
  sharedSources: MigrationMessages[];
  finalSources: MigrationMessages[];
  sharedNoticeSources: MigrationMessages[];
  finalNoticeSources: MigrationMessages[];
  entries: Array<{ id: string; result: MigrationMessages }>;
  receipts: LegacyStateMigrationStepReceipt[];
  deferredSteps: LegacyStateMigrationStep[];
  halted: boolean;
}> {
  const sources: MigrationMessages[] = [];
  const sharedSources: MigrationMessages[] = [];
  const finalSources: MigrationMessages[] = [];
  const sharedNoticeSources: MigrationMessages[] = [];
  const finalNoticeSources: MigrationMessages[] = [];
  const entries: Array<{ id: string; result: MigrationMessages }> = [];
  const receipts: LegacyStateMigrationStepReceipt[] = [];
  const deferredSteps: LegacyStateMigrationStep[] = [];
  let halted = false;

  // Later owners require the SQLite commit and verified source archive of
  // every preceding owner; migration planning must never run steps in parallel.
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (!step) {
      continue;
    }
    if (step.deferredExecution) {
      // This phase depends on later canonical session repair. Keep its authority open
      // until that writer runs; an earlier refusal still closes it through the tail path.
      deferredSteps.push(step);
      continue;
    }
    if (shouldRun && !shouldRun(step) && step.requiredness === "not-required") {
      const receipt: LegacyStateMigrationStepReceipt = {
        ...migrationStepPlan(step),
        outcome: "skipped",
        changes: [],
        warnings: [],
      };
      receipts.push(receipt);
      onStepReceipt?.(receipt);
      continue;
    }
    let result: MigrationMessages;
    try {
      result = await step.run();
    } catch (error) {
      const receipt = refusedStepReceipt(step, error);
      result = { changes: [], warnings: receipt.warnings };
      entries.push({ id: step.id, result });
      receipts.push(receipt);
      onStepReceipt?.(receipt);
      options?.onUnexpectedFailure?.(error);
      sources.push(result);
      (step.phase === "shared" ? sharedSources : finalSources).push(result);
      halted = true;
      receipts.push(
        ...blockedStepReceipts({
          steps: steps.slice(index + 1),
          blocker: step,
          onStepReceipt,
        }),
      );
      break;
    }
    const receipt = createLegacyStateMigrationStepReceipt(migrationStepPlan(step), result);
    entries.push({ id: step.id, result });
    receipts.push(receipt);
    onStepReceipt?.(receipt);
    sources.push(result);
    (step.phase === "shared" ? sharedSources : finalSources).push(result);
    if (step.collectNotices) {
      (step.phase === "shared" ? sharedNoticeSources : finalNoticeSources).push(result);
    }
    if (receipt.outcome === "refused") {
      halted = true;
      receipts.push(
        ...blockedStepReceipts({
          steps: steps.slice(index + 1),
          blocker: step,
          onStepReceipt,
        }),
      );
      break;
    }
  }

  return {
    sources,
    sharedSources,
    finalSources,
    sharedNoticeSources,
    finalNoticeSources,
    entries,
    receipts,
    deferredSteps,
    halted,
  };
}

export async function runLegacyStateMigrations(params: {
  detected: LegacyStateDetection;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  recoverCorruptTargetStore?: boolean;
  doctorOnlyStateMigrations?: boolean;
  onStepReceipt?: (receipt: LegacyStateMigrationStepReceipt) => void;
  legacySessionSurfaces: PreparedLegacySessionSurfaces;
}): Promise<
  MigrationMessages & {
    mode: "doctor";
    stepReceipts: LegacyStateMigrationStepReceipt[];
  }
> {
  const detected = params.detected;
  const env = params.env ?? process.env;
  const config = params.config ?? ({} as OpenClawConfig);
  const legacySessionSurfaces = params.legacySessionSurfaces;
  const buildSteps = (pluginStateMigrationInventory?: PluginDoctorStateMigrationInventory) =>
    buildLegacyStateMigrationSteps({
      mode: "doctor",
      detected,
      config,
      env,
      now: params.now,
      recoverCorruptTargetStore: params.recoverCorruptTargetStore,
      pluginStateMigrationInventory,
      // The health contribution's later session repair consumes preflight's handoff.
      // This migration pass does not own that separate phase.
      deferPostSessionPluginMigrations: false,
      legacySessionSurfaces,
    });
  const [stateSchemaStep, pluginInstallIndexStep, ...remainingSteps] = buildSteps();
  if (!stateSchemaStep || stateSchemaStep.id !== "state-schema") {
    throw new Error("legacy state migration plan is missing its state-schema prelude");
  }
  if (pluginInstallIndexStep?.id !== "plugin-install-index") {
    throw new Error("legacy state migration plan is missing its plugin-install-index prelude");
  }
  const preparationSteps = [stateSchemaStep, pluginInstallIndexStep];
  const preparation = await runLegacyStateMigrationSteps(preparationSteps, params.onStepReceipt);
  if (preparation.halted) {
    const blocker = preparationSteps.find((step) =>
      preparation.receipts.some(
        (receipt) => receipt.id === step.id && receipt.outcome === "refused",
      ),
    );
    if (!blocker) {
      throw new Error("legacy state preparation halted without a refusal receipt");
    }
    const notices = mergeNotices(preparation.sources);
    return {
      changes: preparation.sources.flatMap((source) => source.changes),
      warnings: preparation.sources.flatMap((source) => source.warnings),
      ...(notices.length > 0 ? { notices } : {}),
      mode: "doctor",
      stepReceipts: [
        ...preparation.receipts,
        ...blockedStepReceipts({
          steps: remainingSteps,
          blocker,
          onStepReceipt: params.onStepReceipt,
        }),
      ],
    };
  }

  // Index preparation can expose installed plugin owners. Freeze their full live action
  // inventory before the writer, rather than receipting the earlier pending-only preview.
  const inventory = resolveLivePluginDoctorStateMigrationInventory({ config, env });
  const migrations = await runLegacyStateMigrationSteps(
    buildSteps(inventory).slice(2),
    params.onStepReceipt,
  );
  const notices = mergeNotices([
    ...preparation.sources,
    ...migrations.sharedNoticeSources,
    ...migrations.finalNoticeSources,
  ]);
  return {
    mode: "doctor",
    stepReceipts: [...preparation.receipts, ...migrations.receipts],
    changes: [...preparation.sources, ...migrations.sources].flatMap((source) => source.changes),
    warnings: [
      ...new Set([
        ...preparation.sources.flatMap((source) => source.warnings),
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
  /** Include inputs captured by the config snapshot that produced cfg. */
  configIncludedPaths?: readonly string[];
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  log?: MigrationLogger;
  now?: () => number;
  recoverCorruptTargetStore?: boolean;
  doctorOnlyStateMigrations?: boolean;
  allowLegacyDeviceIdentityImport?: boolean;
  legacySessionSurfaces?: PreparedLegacySessionSurfaces;
  onStepReceipt?: (receipt: LegacyStateMigrationStepReceipt) => void;
  beforeWorkspaceStateMigration?: (config: OpenClawConfig) => Promise<void>;
}): Promise<{
  mode: LegacyStateMigrationMode;
  migrated: boolean;
  skipped: boolean;
  changes: string[];
  warnings: string[];
  notices?: string[];
  stepReceipts: LegacyStateMigrationStepReceipt[];
  postSessionPluginMigration?: PreparedPostSessionPluginMigration;
}> {
  let failure: { error: unknown } | undefined;
  const result = await executeLegacyStateMigrations(params, (error) => {
    failure ??= { error };
  });
  // Automatic callers still receive the original failure, but only after the execution
  // owner has closed every remaining receipt without running later migrations.
  if (params.doctorOnlyStateMigrations !== true && failure) {
    throw failure.error;
  }
  return result;
}

async function executeLegacyStateMigrations(
  params: Parameters<typeof autoMigrateLegacyState>[0],
  onUnexpectedFailure: (error: unknown) => void,
): ReturnType<typeof autoMigrateLegacyState> {
  const env = params.env ?? process.env;
  const homedir = params.homedir ?? os.homedir;
  // Detection, planning, and execution share this one mode latch. Splitting it lets
  // Doctor detect owner-only work and then silently build an automatic-only plan.
  const mode: LegacyStateMigrationMode =
    params.doctorOnlyStateMigrations === true ? "doctor" : "automatic";
  const executionOptions = { onUnexpectedFailure };
  const initialStateDir = resolveStateDir(env, homedir);
  const checkKey = `${path.resolve(initialStateDir)}\0${mode}`;
  // An earlier attempt may leave post-session work or a refusal unresolved.
  // Explicit Doctor calls need fresh receipts and handoffs, not startup's once-cache.
  if (mode === "automatic" && autoMigrateChecked.has(checkKey)) {
    return {
      mode,
      migrated: false,
      skipped: true,
      changes: [],
      warnings: [],
      stepReceipts: [],
    };
  }
  if (mode === "automatic") {
    autoMigrateChecked.add(checkKey);
  }
  const pluginDoctorConfig = params.pluginDoctorConfig ?? params.cfg;
  const configIncludedPaths = params.configIncludedPaths ?? [];
  const configuredPluginIds = collectRelevantDoctorPluginIds(pluginDoctorConfig);
  // Retain a pre-preparation snapshot for refusal closure. Successful root/schema/index
  // preparation can expose installed owners, whose actions are frozen before later writers.
  let pluginStateMigrationInventory = resolveLivePluginDoctorStateMigrationInventory({
    config: pluginDoctorConfig,
    env,
  });
  let pluginInstallIndexStep = createPluginInstallIndexStep({
    stateDir: initialStateDir,
    env,
    hasLegacy: migrationFileExists(
      resolveLegacyInstalledPluginIndexStorePath({ stateDir: initialStateDir }),
    ),
  });

  // Preflight normally owns this relocation. Direct callers must retain the same
  // state-root contract, so run the canonical owner as an explicit first step.
  const pendingStateDirMigration = resolvePendingLegacyStateDirMigrationPaths({ env, homedir });
  const stateDirStep: LegacyStateMigrationStep | undefined = pendingStateDirMigration
    ? {
        id: "state-dir",
        phase: "shared",
        source: [{ kind: "path", path: pendingStateDirMigration.source }],
        target: [{ kind: "path", path: pendingStateDirMigration.target }],
        requiredness: "required",
        reversibility: "checkpoint-required",
        run: async () => {
          const result = await autoMigrateLegacyStateDir({ env, homedir, log: params.log });
          const stillPending = resolvePendingLegacyStateDirMigrationPaths({ env, homedir });
          return stillPending
            ? {
                ...result,
                warnings: [
                  ...result.warnings,
                  `State directory migration remains pending (${stillPending.source} → ${stillPending.target}).`,
                ],
              }
            : result;
        },
      }
    : undefined;
  const stateDirMigration = stateDirStep
    ? await runLegacyStateMigrationSteps(
        [stateDirStep],
        params.onStepReceipt,
        undefined,
        executionOptions,
      )
    : undefined;
  const stateDirResult = stateDirMigration?.entries[0]?.result ?? {
    changes: [],
    warnings: [],
  };
  const stateDir = resolveStateDir(env, homedir);
  if (mode === "automatic") {
    autoMigrateChecked.add(`${path.resolve(stateDir)}\0${mode}`);
  }
  const stateEnv = { ...env, OPENCLAW_STATE_DIR: stateDir };
  const stateSchemaOptions = { env: stateEnv };
  const configPath = resolveConfigPath(env, stateDir, homedir);
  let agentDatabaseTargets: Array<{ agentId: string; path: string }> = [];
  let pluginSessionStoreAgentIds: readonly string[] = [];
  let legacySessionSurfaces = EMPTY_LEGACY_SESSION_SURFACES;
  let sessionStoreOwnership: SessionStoreOwnership | undefined;
  let detected: LegacyStateDetection | undefined;
  const pluginPreparation = createPluginMigrationPreparationStep({
    configPath,
    configIncludedPaths,
    pluginIds: configuredPluginIds,
    run: async () => {
      if (pluginStateMigrationInventory.resolutionFailure) {
        pluginPreparation.refusal = pluginStateMigrationInventory.resolutionFailure;
        return { changes: [], warnings: [pluginPreparation.refusal.message] };
      }
      pluginSessionStoreAgentIds = listPluginDoctorSessionStoreAgentIds({
        config: pluginDoctorConfig,
        env,
        pluginIds: configuredPluginIds,
      });
      legacySessionSurfaces =
        params.legacySessionSurfaces ??
        (await import("../plugins/legacy-session-surfaces.js")).prepareLegacySessionSurfaces({
          config: params.cfg,
          env,
        });
      // Capture ownership before orphan-key rewrites. Atomic replacement can split
      // a configured filesystem alias from the standard target pathname.
      const ownershipAgentId = tryResolveDoctorSessionMigrationAgentId(params.cfg);
      sessionStoreOwnership = ownershipAgentId
        ? resolveSessionStoreOwnership({
            cfg: params.cfg,
            env,
            stateDir,
            targetAgentId: ownershipAgentId,
            pluginSessionStoreAgentIds,
          })
        : undefined;
      return { changes: [], warnings: [...legacySessionSurfaces.failures] };
    },
  });
  const buildPreludeSteps = (overrides?: {
    pluginSessionStoreAgentIds?: readonly string[];
    legacySessionSurfaces?: PreparedLegacySessionSurfaces;
  }) =>
    buildLegacyStateMigrationPreludeSteps({
      mode,
      config: params.cfg,
      configPath,
      configIncludedPaths,
      stateDir,
      env,
      homedir,
      agentDatabaseTargets,
      pluginSessionStoreAgentIds:
        overrides?.pluginSessionStoreAgentIds ?? pluginSessionStoreAgentIds,
      legacySessionSurfaces: overrides?.legacySessionSurfaces ?? legacySessionSurfaces,
      ...(mode === "doctor" ? { pluginPreparation } : {}),
    });
  const createDetectionStep = (): LegacyStateMigrationStep =>
    createMigrationDetectionStep({
      configPath,
      configIncludedPaths,
      stateDir,
      run: async () => {
        detected = await detectLegacyStateMigrations({
          cfg: params.cfg,
          mode,
          pluginDoctorConfig: params.pluginDoctorConfig,
          ...(mode === "doctor" ? { pluginSessionStoreAgentIds } : {}),
          sessionStoreOwnership,
          env,
          homedir: params.homedir,
          doctorOnlyStateMigrations: mode === "doctor",
          allowLegacyDeviceIdentityImport: params.allowLegacyDeviceIdentityImport,
          legacySessionSurfaces,
        });
        return {
          changes: [],
          warnings: detected.warnings,
          ...(detected.notices.length > 0 ? { notices: detected.notices } : {}),
        };
      },
    });
  const buildDetectedMigrationSteps = (migrationDetection: LegacyStateDetection) => {
    const hasCustomAgentDir = hasCustomAgentDirOverride(env);
    const discoveredSessionStores = inspectOrphanSessionStoreEndpoints({
      config: params.cfg,
      env: stateEnv,
      pluginSessionStoreAgentIds: migrationDetection.pluginSessionStoreAgentIds,
    });
    const legacySessionStoreRefusal =
      discoveredSessionStores.warnings.length > 0
        ? {
            code: "session-target-discovery-failed",
            message: discoveredSessionStores.warnings.join("\n"),
          }
        : undefined;
    const steps = buildLegacyStateMigrationSteps({
      mode,
      detected: migrationDetection,
      config: pluginDoctorConfig,
      sessionConfig: params.cfg,
      env,
      now: params.now,
      agentDatabaseEndpoints: agentDatabaseTargets.map(({ path: databasePath }) => ({
        kind: "sqlite",
        path: databasePath,
      })),
      legacySessionStoreEndpoints: discoveredSessionStores.endpoints,
      legacySessionStoreRefusal,
      recoverCorruptTargetStore: params.recoverCorruptTargetStore,
      skipAgentScopedMigrations: hasCustomAgentDir,
      allowLegacyDeviceIdentityImport: params.allowLegacyDeviceIdentityImport,
      pluginStateMigrationInventory,
      legacySessionSurfaces,
      beforeWorkspaceStateMigration: params.beforeWorkspaceStateMigration,
    }).filter((step) => step.id !== "state-schema" && step.id !== "plugin-install-index");
    return steps;
  };
  const completeBlockedPlanReceipts = async (paramsForBlockedPlan: {
    receipts: readonly LegacyStateMigrationStepReceipt[];
    blocker: LegacyStateMigrationStep;
    pendingPreludeSteps: readonly LegacyStateMigrationStep[];
  }): Promise<LegacyStateMigrationStepReceipt[]> => {
    const receipts = [
      ...paramsForBlockedPlan.receipts,
      ...blockedStepReceipts({
        steps: paramsForBlockedPlan.pendingPreludeSteps,
        blocker: paramsForBlockedPlan.blocker,
        onStepReceipt: params.onStepReceipt,
      }),
    ];
    const blockedSteps = [
      createMigrationDetectionStep({
        configPath,
        configIncludedPaths,
        stateDir,
        run: () => ({ changes: [], warnings: [] }),
      }),
      ...buildUnresolvedBlockedMigrationSteps({
        mode,
        skipAgentScopedMigrations: hasCustomAgentDirOverride(env),
        pluginStateMigrationInventory,
      }),
    ];
    receipts.push(
      ...blockedStepReceipts({
        steps: blockedSteps,
        blocker: paramsForBlockedPlan.blocker,
        onStepReceipt: params.onStepReceipt,
      }),
    );
    return receipts;
  };
  let stateSchemaStep = createStateSchemaMigrationStep({
    stateDir,
    env,
    mode,
    requiredness: "conditional",
  });
  const configMachineStateStep = createConfigMachineStateStep({
    config: pluginDoctorConfig,
    configPath,
    configIncludedPaths,
    stateDir,
    env,
  });
  const agentTargetDiscoveryStep = createAgentTargetDiscoveryStep({
    configPath,
    configIncludedPaths,
    stateDir,
    env,
    run: () => {
      try {
        agentDatabaseTargets = hasCustomAgentDirOverride(env)
          ? []
          : resolveConfiguredAgentDatabaseTargets(params.cfg, { env: stateEnv });
        return { changes: [], warnings: [] };
      } catch (error) {
        if (mode === "automatic") {
          throw error;
        }
        const message = `Could not resolve configured agent migration targets: ${String(error)}`;
        agentTargetDiscoveryStep.refusal = {
          code: "agent-target-discovery-failed",
          message,
        };
        return {
          changes: [],
          warnings: [message],
        };
      }
    },
  });
  if (stateDirMigration?.halted && stateDirStep) {
    const notices = mergeNotices([stateDirResult]);
    logStateMigrationResult(
      { changes: stateDirResult.changes, warnings: stateDirResult.warnings, notices },
      params.log,
    );
    return {
      mode,
      migrated: stateDirResult.changes.length > 0,
      skipped: false,
      changes: stateDirResult.changes,
      warnings: stateDirResult.warnings,
      stepReceipts: await completeBlockedPlanReceipts({
        receipts: stateDirMigration.receipts,
        blocker: stateDirStep,
        pendingPreludeSteps: [
          stateSchemaStep,
          pluginInstallIndexStep,
          configMachineStateStep,
          agentTargetDiscoveryStep,
          ...buildUnresolvedBlockedPreludeSteps(mode),
        ],
      }),
      ...(notices.length > 0 ? { notices } : {}),
    };
  }
  pluginInstallIndexStep = createPluginInstallIndexStep({
    stateDir,
    env: stateEnv,
    hasLegacy: migrationFileExists(resolveLegacyInstalledPluginIndexStorePath({ stateDir })),
  });
  try {
    if (detectOpenClawStateDatabaseSchemaMigrations(stateSchemaOptions).length > 0) {
      stateSchemaStep = createStateSchemaMigrationStep({
        stateDir,
        env,
        mode,
        requiredness: "required",
      });
    }
  } catch {
    // The repair step owns diagnostics for unreadable or unsupported schemas.
  }
  const statePreparationSteps = [stateSchemaStep, pluginInstallIndexStep];
  const stateSchemaMigration = await runLegacyStateMigrationSteps(
    statePreparationSteps,
    params.onStepReceipt,
    undefined,
    executionOptions,
  );
  const stateSchemaResult = stateSchemaMigration.entries[0]?.result ?? {
    changes: [],
    warnings: [],
  };
  const stateSchema: MigrationMessages = {
    changes: [
      ...stateDirResult.changes,
      ...stateSchemaMigration.sources.flatMap((source) => source.changes),
    ],
    warnings: [
      ...stateDirResult.warnings,
      ...stateSchemaMigration.sources.flatMap((source) => source.warnings),
    ],
    notices: mergeNotices([stateDirResult, ...stateSchemaMigration.sources]),
  };
  stateSchemaMigration.receipts.unshift(...(stateDirMigration?.receipts ?? []));
  if (stateSchemaMigration.halted) {
    // A failed canonical schema repair is an error: runtime cannot safely open this store.
    if (mode !== "doctor" && stateSchemaResult.warnings.length > 0) {
      onUnexpectedFailure(new Error(formatStartupMigrationFailure(stateSchemaResult.warnings)));
    }
    const blocker = statePreparationSteps.find((step) =>
      stateSchemaMigration.receipts.some(
        (receipt) => receipt.id === step.id && receipt.outcome === "refused",
      ),
    );
    if (!blocker) {
      throw new Error("legacy state preparation halted without a refusal receipt");
    }
    const pendingPreludeSteps = [
      configMachineStateStep,
      agentTargetDiscoveryStep,
      ...buildUnresolvedBlockedPreludeSteps(mode),
    ];
    return {
      mode,
      migrated: stateSchema.changes.length > 0,
      skipped: false,
      changes: stateSchema.changes,
      warnings: stateSchema.warnings,
      ...(stateSchema.notices?.length ? { notices: stateSchema.notices } : {}),
      stepReceipts: await completeBlockedPlanReceipts({
        receipts: stateSchemaMigration.receipts,
        blocker,
        pendingPreludeSteps,
      }),
    };
  }
  if (stateSchema.changes.length > 0) {
    pluginStateMigrationInventory = resolveLivePluginDoctorStateMigrationInventory({
      config: pluginDoctorConfig,
      // State-root preparation must not replace config-root plugin installation authority.
      env,
    });
  }
  // Preserve retired locators before advisory returns can permit config repair.
  const configMachineStateMigration = await runLegacyStateMigrationSteps(
    [configMachineStateStep],
    params.onStepReceipt,
    undefined,
    executionOptions,
  );
  const configMachineState = configMachineStateMigration.entries[0]?.result ?? {
    changes: [],
    warnings: [],
  };
  if (configMachineStateMigration.halted) {
    return {
      mode,
      migrated: stateSchema.changes.length > 0,
      skipped: false,
      changes: stateSchema.changes,
      warnings: [...stateSchema.warnings, ...configMachineState.warnings],
      ...(stateSchema.notices?.length ? { notices: stateSchema.notices } : {}),
      stepReceipts: await completeBlockedPlanReceipts({
        receipts: [...stateSchemaMigration.receipts, ...configMachineStateMigration.receipts],
        blocker: configMachineStateStep,
        pendingPreludeSteps: [
          agentTargetDiscoveryStep,
          ...buildUnresolvedBlockedPreludeSteps(mode),
        ],
      }),
    };
  }
  const agentTargetDiscovery = await runLegacyStateMigrationSteps(
    [agentTargetDiscoveryStep],
    params.onStepReceipt,
    undefined,
    executionOptions,
  );
  const agentTargetResult = agentTargetDiscovery.entries[0]?.result ?? {
    changes: [],
    warnings: [],
  };
  if (agentTargetResult.warnings.length > 0) {
    const changes = [...stateSchema.changes, ...configMachineState.changes];
    return {
      mode,
      migrated: changes.length > 0,
      skipped: false,
      changes,
      warnings: [
        ...stateSchema.warnings,
        ...configMachineState.warnings,
        ...agentTargetResult.warnings,
      ],
      ...(stateSchema.notices?.length ? { notices: stateSchema.notices } : {}),
      stepReceipts: await completeBlockedPlanReceipts({
        receipts: [
          ...stateSchemaMigration.receipts,
          ...configMachineStateMigration.receipts,
          ...agentTargetDiscovery.receipts,
        ],
        blocker: agentTargetDiscoveryStep,
        pendingPreludeSteps: buildUnresolvedBlockedPreludeSteps(mode),
      }),
    };
  }
  const initialPreludeSteps = buildPreludeSteps({
    pluginSessionStoreAgentIds: [],
    legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
  });
  const preludeReceipts: LegacyStateMigrationStepReceipt[] = [
    ...configMachineStateMigration.receipts,
    ...agentTargetDiscovery.receipts,
  ];
  let preludeHalted = false;
  const runPreludeStep = async (
    steps: readonly LegacyStateMigrationStep[],
    id: string,
  ): Promise<MigrationMessages> => {
    const step = steps.find((candidate) => candidate.id === id);
    if (!step) {
      return { changes: [], warnings: [] };
    }
    const execution = await runLegacyStateMigrationSteps(
      [step],
      params.onStepReceipt,
      undefined,
      executionOptions,
    );
    preludeReceipts.push(...execution.receipts);
    preludeHalted ||= execution.halted;
    return execution.entries[0]?.result ?? { changes: [], warnings: [] };
  };
  const pendingPreludeAfter = (
    steps: readonly LegacyStateMigrationStep[],
    blockerId: string,
  ): LegacyStateMigrationStep[] => {
    const blockerIndex = steps.findIndex((step) => step.id === blockerId);
    return blockerIndex < 0 ? [] : steps.slice(blockerIndex + 1);
  };
  // Media owns the historical cutover and stopped-writer lease before current consumers.
  const mediaPersistence = await runPreludeStep(initialPreludeSteps, "media-persistence");
  const mediaPersistenceHalted = preludeHalted;
  const transcriptDirectives = !mediaPersistenceHalted
    ? await runPreludeStep(initialPreludeSteps, "transcript-directives")
    : { changes: [], warnings: [] };
  if (preludeHalted) {
    const blockerId = mediaPersistenceHalted ? "media-persistence" : "transcript-directives";
    const blocker = initialPreludeSteps.find((step) => step.id === blockerId);
    if (!blocker) {
      throw new Error(`legacy state migration plan is missing its ${blockerId} prelude`);
    }
    return {
      mode,
      migrated:
        stateSchema.changes.length > 0 ||
        configMachineState.changes.length > 0 ||
        transcriptDirectives.changes.length > 0 ||
        mediaPersistence.changes.length > 0,
      skipped: false,
      changes: [
        ...stateSchema.changes,
        ...configMachineState.changes,
        ...transcriptDirectives.changes,
        ...mediaPersistence.changes,
      ],
      warnings: [
        ...stateSchema.warnings,
        ...transcriptDirectives.warnings,
        ...mediaPersistence.warnings,
      ],
      ...(stateSchema.notices?.length ? { notices: stateSchema.notices } : {}),
      stepReceipts: await completeBlockedPlanReceipts({
        receipts: [...stateSchemaMigration.receipts, ...preludeReceipts],
        blocker,
        pendingPreludeSteps: pendingPreludeAfter(initialPreludeSteps, blockerId),
      }),
    };
  }
  const profileWorkspace = await runPreludeStep(initialPreludeSteps, "profile-workspace");
  if (preludeHalted) {
    const completed = [stateSchema, configMachineState, mediaPersistence, transcriptDirectives];
    const changes = completed.flatMap((result) => result.changes);
    const warnings = [
      ...completed.flatMap((result) => result.warnings),
      ...profileWorkspace.warnings,
    ];
    const notices = mergeNotices(completed);
    logStateMigrationResult({ changes, warnings, notices }, params.log);
    const blocker = initialPreludeSteps.find((step) => step.id === "profile-workspace");
    if (!blocker) {
      throw new Error("legacy state migration plan is missing its profile-workspace prelude");
    }
    return {
      mode,
      migrated: changes.length > 0,
      skipped: false,
      changes,
      warnings,
      ...(notices.length > 0 ? { notices } : {}),
      stepReceipts: await completeBlockedPlanReceipts({
        receipts: [...stateSchemaMigration.receipts, ...preludeReceipts],
        blocker,
        pendingPreludeSteps: pendingPreludeAfter(initialPreludeSteps, blocker.id),
      }),
    };
  }
  const pluginPreparationResult = await runPreludeStep(
    initialPreludeSteps,
    "plugin-migration-preparation",
  );
  if (preludeHalted) {
    const completed = [
      stateSchema,
      configMachineState,
      mediaPersistence,
      transcriptDirectives,
      profileWorkspace,
    ];
    const blocker = initialPreludeSteps.find((step) => step.id === "plugin-migration-preparation");
    if (!blocker) {
      throw new Error("legacy state migration plan is missing its plugin preparation prelude");
    }
    return {
      mode,
      migrated: completed.some((result) => result.changes.length > 0),
      skipped: false,
      changes: completed.flatMap((result) => result.changes),
      warnings: [
        ...completed.flatMap((result) => result.warnings),
        ...pluginPreparationResult.warnings,
      ],
      ...(stateSchema.notices?.length ? { notices: stateSchema.notices } : {}),
      stepReceipts: await completeBlockedPlanReceipts({
        receipts: [...stateSchemaMigration.receipts, ...preludeReceipts],
        blocker,
        pendingPreludeSteps: pendingPreludeAfter(initialPreludeSteps, blocker.id),
      }),
    };
  }
  const finalPreludeSteps = buildPreludeSteps();
  const orphanKeys = await runPreludeStep(finalPreludeSteps, "orphan-session-keys");
  if (preludeHalted) {
    const completed = [
      stateSchema,
      configMachineState,
      mediaPersistence,
      transcriptDirectives,
      profileWorkspace,
      orphanKeys,
    ];
    const blocker = finalPreludeSteps.find((step) => step.id === "orphan-session-keys");
    if (!blocker) {
      throw new Error("legacy state migration plan is missing its orphan-session-keys prelude");
    }
    return {
      mode,
      migrated: completed.some((result) => result.changes.length > 0),
      skipped: false,
      changes: completed.flatMap((result) => result.changes),
      warnings: completed.flatMap((result) => result.warnings),
      ...(stateSchema.notices?.length ? { notices: stateSchema.notices } : {}),
      stepReceipts: await completeBlockedPlanReceipts({
        receipts: [...stateSchemaMigration.receipts, ...preludeReceipts],
        blocker,
        pendingPreludeSteps: [],
      }),
    };
  }

  const detectionStep = createDetectionStep();
  const detectionExecution = await runLegacyStateMigrationSteps(
    [detectionStep],
    params.onStepReceipt,
    undefined,
    executionOptions,
  );
  preludeReceipts.push(...detectionExecution.receipts);
  if (detectionExecution.halted || !detected) {
    preludeReceipts.push(
      ...blockedStepReceipts({
        steps: buildUnresolvedBlockedMigrationSteps({
          mode,
          skipAgentScopedMigrations: hasCustomAgentDirOverride(env),
          pluginStateMigrationInventory,
        }),
        blocker: detectionStep,
        onStepReceipt: params.onStepReceipt,
      }),
    );
    const completed = [
      stateSchema,
      configMachineState,
      mediaPersistence,
      transcriptDirectives,
      profileWorkspace,
      orphanKeys,
      ...detectionExecution.sources,
    ];
    const changes = completed.flatMap((result) => result.changes);
    const warnings = [...new Set(completed.flatMap((result) => result.warnings))];
    const notices = mergeNotices(completed);
    logStateMigrationResult({ changes, warnings, notices }, params.log);
    return {
      mode,
      migrated: changes.length > 0,
      skipped: false,
      changes,
      warnings,
      stepReceipts: [...stateSchemaMigration.receipts, ...preludeReceipts],
      ...(notices.length > 0 ? { notices } : {}),
    };
  }
  const hasCustomAgentDir = hasCustomAgentDirOverride(env);
  const migrationSteps = buildDetectedMigrationSteps(detected);
  const eagerMigrationStepIds = new Set(["device-auth", "device-identity", "meeting-transcripts"]);
  const eagerMigrationSteps = migrationSteps.filter((step) => eagerMigrationStepIds.has(step.id));
  const remainingMigrationSteps = migrationSteps.filter(
    (step) => !eagerMigrationStepIds.has(step.id),
  );
  const eagerMigrations = await runLegacyStateMigrationSteps(
    eagerMigrationSteps,
    params.onStepReceipt,
    undefined,
    executionOptions,
  );
  if (eagerMigrations.halted) {
    const blocker = eagerMigrationSteps.find((step) =>
      eagerMigrations.receipts.some(
        (receipt) => receipt.id === step.id && receipt.outcome === "refused",
      ),
    );
    if (!blocker) {
      throw new Error("legacy state migration execution halted without a refusal receipt");
    }
    const completed = [
      stateSchema,
      configMachineState,
      mediaPersistence,
      transcriptDirectives,
      profileWorkspace,
      orphanKeys,
      ...eagerMigrations.sources,
    ];
    const changes = completed.flatMap((result) => result.changes);
    const warnings = [
      ...new Set([...completed.flatMap((result) => result.warnings), ...detected.warnings]),
    ];
    const notices = mergeNotices([detected, ...completed]);
    logStateMigrationResult({ changes, warnings, notices }, params.log);
    return {
      mode,
      migrated: changes.length > 0,
      skipped: hasCustomAgentDir,
      changes,
      warnings,
      stepReceipts: [
        ...stateSchemaMigration.receipts,
        ...preludeReceipts,
        ...eagerMigrations.receipts,
        ...blockedStepReceipts({
          steps: remainingMigrationSteps,
          blocker,
          onStepReceipt: params.onStepReceipt,
        }),
      ],
      ...(notices.length > 0 ? { notices } : {}),
    };
  }
  const eagerResult = (id: string): MigrationMessages =>
    eagerMigrations.entries.find((entry) => entry.id === id)?.result ?? {
      changes: [],
      warnings: [],
    };
  const deviceAuth = eagerResult("device-auth");
  const deviceIdentity = eagerResult("device-identity");
  const meetingTranscripts = eagerResult("meeting-transcripts");
  const initialMigrationSources = [
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
    mode === "automatic" &&
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
    // SQLite rows can still need owner repair after schema migration has finished.
    // Preserve those repairs even when legacy file detectors have no work.
    const fastPathMigrations = await runLegacyStateMigrationSteps(
      remainingMigrationSteps,
      params.onStepReceipt,
      (step) => step.runWithoutFileDetection === true,
      executionOptions,
    );
    const alwaysRunSources = fastPathMigrations.sources;
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
      detected,
      ...initialMigrationSources,
      ...alwaysRunSources,
      deviceAuth,
      deviceIdentity,
    ]);
    logStateMigrationResult({ changes, warnings, notices }, params.log);
    return {
      mode,
      migrated: changes.length > 0,
      skipped: false,
      changes,
      warnings,
      stepReceipts: [
        ...stateSchemaMigration.receipts,
        ...preludeReceipts,
        ...eagerMigrations.receipts,
        ...fastPathMigrations.receipts,
      ],
      ...(notices.length > 0 ? { notices } : {}),
    };
  }

  const migrations = await runLegacyStateMigrationSteps(
    remainingMigrationSteps,
    params.onStepReceipt,
    undefined,
    executionOptions,
  );
  const deferredPostSessionStep = migrations.deferredSteps.find(
    (step) => step.deferredExecution?.kind === "post-session-plugin",
  );
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
    detected,
    ...initialMigrationSources,
    ...migrations.sharedNoticeSources,
    deviceAuth,
    deviceIdentity,
    meetingTranscripts,
    ...migrations.finalNoticeSources,
  ]);
  logStateMigrationResult({ changes, warnings, notices }, params.log);
  return {
    mode,
    // Custom agent roots omit transcript changes from their shared-state report.
    // Preserve the completed migration status without claiming agent ownership.
    migrated: changes.length > 0 || meetingTranscripts.changes.length > 0,
    skipped: hasCustomAgentDir,
    changes,
    warnings,
    stepReceipts: [
      ...stateSchemaMigration.receipts,
      ...preludeReceipts,
      ...eagerMigrations.receipts,
      ...migrations.receipts,
    ],
    ...(deferredPostSessionStep?.deferredExecution
      ? {
          postSessionPluginMigration: {
            step: migrationStepPlan(deferredPostSessionStep),
            plannedActions: deferredPostSessionStep.deferredExecution.plannedActions,
          },
        }
      : {}),
    ...(notices.length > 0 ? { notices } : {}),
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
