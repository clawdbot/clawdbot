import { isDeepStrictEqual } from "node:util";
import { normalizeProviderId } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { enablePluginInConfig, enablePluginWithCapabilityConsent } from "../plugins/enable.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { installProviderAuthChoicePlugin } from "../plugins/provider-auth-choice.js";
import {
  resolveManifestProviderAuthChoice,
  type ProviderAuthChoiceMetadata,
} from "../plugins/provider-auth-choices.js";
import { resolveProviderInstallCatalogEntry } from "../plugins/provider-install-catalog.js";
import { resolvePluginProvidersCore } from "../plugins/providers.runtime.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { createPluginCapabilityConsentPrompter } from "../wizard/plugin-capability-consent.js";
import {
  supportsSetupManualSecret,
  supportsSetupTextInference,
} from "./setup-inference-auth-options.js";
import type { ActivateSetupInferenceDeps } from "./setup-inference-core.js";
import { throwIfSetupInferenceCancelled } from "./setup-inference-core.js";
import type { buildTestPlan } from "./setup-inference-plan.js";

/** Carry reviewed callable auth methods past the lease, never an unbound enabled config. */
export async function prepareSetupProviderAuthChoice(
  params: Parameters<typeof buildTestPlan>[0],
  choice: ProviderAuthChoiceMetadata,
) {
  return await withPluginLifecycleLease({ signal: params.signal }, async () => {
    throwIfSetupInferenceCancelled(params);
    const enablePlugin = params.deps.enablePluginInConfig ?? enablePluginInConfig;
    const baseEnableResult = enablePlugin(params.cfg, choice.pluginId);
    const sourceEnableResult = enablePlugin(params.sourceCfg, choice.pluginId);
    if (!baseEnableResult.enabled || !sourceEnableResult.enabled) {
      return {
        error: `${choice.choiceLabel} is disabled (${baseEnableResult.reason ?? sourceEnableResult.reason ?? "blocked"}).`,
      };
    }
    let config = params.cfg;
    let installationPlugins: OpenClawConfig["plugins"];
    const resolveChoice =
      params.deps.resolveManifestProviderAuthChoice ?? resolveManifestProviderAuthChoice;
    const scope = {
      config,
      workspaceDir: params.pluginWorkspaceDir,
      includeUntrustedWorkspacePlugins: false,
      includeWorkspacePlugins: false,
    };
    if (!resolveChoice(choice.choiceId, scope)) {
      const entry = (
        params.deps.resolveProviderInstallCatalogEntry ?? resolveProviderInstallCatalogEntry
      )(choice.choiceId, scope);
      if (!entry || entry.pluginId !== choice.pluginId || !params.prompter) {
        return { error: "This provider needs installation through an interactive setup session." };
      }
      const installed = await installProviderAuthChoicePlugin({
        config,
        entry,
        prompter: params.prompter,
        runtime: params.runtime,
        workspaceDir: params.pluginWorkspaceDir,
        beforePersistentEffect: async () => {
          throwIfSetupInferenceCancelled(params);
          await params.beforePersistentEffect?.();
          throwIfSetupInferenceCancelled(params);
        },
      });
      if (!installed.installed) {
        return {
          error: installed.error ?? "Provider installation was declined or did not complete.",
        };
      }
      // Installation is preparatory, not model promotion. Retain unpromoted package
      // bytes so failed/cancelled authentication cannot strand an unowned generation.
      const record = installed.cfg.plugins?.installs?.[choice.pluginId];
      if (
        record &&
        !(await retainSetupProviderInstall({
          pluginId: choice.pluginId,
          record,
          deps: params.deps,
        }))
      ) {
        return {
          error: "Could not retain the provider package safely. No inference route was changed.",
        };
      }
      config = installed.cfg;
      installationPlugins = config.plugins;
    }
    throwIfSetupInferenceCancelled(params);
    const prepare = async () => {
      const enableResult = await enablePluginWithCapabilityConsent(config, choice.pluginId, {
        workspaceDir: params.pluginWorkspaceDir,
        beforePersistentEffect: params.beforePersistentEffect,
        onCapabilityConsent: params.prompter
          ? createPluginCapabilityConsentPrompter(params.prompter, () =>
              throwIfSetupInferenceCancelled(params),
            )
          : undefined,
      });
      if (!enableResult.enabled) {
        return {
          error: `${choice.choiceLabel} is disabled (${enableResult.reason ?? "blocked"}).`,
        };
      }
      const resolve = () => {
        const installedChoice = resolveChoice(choice.choiceId, {
          ...scope,
          config: enableResult.config,
        });
        if (
          !installedChoice ||
          installedChoice.pluginId !== choice.pluginId ||
          installedChoice.providerId !== choice.providerId ||
          installedChoice.methodId !== choice.methodId ||
          !supportsSetupTextInference(installedChoice.onboardingScopes) ||
          (params.kind === "provider-auth" &&
            installedChoice.assistantVisibility === "manual-only") ||
          (choice.appGuidedSecret === true && !supportsSetupManualSecret(installedChoice)) ||
          (choice.appGuidedAuth && installedChoice.appGuidedAuth !== choice.appGuidedAuth) ||
          (choice.appGuidedDiscovery === true && installedChoice.appGuidedDiscovery !== true)
        ) {
          return {
            error:
              "The installed provider no longer supports the selected setup method. Run detection again.",
          };
        }
        const providers = (params.deps.resolvePluginProviders ?? resolvePluginProvidersCore)({
          config: enableResult.config,
          workspaceDir: params.pluginWorkspaceDir,
          mode: "setup",
          includeUntrustedWorkspacePlugins: false,
          onlyPluginIds: [choice.pluginId],
        });
        const provider = providers.find(
          (candidate) =>
            candidate.pluginId === choice.pluginId &&
            normalizeProviderId(candidate.id) === normalizeProviderId(choice.providerId),
        );
        const method = provider?.auth.find((candidate) => candidate.id === choice.methodId);
        return {
          enableResult,
          baseEnableResult,
          sourceEnableResult,
          provider,
          method,
          installationPlugins,
        };
      };
      if (installationPlugins === undefined) {
        return resolve();
      }
      const metadataSnapshot = (
        params.deps.resolvePluginMetadataSnapshot ?? resolvePluginMetadataSnapshot
      )({
        config: enableResult.config,
        workspaceDir: params.pluginWorkspaceDir,
        allowCurrent: false,
      });
      return withPluginRuntimeGenerationScope({ metadataSnapshot }, resolve);
    };
    // The lease may have cached absence. New setup facts must not replace the
    // running Gateway inventory; only its normal reload owns that transition.
    return installationPlugins === undefined
      ? await prepare()
      : await withPluginCache(createPluginCache(), prepare);
  });
}

