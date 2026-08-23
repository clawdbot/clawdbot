import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { enablePluginInConfig } from "./enable.js";
import {
  type ProviderAuthChoiceMetadata,
  resolveManifestProviderAuthChoices,
} from "./provider-auth-choices.js";
import { resolvePluginProvidersCore } from "./providers.runtime.js";

const log = createSubsystemLogger("plugins/provider-setup-availability");

function supportsTextInference(choice: ProviderAuthChoiceMetadata): boolean {
  return !choice.onboardingScopes || choice.onboardingScopes.includes("text-inference");
}

/** Detect reachable provider-owned services for the classic setup picker. */
export async function detectAvailableSetupProviderIds(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ReadonlySet<string>> {
  const env = params.env ?? process.env;
  const choices = resolveManifestProviderAuthChoices({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env,
    includeUntrustedWorkspacePlugins: false,
  }).filter(
    (choice) =>
      choice.appGuidedDiscovery === true &&
      choice.assistantVisibility !== "manual-only" &&
      supportsTextInference(choice),
  );
  let discoveryConfig = params.config;
  const enabledChoices = choices.filter((choice) => {
    const enabled = enablePluginInConfig(discoveryConfig, choice.pluginId);
    discoveryConfig = enabled.config;
    return enabled.enabled;
  });
  if (enabledChoices.length === 0) {
    return new Set();
  }

  const providers = resolvePluginProvidersCore({
    config: discoveryConfig,
    workspaceDir: params.workspaceDir,
    env,
    mode: "setup",
    includeUntrustedWorkspacePlugins: false,
    onlyPluginIds: uniqueStrings(enabledChoices.map((choice) => choice.pluginId)),
  });
  const detected = await Promise.all(
    enabledChoices.map(async (choice) => {
      const provider = providers.find(
        (candidate) =>
          candidate.pluginId === choice.pluginId &&
          normalizeProviderId(candidate.id) === normalizeProviderId(choice.providerId),
      );
      const method = provider?.auth.find(
        (candidate) => normalizeProviderId(candidate.id) === normalizeProviderId(choice.methodId),
      );
      if (!method?.appGuidedSetup?.detectAvailability) {
        return undefined;
      }
      try {
        return (await method.appGuidedSetup.detectAvailability({
          config: discoveryConfig,
          env,
          workspaceDir: params.workspaceDir,
        }))
          ? choice.providerId
          : undefined;
      } catch (error) {
        log.debug(
          `Provider availability detection failed for ${choice.choiceId}: ${formatErrorMessage(error)}`,
        );
        return undefined;
      }
    }),
  );
  return new Set(detected.filter((providerId): providerId is string => Boolean(providerId)));
}
