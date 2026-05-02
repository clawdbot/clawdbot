import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeSecretInputString, resolveSecretInputRef } from "../config/types.secrets.js";
import { normalizeSecretInput } from "../utils/normalize-secret-input.js";

type RuntimeWebProviderMetadata = {
  providerConfigured?: string;
  selectedProvider?: string;
};

type ProviderWithCredential = {
  envVars: string[];
  requiresCredential?: boolean;
};

export function resolveWebProviderConfig(
  cfg: OpenClawConfig | undefined,
  kind: "search" | "fetch",
): Record<string, unknown> | undefined {
  const webConfig = cfg?.tools?.web;
  if (!webConfig || typeof webConfig !== "object") {
    return undefined;
  }
  const toolConfig = webConfig[kind];
  if (!toolConfig || typeof toolConfig !== "object") {
    return undefined;
  }
  return toolConfig as Record<string, unknown>;
}

export function readWebProviderEnvValue(
  envVars: string[],
  processEnv: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const envVar of envVars) {
    const value = normalizeSecretInput(processEnv[envVar]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

export function providerRequiresCredential(
  provider: Pick<ProviderWithCredential, "requiresCredential">,
): boolean {
  return provider.requiresCredential !== false;
}

export function hasWebProviderEntryCredential<
  TProvider extends ProviderWithCredential,
  TConfig extends Record<string, unknown> | undefined,
>(params: {
  provider: TProvider;
  config: OpenClawConfig | undefined;
  toolConfig: TConfig;
  resolveRawValue: (params: {
    provider: TProvider;
    config: OpenClawConfig | undefined;
    toolConfig: TConfig;
  }) => unknown;
  resolveFallbackRawValue?: (params: {
    provider: TProvider;
    config: OpenClawConfig | undefined;
    toolConfig: TConfig;
  }) => unknown;
  resolveEnvValue: (params: {
    provider: TProvider;
    configuredEnvVarId?: string;
  }) => string | undefined;
}): boolean {
  if (!providerRequiresCredential(params.provider)) {
    return true;
  }
  const rawValue = params.resolveRawValue({
    provider: params.provider,
    config: params.config,
    toolConfig: params.toolConfig,
  });
  const configuredRef = resolveSecretInputRef({
    value: rawValue,
  }).ref;
  if (configuredRef && configuredRef.source !== "env") {
    return true;
  }
  const fromConfig = normalizeSecretInput(normalizeSecretInputString(rawValue));
  if (fromConfig) {
    return true;
  }
  if (
    params.resolveEnvValue({
      provider: params.provider,
      configuredEnvVarId: configuredRef?.source === "env" ? configuredRef.id : undefined,
    })
  ) {
    return true;
  }
  const fallbackRawValue = params.resolveFallbackRawValue?.({
    provider: params.provider,
    config: params.config,
    toolConfig: params.toolConfig,
  });
  const fallbackRef = resolveSecretInputRef({ value: fallbackRawValue }).ref;
  if (fallbackRef && fallbackRef.source !== "env") {
    return true;
  }
  const fallbackConfig = normalizeSecretInput(normalizeSecretInputString(fallbackRawValue));
  if (fallbackConfig) {
    return true;
  }
  return Boolean(
    fallbackRef?.source === "env"
      ? params.resolveEnvValue({
          provider: params.provider,
          configuredEnvVarId: fallbackRef.id,
        })
      : undefined,
  );
}

export function resolveWebProviderDefinition<
  TProvider extends { id: string },
  TConfig extends Record<string, unknown> | undefined,
  TRuntimeMetadata extends RuntimeWebProviderMetadata,
  TDefinition,
>(params: {
  config: OpenClawConfig | undefined;
  toolConfig: TConfig;
  runtimeMetadata: TRuntimeMetadata | undefined;
  sandboxed?: boolean;
  providerId?: string;
  providers: TProvider[];
  resolveEnabled: (params: { toolConfig: TConfig; sandboxed?: boolean }) => boolean;
  resolveAutoProviderId: (params: {
    config: OpenClawConfig | undefined;
    toolConfig: TConfig;
    providers: TProvider[];
  }) => string;
  resolveFallbackProviderId?: (params: {
    config: OpenClawConfig | undefined;
    toolConfig: TConfig;
    providers: TProvider[];
    providerId: string;
  }) => string | undefined;
  createTool: (params: {
    provider: TProvider;
    config: OpenClawConfig | undefined;
    toolConfig: TConfig;
    runtimeMetadata: TRuntimeMetadata | undefined;
  }) => TDefinition | null;
}): { provider: TProvider; definition: TDefinition } | null {
  if (!params.resolveEnabled({ toolConfig: params.toolConfig, sandboxed: params.sandboxed })) {
    return null;
  }
  const providers = params.providers.filter(Boolean);
  if (providers.length === 0) {
    return null;
  }
  const autoProviderId = params.resolveAutoProviderId({
    config: params.config,
    toolConfig: params.toolConfig,
    providers,
  });
  const providerId =
    params.providerId ?? params.runtimeMetadata?.selectedProvider ?? autoProviderId;
  if (!providerId) {
    return null;
  }
  const provider =
    providers.find((entry) => entry.id === providerId) ??
    providers.find(
      (entry) =>
        entry.id ===
        params.resolveFallbackProviderId?.({
          config: params.config,
          toolConfig: params.toolConfig,
          providers,
          providerId,
        }),
    );
  if (!provider) {
    return null;
  }
  const definition = params.createTool({
    provider,
    config: params.config,
    toolConfig: params.toolConfig,
    runtimeMetadata: params.runtimeMetadata,
  });
  if (!definition) {
    return null;
  }
  return { provider, definition };
}
