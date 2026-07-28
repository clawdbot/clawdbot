// Doctor repair sequence coordinator for config, auth, plugin, and warning repairs.
import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";
import {
  applyPluginAutoEnable,
  materializePluginAutoEnableCandidates,
} from "../../config/plugin-auto-enable.js";
import { migrateLegacyOnboardingRecommendationsScope } from "../../infra/state-migrations.onboarding-recommendations.js";
import {
  collectOpenAICodexAuthProfileStoreIdMap,
  maybeMigrateAuthProfileJsonStoresToSqlite,
  maybeRepairOpenAICodexAuthConfig,
  maybeRepairOpenAICodexAuthProfileStores,
} from "../doctor-auth-flat-profiles.js";
import { maybeRepairLegacyOAuthSidecarProfiles } from "../doctor-auth-oauth-sidecar.js";
import {
  maybeRepairManagedNpmOpenClawPeerLinks,
  maybeRepairStaleManagedNpmBundledPlugins,
} from "../doctor-plugin-registry.js";
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
}): Promise<{
  state: DoctorConfigMutationState;
  changeNotes: string[];
  warningNotes: string[];
  authProfilesRepaired: boolean;
}> {
  let state = params.state;
  const changeNotes: string[] = [];
  const warningNotes: string[] = [];
  const env = params.env ?? process.env;
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
      applyMutation(await repair(state.candidate));
    }
  };

  for (const mutation of await collectChannelDoctorRepairMutations({
    cfg: state.candidate,
    doctorFixCommand: params.doctorFixCommand,
    env,
  })) {
    applyMutation(mutation);
  }
  applyMutation(maybeRepairBundledPluginLoadPaths(state.candidate, env));
  maybeRepairStaleManagedNpmBundledPlugins({
    config: state.candidate,
    env,
    prompter: { shouldRepair: true },
  });
  await maybeRepairManagedNpmOpenClawPeerLinks({
    config: state.candidate,
    env,
    prompter: { shouldRepair: true },
  });
  const codexRouteRepair = maybeRepairCodexRoutes({
    cfg: state.candidate,
    env,
    shouldRepair: true,
    blockedProviderPlan: params.blockedCodexProviderPlan,
  });
  applyMutation({
    config: codexRouteRepair.cfg,
    changes: codexRouteRepair.changes,
    warnings: codexRouteRepair.warnings,
  });
  applyMutation(
    maybeRepairOpenAICodexAuthConfig(state.candidate, {
      profileIdMap: collectOpenAICodexAuthProfileStoreIdMap({
        cfg: state.candidate,
        env,
      }),
    }),
  );
  applyMutation(
    await maybeRepairContextEngineHostCompatibility({
      cfg: state.candidate,
      doctorFixCommand: params.doctorFixCommand,
      env,
    }),
  );
  const missingConfiguredPluginInstallRepair = await repairMissingConfiguredPluginInstalls({
    cfg: state.candidate,
    env,
  });
  if (missingConfiguredPluginInstallRepair.changes.length > 0) {
    appendNotes(changeNotes, missingConfiguredPluginInstallRepair.changes);
    applyMutation(applyPluginAutoEnable({ config: state.candidate, env }));
    const repairedPluginIds = missingConfiguredPluginInstallRepair.repairedPluginIds ?? [];
    if (repairedPluginIds.length > 0) {
      applyMutation(
        materializePluginAutoEnableCandidates({
          config: state.candidate,
          env,
          candidates: repairedPluginIds.map((pluginId) => ({
            pluginId,
            kind: "configured-plugin-repaired" as const,
          })),
        }),
      );
      // Missing external plugins cannot expose their doctor contracts until
      // installation completes. Normalize legacy shapes before channel repair
      // so later validation and gateway restart consume canonical config.
      for (const mutation of collectChannelDoctorCompatibilityMutations(state.candidate, { env })) {
        applyMutation(mutation);
      }
      for (const mutation of await collectChannelDoctorRepairMutations({
        cfg: state.candidate,
        doctorFixCommand: params.doctorFixCommand,
        env,
      })) {
        applyMutation(mutation);
      }
    }
  }
  appendNotes(warningNotes, missingConfiguredPluginInstallRepair.warnings);
  appendNotes(warningNotes, missingConfiguredPluginInstallRepair.notices);
  const failedPluginIds = missingConfiguredPluginInstallRepair.failedPluginIds ?? [];
  const hasUnscopedInstallRepairWarnings =
    missingConfiguredPluginInstallRepair.warnings.length > 0 && failedPluginIds.length === 0;
  if (!isUpdatePackageSwapInProgress(env) && !hasUnscopedInstallRepairWarnings) {
    applyMutation(
      maybeRepairStalePluginConfig(state.candidate, env, {
        preservePluginIds: failedPluginIds,
        // A host-version-bound runtime can be absent between core swap and package
        // convergence. Preserve its allow, deny, and explicit enable/disable policy.
        surfacePreservePluginIds: VERSION_BOUND_RUNTIME_PLUGIN_POLICY_IDS_BY_SURFACE,
      }),
    );
  }
  await applyRepairStages([
    maybeRepairInvalidPluginConfig,
    maybeRepairAllowlistPolicyAllowFrom,
    maybeRepairOpenPolicyAllowFrom,
    maybeRepairGroupAllowFromFallback,
    maybeRepairStaleSubagentAllowlists,
  ]);

  const emptyAllowlistWarnings = scanEmptyAllowlistPolicyWarnings(state.candidate, {
    doctorFixCommand: params.doctorFixCommand,
    ...createChannelDoctorEmptyAllowlistPolicyHooks({ cfg: state.candidate, env }),
  });
  appendNotes(warningNotes, emptyAllowlistWarnings);

  await applyRepairStages([maybeRepairLegacyToolsBySenderKeys, maybeRepairExecSafeBinProfiles]);
  appendRepairNotes(await migrateLegacySkillWorkshopProposals({ config: state.candidate, env }));
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
  const openAIAuthProviderRepair = await maybeRepairOpenAICodexAuthProfileStores({
    cfg: state.candidate,
    env,
  });
  appendRepairNotes(openAIAuthProviderRepair);
  const staleOAuthShadowRepair = await repairStaleOAuthProfileShadows({
    cfg: state.candidate,
    env,
  });
  appendRepairNotes(staleOAuthShadowRepair);
  const authProfileSqliteMigration = await maybeMigrateAuthProfileJsonStoresToSqlite({
    cfg: state.candidate,
    prompter: { confirmAutoFix: async () => true },
    env,
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
    openAIAuthProviderRepair.changes.length > 0 ||
    staleOAuthShadowRepair.changes.length > 0 ||
    authProfileSqliteMigration.changes.length > 0;

  return { state, changeNotes, warningNotes, authProfilesRepaired };
}
