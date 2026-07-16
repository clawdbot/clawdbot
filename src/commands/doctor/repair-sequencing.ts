// Doctor repair sequence coordinator for config, auth, plugin, and warning repairs.
import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";
import {
  applyPluginAutoEnable,
  materializePluginAutoEnableCandidates,
} from "../../config/plugin-auto-enable.js";
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
import { collectActiveToolSchemaProjectionWarnings } from "./shared/active-tool-schema-warnings.js";
import { maybeRepairGroupAllowFromFallback } from "./shared/allowfrom-fallback-migration.js";
import { maybeRepairAllowlistPolicyAllowFrom } from "./shared/allowlist-policy-repair.js";
import { maybeRepairBundledPluginLoadPaths } from "./shared/bundled-plugin-load-paths.js";
import {
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

  const applyMutation = (mutation: {
    config: DoctorConfigMutationState["candidate"];
    changes: string[];
    warnings?: string[];
  }) => {
    if (mutation.changes.length > 0) {
      changeNotes.push(sanitizeLines(mutation.changes));
      state = applyDoctorConfigMutation({
        state,
        mutation,
        shouldRepair: true,
      });
    }
    if (mutation.warnings && mutation.warnings.length > 0) {
      warningNotes.push(sanitizeLines(mutation.warnings));
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
    changeNotes.push(sanitizeLines(missingConfiguredPluginInstallRepair.changes));
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
    }
  }
  if (missingConfiguredPluginInstallRepair.warnings.length > 0) {
    warningNotes.push(sanitizeLines(missingConfiguredPluginInstallRepair.warnings));
  }
  const missingConfiguredPluginInstallNotices = missingConfiguredPluginInstallRepair.notices ?? [];
  if (missingConfiguredPluginInstallNotices.length > 0) {
    warningNotes.push(sanitizeLines(missingConfiguredPluginInstallNotices));
  }
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
  applyMutation(maybeRepairInvalidPluginConfig(state.candidate));
  applyMutation(await maybeRepairAllowlistPolicyAllowFrom(state.candidate));
  applyMutation(maybeRepairOpenPolicyAllowFrom(state.candidate));
  applyMutation(maybeRepairGroupAllowFromFallback(state.candidate));
  applyMutation(maybeRepairStaleSubagentAllowlists(state.candidate));

  const emptyAllowlistWarnings = scanEmptyAllowlistPolicyWarnings(state.candidate, {
    doctorFixCommand: params.doctorFixCommand,
    ...createChannelDoctorEmptyAllowlistPolicyHooks({ cfg: state.candidate, env }),
  });
  if (emptyAllowlistWarnings.length > 0) {
    warningNotes.push(sanitizeLines(emptyAllowlistWarnings));
  }

  applyMutation(maybeRepairLegacyToolsBySenderKeys(state.candidate));
  applyMutation(maybeRepairExecSafeBinProfiles(state.candidate));
  const pluginDependencyCleanup = await cleanupLegacyPluginDependencyState({ env });
  if (pluginDependencyCleanup.changes.length > 0) {
    changeNotes.push(sanitizeLines(pluginDependencyCleanup.changes));
  }
  if (pluginDependencyCleanup.warnings.length > 0) {
    warningNotes.push(sanitizeLines(pluginDependencyCleanup.warnings));
  }
  const legacyOAuthSidecarRepair = await maybeRepairLegacyOAuthSidecarProfiles({
    cfg: state.candidate,
    prompter: { confirmAutoFix: async () => true },
    emitNotes: false,
    env,
  });
  if (legacyOAuthSidecarRepair.changes.length > 0) {
    changeNotes.push(sanitizeLines(legacyOAuthSidecarRepair.changes));
  }
  if (legacyOAuthSidecarRepair.warnings.length > 0) {
    warningNotes.push(sanitizeLines(legacyOAuthSidecarRepair.warnings));
  }
  const openAIAuthProviderRepair = await maybeRepairOpenAICodexAuthProfileStores({
    cfg: state.candidate,
    env,
  });
  if (openAIAuthProviderRepair.changes.length > 0) {
    changeNotes.push(sanitizeLines(openAIAuthProviderRepair.changes));
  }
  if (openAIAuthProviderRepair.warnings.length > 0) {
    warningNotes.push(sanitizeLines(openAIAuthProviderRepair.warnings));
  }
  const staleOAuthShadowRepair = await repairStaleOAuthProfileShadows({
    cfg: state.candidate,
    env,
  });
  if (staleOAuthShadowRepair.changes.length > 0) {
    changeNotes.push(sanitizeLines(staleOAuthShadowRepair.changes));
  }
  if (staleOAuthShadowRepair.warnings.length > 0) {
    warningNotes.push(sanitizeLines(staleOAuthShadowRepair.warnings));
  }
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
  if (authProfileSqliteMigration.changes.length > 0) {
    changeNotes.push(sanitizeLines(authProfileSqliteMigration.changes));
  }
  if (authProfileSqliteMigration.warnings.length > 0) {
    warningNotes.push(sanitizeLines(authProfileSqliteMigration.warnings));
  }
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

  const activeToolSchemaWarnings = collectActiveToolSchemaProjectionWarnings({
    cfg: state.candidate,
    env,
  });
  if (activeToolSchemaWarnings.length > 0) {
    warningNotes.push(sanitizeLines(activeToolSchemaWarnings));
  }

  return { state, changeNotes, warningNotes, authProfilesRepaired };
}
