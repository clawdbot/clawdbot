import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { resolveManifestProviderAuthChoices } from "../../plugins/provider-auth-choices.js";
import { supportsSetupManualSecret } from "../../system-agent/setup-inference-auth-options.js";
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
  const env = params.env ?? process.env;
  const resolveProvider = (provider: string) =>
    resolveProviderIdForAuth(provider, {
      config: params.config,
      env,
      workspaceDir: params.workspaceDir,
      includeUntrustedWorkspacePlugins: false,
      metadataSnapshot: params.metadataSnapshot,
    });
  const capabilities = new Map<string, ModelProviderCapability>();
  for (const choice of resolveManifestProviderAuthChoices({
    config: params.config,
    env,
    workspaceDir: params.workspaceDir,
    includeUntrustedWorkspacePlugins: false,
    metadataSnapshot: params.metadataSnapshot,
  })) {
    const provider = resolveProvider(choice.providerId);
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
