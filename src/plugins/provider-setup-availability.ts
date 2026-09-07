import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { enablePluginInConfig, enablePluginWithCapabilityConsent } from "./enable.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";
import {
  type ProviderAuthChoiceMetadata,
  resolveManifestProviderAuthChoices,
} from "./provider-auth-choices.js";
import { acquirePluginProvidersCore } from "./providers.runtime.js";

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
  // The artifact lease ends after import; the resource claim survives all provider probes.
  const providerHandles: ReturnType<typeof acquirePluginProvidersCore>[] = [];
  try {
    const discovery = await withPluginLifecycleLease({ env }, async () => {
      let discoveryConfig = params.config;
      const enabledChoices: ProviderAuthChoiceMetadata[] = [];
      for (const choice of choices) {
        // Discovery executes plugin code: only probe existing accepted or legacy runtimes.
        const enabled = await enablePluginWithCapabilityConsent(params.config, choice.pluginId, {
          env,
          workspaceDir: params.workspaceDir,
        });
        if (enabled.enabled) {
          discoveryConfig = enablePluginInConfig(discoveryConfig, choice.pluginId).config;
          enabledChoices.push(choice);
        }
      }
      const providerHandle =
        enabledChoices.length === 0
          ? undefined
          : acquirePluginProvidersCore({
              config: discoveryConfig,
              workspaceDir: params.workspaceDir,
              env,
              mode: "setup",
              includeUntrustedWorkspacePlugins: false,
              onlyPluginIds: uniqueStrings(enabledChoices.map((choice) => choice.pluginId)),
            });
      if (providerHandle) {
        providerHandles.push(providerHandle);
      }
      return { discoveryConfig, enabledChoices, providerHandle };
    });
    const probes = await Promise.allSettled(
      discovery.enabledChoices.map(async (choice) => {
        const provider = discovery.providerHandle?.providers.find(
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
            config: discovery.discoveryConfig,
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
    const detected = probes.map((probe) => {
      if (probe.status === "rejected") {
        throw probe.reason;
      }
      return probe.value;
    });
    return new Set(detected.filter((providerId): providerId is string => Boolean(providerId)));
  } finally {
    for (const handle of providerHandles) {
      handle.release();
    }
  }
}
