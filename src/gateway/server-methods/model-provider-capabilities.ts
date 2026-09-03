import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import {
  resolveManifestDeclaredProviderAuthChoices,
  resolveManifestProviderAuthChoices,
} from "../../plugins/provider-auth-choices.js";
import { listProviderAccessOptions } from "../../plugins/provider-login-options.js";
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
    includeWorkspacePlugins: false,
  };
  const resolveProvider = (provider: string) => resolveProviderIdForAuth(provider, lookup);
  const { providers, modelCatalogProviders } = params.metadataSnapshot.owners;
  const modelProviders = new Set(
    [...providers.keys(), ...modelCatalogProviders.keys()].map(resolveProvider),
  );
  const authChoices = resolveManifestProviderAuthChoices(lookup);
  const accessOptionsByChoiceId = new Map(
    listProviderAccessOptions(resolveManifestDeclaredProviderAuthChoices(lookup)).map((option) => [
      option.id,
      option,
    ]),
  );
  const capabilities = new Map<string, ModelProviderCapability>();
  // Access options keep the manifest's declaration order; clients sort provider rows.
  for (const choice of authChoices) {
    const provider = resolveProvider(choice.providerId);
    // Setup descriptors also include tools and media-only services, not just model accounts.
    if (!modelProviders.has(provider) || !supportsSetupTextInference(choice.onboardingScopes)) {
      continue;
    }
    const current = capabilities.get(provider);
    const apiKeySupported = choice.methodId === "api-key";
    const quickApiKeySetup = apiKeySupported && supportsSetupManualSecret(choice);
    const accessOption = accessOptionsByChoiceId.get(choice.choiceId);
    const accessOptions = [
      ...(current?.accessOptions ?? []),
      ...(accessOption
        ? [{ id: accessOption.id, label: accessOption.label, mode: accessOption.mode }]
        : []),
    ];
    capabilities.set(provider, {
      provider,
      apiKeySupported: current?.apiKeySupported === true || apiKeySupported,
      quickApiKeySetup: current?.quickApiKeySetup === true || quickApiKeySetup,
      ...(accessOptions.length > 0 ? { accessOptions } : {}),
    });
  }
  return {
    capabilities: [...capabilities.values()].toSorted((a, b) =>
      a.provider.localeCompare(b.provider),
    ),
    resolveProvider,
  };
}