/** Retain preparatory artifacts until the generic install writer adopts their exact record. */
export async function retainSetupProviderInstall(params: {
  pluginId: string;
  record: PluginInstallRecord;
  deps: ActivateSetupInferenceDeps;
  verifyOwnership?: boolean;
}): Promise<boolean> {
  const installPath = params.record.installPath;
  if (params.record.source !== "npm" || !installPath) {
    return true;
  }
  try {
    return await withPluginLifecycleLease({}, async (lease) => {
      if (params.verifyOwnership) {
        const { readPersistedInstalledPluginIndexInstallRecords } =
          await import("../plugins/installed-plugin-index-records.js");
        const current = await (
          params.deps.readPersistedInstalledPluginIndexInstallRecords ??
          readPersistedInstalledPluginIndexInstallRecords
        )();
        lease.assertOwned();
        if (isDeepStrictEqual(current?.[params.pluginId], params.record)) {
          return true;
        }
      }
      const { markRetainedManagedNpmInstall } = await import("../plugins/managed-npm-retention.js");
      lease.assertOwned();
      return await (params.deps.markRetainedManagedNpmInstall ?? markRetainedManagedNpmInstall)({
        packageDir: installPath,
        pluginId: params.pluginId,
        reason: "openclaw-inference-activation-not-committed",
      });
    });
  } catch {
    return false;
  }
}
