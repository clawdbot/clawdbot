// Doctor repair sequence coordinator for config, auth, plugin, and warning repairs.
import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  applyPluginAutoEnable,
  materializePluginAutoEnableCandidates,
} from "../../config/plugin-auto-enable.js";
import { migrateLegacyOnboardingRecommendationsScope } from "../../infra/state-migrations.onboarding-recommendations.js";
import type { PluginMetadataSnapshotScopeRunner } from "../../plugins/current-plugin-metadata-snapshot.js";
import {
  loadPluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "../../plugins/plugin-metadata-snapshot.js";
import { migrateLegacyTailscaleProfileIdentities } from "../../state/user-profiles-tailscale-migration.js";
import {
  collectOpenAICodexAuthProfileStoreIdMap,
  maybeMigrateAuthProfileJsonStoresToSqlite,
  maybeRepairOpenAICodexAuthConfig,
} from "../doctor-auth-flat-profiles.js";
import { maybeRepairLegacyOAuthSidecarProfiles } from "../doctor-auth-oauth-sidecar.js";
import { maybeRepairPluginOpenClawHostLinks } from "../doctor-plugin-host-links.js";
import { maybeRepairStaleManagedNpmBundledPlugins } from "../doctor-plugin-registry.js";
import { migrateLegacySkillWorkshopProposals } from "../doctor-skill-workshop-sqlite.js";
import { maybeRepairGroupAllowFromFallback } from "./shared/allowfrom-fallback-migration.js";
import { maybeRepairAllowlistPolicyAllowFrom } from "./shared/allowlist-policy-repair.js";
import { maybeRepairBundledPluginLoadPaths } from "./shared/bundled-plugin-load-paths.js";
import {
  collectChannelDoctorCompatibilityMutations,
  createChannelDoctorEmptyAllowlistPolicyHooks,
  collectChannelDoctorRepairMutations,
} from "./shared/channel-doctor.js";
import { maybeRepairCodexRoutes } from "./shared/codex-route-warnings.js";
import {
  applyDoctorConfigMutation,
  type DoctorConfigMutationState,
} from "./shared/config-mutation-state.js";
import { VERSION_BOUND_RUNTIME_PLUGIN_POLICY_IDS_BY_SURFACE } from "./shared/configured-runtime-plugin-installs.js";
import { maybeRepairContextEngineHostCompatibility } from "./shared/context-engine-host-compat.js";
import { scanEmptyAllowlistPolicyWarnings } from "./shared/empty-allowlist-scan.js";
import { maybeRepairExecSafeBinProfiles } from "./shared/exec-safe-bins.js";
import { maybeRepairInvalidPluginConfig } from "./shared/invalid-plugin-config.js";
import type { BlockedLegacyOpenAICodexProviderPlan } from "./shared/legacy-config-migrations.runtime.models.js";
import { maybeRepairLegacyToolsBySenderKeys } from "./shared/legacy-tools-by-sender.js";
import { repairMissingConfiguredPluginInstalls } from "./shared/missing-configured-plugin-install.js";
import { maybeRepairOpenPolicyAllowFrom } from "./shared/open-policy-allowfrom.js";
import { cleanupLegacyPluginDependencyState } from "./shared/plugin-dependency-cleanup.js";
import type { DoctorPluginMetadataSnapshotState } from "./shared/plugin-metadata-snapshot-scope.js";
import { repairStaleAgentModelRefs } from "./shared/stale-agent-model-ref-repair.js";
import { maybeRepairStaleConfiguredAuthOrders } from "./shared/stale-auth-order.js";
import { repairStaleOAuthProfileShadows } from "./shared/stale-oauth-profile-shadows.js";
import { maybeRepairStalePluginConfig } from "./shared/stale-plugin-config.js";
import { maybeRepairStaleSubagentAllowlists } from "./shared/stale-subagent-allowlist.js";
import { isUpdatePackageSwapInProgress } from "./shared/update-phase.js";

/** Run doctor auto-repairs in dependency order and collect sanitized user notes. */
export async function runDoctorRepairSequence(params: {
  state: DoctorConfigMutationState;
  doctorFixCommand: string;
  env?: NodeJS.ProcessEnv;
  blockedCodexProviderPlan?: BlockedLegacyOpenAICodexProviderPlan;
  pluginMetadataSnapshotState?: DoctorPluginMetadataSnapshotState;
  runWithPluginMetadataSnapshot?: PluginMetadataSnapshotScopeRunner;
}): Promise<{
  state: DoctorConfigMutationState;
  changeNotes: string[];
  warningNotes: string[];
  authProfilesRepaired: boolean;
  openAICodexAuthProfileIdMap?: ReadonlyMap<string, string>;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
}> {
  let state = params.state;
  const pluginMetadataSnapshotState = params.pluginMetadataSnapshotState ?? {};
  const changeNotes: string[] = [];
  const warningNotes: string[] = [];
  const env = params.env ?? process.env;
  const resolveCurrentPluginMetadataScope = () => {
    const config = state.candidate;
    return {
      config,
      workspaceDir: resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config), env),
    };
  };
  const sanitizeLines = (lines: string[]) => lines.map((line) => sanitizeForLog(line)).join("\n");
  const appendNotes = (notes: string[], lines: string[] | undefined): void => {
    if (lines && lines.length > 0) {
      notes.push(sanitizeLines(lines));
    }
  };
  const appendRepairNotes = (repair: {
    changes: string[];
    warnings?: string[];
    notices?: string[];
  }): void => {
    appendNotes(changeNotes, repair.changes);
    appendNotes(warningNotes, repair.warnings);
    appendNotes(warningNotes, repair.notices);
  };
  const runWithCurrentPluginMetadata = <T>(run: () => T): T => {
    if (!params.runWithPluginMetadataSnapshot) {
      return run();
    }
    return params.runWithPluginMetadataSnapshot(resolveCurrentPluginMetadataScope(), run);
  };

  const applyMutation = (mutation: {
    config: DoctorConfigMutationState["candidate"];
    changes: string[];
    warnings?: string[];
  }) => {
    if (mutation.changes.length > 0) {
      appendNotes(changeNotes, mutation.changes);
      state = applyDoctorConfigMutation({
        state,
        mutation,
        shouldRepair: true,
      });
    }
    appendNotes(warningNotes, mutation.warnings);
  };
  type RepairStage = (config: DoctorConfigMutationState["candidate"]) =>
    | {
        config: DoctorConfigMutationState["candidate"];
        changes: string[];
        warnings?: string[];
      }
    | Promise<{
        config: DoctorConfigMutationState["candidate"];
        changes: string[];
        warnings?: string[];
      }>;
  const applyRepairStages = async (stages: readonly RepairStage[]): Promise<void> => {
    for (const repair of stages) {
      // Each descriptor consumes the previous repair's candidate; changing the
      // order can break owner repairs, allowlist inheritance, or upgrade safety.
      applyMutation(await runWithCurrentPluginMetadata(() => repair(state.candidate)));
    }
  };

  const initialChannelRepairs = await runWithCurrentPluginMetadata(() =>
    collectChannelDoctorRepairMutations({
      cfg: state.candidate,
      doctorFixCommand: params.doctorFixCommand,
      env,
    }),
  );
  for (const mutation of initialChannelRepairs) {
    applyMutation(mutation);
  }
  applyMutation(maybeRepairBundledPluginLoadPaths(state.candidate, env));
  const removedStaleManagedNpmBundledPlugins = maybeRepairStaleManagedNpmBundledPlugins({
    config: state.candidate,
    env,
    prompter: { shouldRepair: true },
  });
  const repairedPluginOpenClawHostLinks = await maybeRepairPluginOpenClawHostLinks({
    env,
    prompter: { shouldRepair: true },
  });
  const codexRouteRepair = runWithCurrentPluginMetadata(() =>
    maybeRepairCodexRoutes({
      cfg: state.candidate,
      env,
      shouldRepair: true,
      blockedProviderPlan: params.blockedCodexProviderPlan,
    }),
  );
  applyMutation({
    config: codexRouteRepair.cfg,
    changes: codexRouteRepair.changes,
    warnings: codexRouteRepair.warnings,
  });
  // Auth JSON is archived below; retain its exact collision-aware profile map
  // so durable session selections can follow the same account after import.
  const openAICodexAuthProfileIdMap = collectOpenAICodexAuthProfileStoreIdMap({
    cfg: state.candidate,
    env,
  });
  applyMutation(
    maybeRepairOpenAICodexAuthConfig(state.candidate, {
      profileIdMap: openAICodexAuthProfileIdMap,
    }),
  );
  applyMutation(
    await runWithCurrentPluginMetadata(() =>
      maybeRepairContextEngineHostCompatibility({
        cfg: state.candidate,
        doctorFixCommand: params.doctorFixCommand,
        env,
      }),
    ),
  );
  const missingConfiguredPluginInstallRepair = await runWithCurrentPluginMetadata(() =>
    repairMissingConfiguredPluginInstalls({
      cfg: state.candidate,
      env,
    }),
  );
  const repairedPluginIds = missingConfiguredPluginInstallRepair.repairedPluginIds ?? [];
  if (
    removedStaleManagedNpmBundledPlugins ||
    repairedPluginOpenClawHostLinks ||
    missingConfiguredPluginInstallRepair.pluginInventoryChanged
  ) {
    // Inventory repair changes the authoritative plugin generation. Replace the
    // shared Doctor base before later discovery so nested scopes cannot reuse stale metadata.
    const currentScope = resolveCurrentPluginMetadataScope();
    pluginMetadataSnapshotState.current = loadPluginMetadataSnapshot({
      config: currentScope.config,
      env,
      workspaceDir: currentScope.workspaceDir,
    });
  }
  if (missingConfiguredPluginInstallRepair.changes.length > 0) {
    appendNotes(changeNotes, missingConfiguredPluginInstallRepair.changes);
    applyMutation(
      applyPluginAutoEnable({
        config: state.candidate,
        env,
        manifestRegistry: pluginMetadataSnapshotState.current?.manifestRegistry,
      }),
    );
    if (repairedPluginIds.length > 0) {
      applyMutation(
        materializePluginAutoEnableCandidates({
          config: state.candidate,
          env,
          manifestRegistry: pluginMetadataSnapshotState.current?.manifestRegistry,
          candidates: repairedPluginIds.map((pluginId) => ({
            pluginId,
            kind: "configured-plugin-repaired" as const,
          })),
        }),
      );
      // Missing external plugins cannot expose their doctor contracts until
      // installation completes. Normalize legacy shapes before channel repair
      // so later validation and gateway restart consume canonical config.
      const channelCompatibilityMutations = runWithCurrentPluginMetadata(() =>
        collectChannelDoctorCompatibilityMutations(state.candidate, {
          env,
        }),
      );
      for (const mutation of channelCompatibilityMutations) {
        applyMutation(mutation);
      }
      const channelRepairs = await runWithCurrentPluginMetadata(() =>
        collectChannelDoctorRepairMutations({
          cfg: state.candidate,
          doctorFixCommand: params.doctorFixCommand,
          env,
        }),
      );
      for (const mutation of channelRepairs) {
        applyMutation(mutation);
      }
    }
  }
  appendNotes(warningNotes, missingConfiguredPluginInstallRepair.warnings);
  appendNotes(warningNotes, missingConfiguredPluginInstallRepair.notices);
  const failedPluginIds = missingConfiguredPluginInstallRepair.failedPluginIds ?? [];
  const hasUnscopedInstallRepairWarnings =
    missingConfiguredPluginInstallRepair.warnings.length > 0 && failedPluginIds.length === 0;
  const packageSwapInProgress = isUpdatePackageSwapInProgress(env);
  const pluginInstallRepairConverged =
    !packageSwapInProgress && failedPluginIds.length === 0 && !hasUnscopedInstallRepairWarnings;
  if (pluginInstallRepairConverged) {
    // Provider availability is authoritative only after configured plugin repair
    // converges. Preserve model refs while package installation still needs a retry.
    applyMutation(
      repairStaleAgentModelRefs(state.candidate, {
        env,
        pluginMetadataSnapshot: pluginMetadataSnapshotState.current,
      }),
    );
  }
  if (!packageSwapInProgress && !hasUnscopedInstallRepairWarnings) {
    applyMutation(
      runWithCurrentPluginMetadata(() =>
        maybeRepairStalePluginConfig(state.candidate, env, {
          preservePluginIds: failedPluginIds,
          // A host-version-bound runtime can be absent between core swap and package
          // convergence. Preserve its allow, deny, and explicit enable/disable policy.
          surfacePreservePluginIds: VERSION_BOUND_RUNTIME_PLUGIN_POLICY_IDS_BY_SURFACE,
        }),
      ),
    );
  }
  await applyRepairStages([
    maybeRepairInvalidPluginConfig,
    maybeRepairAllowlistPolicyAllowFrom,
    maybeRepairOpenPolicyAllowFrom,
    maybeRepairGroupAllowFromFallback,
    maybeRepairStaleSubagentAllowlists,
  ]);

  const emptyAllowlistWarnings = runWithCurrentPluginMetadata(() =>
    scanEmptyAllowlistPolicyWarnings(state.candidate, {
      doctorFixCommand: params.doctorFixCommand,
      ...createChannelDoctorEmptyAllowlistPolicyHooks({ cfg: state.candidate, env }),
    }),
  );
  appendNotes(warningNotes, emptyAllowlistWarnings);

  await applyRepairStages([maybeRepairLegacyToolsBySenderKeys, maybeRepairExecSafeBinProfiles]);
  appendRepairNotes(await migrateLegacySkillWorkshopProposals({ config: state.candidate, env }));
  appendRepairNotes(migrateLegacyTailscaleProfileIdentities({ env }));
  appendRepairNotes(await cleanupLegacyPluginDependencyState({ env }));
  appendRepairNotes(
    migrateLegacyOnboardingRecommendationsScope({
      cfg: state.candidate,
      env,
    }),
  );
  const legacyOAuthSidecarRepair = await maybeRepairLegacyOAuthSidecarProfiles({
    cfg: state.candidate,
    prompter: { confirmAutoFix: async () => true },
    emitNotes: false,
    env,
  });
  appendRepairNotes(legacyOAuthSidecarRepair);
  const staleOAuthShadowRepair = await repairStaleOAuthProfileShadows({
    cfg: state.candidate,
    env,
  });
  appendRepairNotes(staleOAuthShadowRepair);
  const authProfileSqliteMigration = await maybeMigrateAuthProfileJsonStoresToSqlite({
    cfg: state.candidate,
    prompter: { confirmAutoFix: async () => true },
    env,
    openAICodexAuthProfileIdMap,
  });
  if (authProfileSqliteMigration.configChanged) {
    state = applyDoctorConfigMutation({
      state,
      mutation: {
        config: state.candidate,
        changes: ["Auth profile SQLite migration updated auth.profiles."],
      },
      shouldRepair: true,
    });
  }
  appendRepairNotes(authProfileSqliteMigration);
  const staleAuthOrderRepair = maybeRepairStaleConfiguredAuthOrders({
    cfg: state.candidate,
    env,
  });
  applyMutation(staleAuthOrderRepair);
  const authProfilesRepaired =
    legacyOAuthSidecarRepair.changes.length > 0 ||
    staleOAuthShadowRepair.changes.length > 0 ||
    authProfileSqliteMigration.changes.length > 0;

  return {
    state,
    changeNotes,
    warningNotes,
    authProfilesRepaired,
    ...(openAICodexAuthProfileIdMap.size > 0 ? { openAICodexAuthProfileIdMap } : {}),
    ...(pluginMetadataSnapshotState.current
      ? { pluginMetadataSnapshot: pluginMetadataSnapshotState.current }
      : {}),
  };
}
