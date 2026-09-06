import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { resolveManifestProviderAuthChoices } from "../../plugins/provider-auth-choices.js";
import {
  supportsSetupManualSecret,
  supportsSetupTextInference,
} from "../../system-agent/setup-inference-auth-options.js";
import type { ModelProviderCapability } from "./models-auth-status.types.js";

export function resolveModelProviderCapabilities(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  metadataSnapshot: PluginMetadataSnapshot;
  workspaceDir: string;
}): {
  capabilities: ModelProviderCapability[];
  resolveProvider: (provider: string) => string;
} {
  const lookup = {
    ...params,
    env: params.env ?? process.env,
    includeUntrustedWorkspacePlugins: false,
  };
  const resolveProvider = (provider: string) => resolveProviderIdForAuth(provider, lookup);
  const { providers, modelCatalogProviders } = params.metadataSnapshot.owners;
  const modelProviders = new Set(
    [...providers.keys(), ...modelCatalogProviders.keys()].map(resolveProvider),
  );
  const capabilities = new Map<string, ModelProviderCapability>();
  for (const choice of resolveManifestProviderAuthChoices(lookup)) {
    const provider = resolveProvider(choice.providerId);
    // Setup descriptors also include tools and media-only services, not just model accounts.
    if (!modelProviders.has(provider) || !supportsSetupTextInference(choice.onboardingScopes)) {
      continue;
    }
    const current = capabilities.get(provider);
    const apiKeySupported = choice.methodId === "api-key";
    const quickApiKeySetup = apiKeySupported && supportsSetupManualSecret(choice);
    capabilities.set(provider, {
      provider,
      apiKeySupported: current?.apiKeySupported === true || apiKeySupported,
      quickApiKeySetup: current?.quickApiKeySetup === true || quickApiKeySetup,
    });
  }
  return {
    capabilities: [...capabilities.values()].toSorted((a, b) =>
      a.provider.localeCompare(b.provider),
    ),
    resolveProvider,
  };
}
