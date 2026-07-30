// Shared web provider config, credential, and definition resolution.
import { coerceSecretRef, isLegacySecretRefEnvMarker } from "../config/types.secrets.js";

type WebProviderConfigSource = {
  tools?: {
    web?: {
      search?: unknown;
      fetch?: unknown;
    };
  };
};

type RuntimeWebProviderMetadata = {
  providerConfigured?: string;
  selectedProvider?: string;
};

type ProviderWithCredential = {
  envVars: string[];
  authProviderId?: string;
  requiresCredential?: boolean;
};

type WebContentProcessEnv = Record<string, string | undefined>;

function normalizeSecretInputString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeSecretInput(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const collapsed = value.replace(/[\r\n\u2028\u2029]+/g, "");
  let latin1Only = "";
  for (const char of collapsed) {
    const codePoint = char.codePointAt(0);
    const isControl =
      typeof codePoint === "number" &&
      ((codePoint >= 0x00 && codePoint <= 0x1f) ||
        codePoint === 0x7f ||
        (codePoint >= 0x80 && codePoint <= 0x9f));
    if (typeof codePoint === "number" && codePoint <= 0xff && !isControl) {
      latin1Only += char;
    }
  }
  return latin1Only.trim();
}

export function resolveWebProviderConfig(
  cfg: WebProviderConfigSource | undefined,
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
  processEnv: WebContentProcessEnv = process.env,
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
  TConfigSource extends WebProviderConfigSource,
  TConfig extends Record<string, unknown> | undefined,
>(params: {
  provider: TProvider;
  config: TConfigSource | undefined;
  toolConfig: TConfig;
  resolveRawValue: (params: {
    provider: TProvider;
    config: TConfigSource | undefined;
    toolConfig: TConfig;
  }) => unknown;
  resolveFallbackRawValue?: (params: {
    provider: TProvider;
    config: TConfigSource | undefined;
    toolConfig: TConfig;
  }) => unknown;
  resolveEnvValue: (params: {
    provider: TProvider;
    configuredEnvVarId?: string;
  }) => string | undefined;
  resolveProviderAuthValue?: (providerId: string) => boolean;
}): boolean {
  if (!providerRequiresCredential(params.provider)) {
    return true;
  }
  const rawValue = params.resolveRawValue({
    provider: params.provider,
    config: params.config,
    toolConfig: params.toolConfig,
  });
  if (isLegacySecretRefEnvMarker(rawValue)) {
    return false;
  }
  const configuredRef = coerceSecretRef(rawValue);
  if (configuredRef && configuredRef.source !== "env") {
    return true;
  }
  const fromConfig = configuredRef
    ? ""
    : normalizeSecretInput(normalizeSecretInputString(rawValue));
  if (fromConfig) {
    return true;
  }
  if (
    params.provider.authProviderId &&
    params.resolveProviderAuthValue?.(params.provider.authProviderId)
  ) {
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
  if (isLegacySecretRefEnvMarker(fallbackRawValue)) {
    return false;
  }
  const fallbackRef = coerceSecretRef(fallbackRawValue);
  if (fallbackRef && fallbackRef.source !== "env") {
    return true;
  }
  const fallbackConfig = fallbackRef
    ? ""
    : normalizeSecretInput(normalizeSecretInputString(fallbackRawValue));
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
  TConfigSource extends WebProviderConfigSource,
  TConfig extends Record<string, unknown> | undefined,
  TRuntimeMetadata extends RuntimeWebProviderMetadata,
  TDefinition,
>(params: {
  config: TConfigSource | undefined;
  toolConfig: TConfig;
  runtimeMetadata: TRuntimeMetadata | undefined;
  sandboxed?: boolean;
  providerId?: string;
  providers: TProvider[];
  resolveEnabled: (params: { toolConfig: TConfig; sandboxed?: boolean }) => boolean;
  resolveAutoProviderId: (params: {
    config: TConfigSource | undefined;
    toolConfig: TConfig;
    providers: TProvider[];
  }) => string;
  resolveFallbackProviderId?: (params: {
    config: TConfigSource | undefined;
    toolConfig: TConfig;
    providers: TProvider[];
    providerId: string;
  }) => string | undefined;
  createTool: (params: {
    provider: TProvider;
    config: TConfigSource | undefined;
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
