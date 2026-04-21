import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSecretInputRef } from "../config/types.secrets.js";
import { createLazyRuntimeNamedExport } from "../shared/lazy-runtime.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import type {
  ResolverContext,
  SecretDefaults,
  SecretResolverWarningCode,
} from "./runtime-shared.js";
import { pushInactiveSurfaceWarning, pushWarning } from "./runtime-shared.js";
import type { RuntimeWebDiagnostic, RuntimeWebDiagnosticCode } from "./runtime-web-tools.types.js";
export { isRecord } from "./shared.js";
import { isRecord } from "./shared.js";

const loadResolveManifestContractOwnerPluginId = createLazyRuntimeNamedExport(
  () => import("./runtime-web-tools-manifest.runtime.js"),
  "resolveManifestContractOwnerPluginId",
);

type RuntimeWebWarningCode = Extract<RuntimeWebDiagnosticCode, SecretResolverWarningCode>;
export type SecretResolutionResult<TSource extends string> = {
  value?: string;
  source: TSource;
  secretRefConfigured: boolean;
  unresolvedRefReason?: string;
  fallbackEnvVar?: string;
  fallbackUsedAfterRefFailure: boolean;
};

export type RuntimeWebProviderMetadataBase<TSource extends string> = {
  providerConfigured?: string;
  providerSource: "configured" | "auto-detect" | "none";
  selectedProvider?: string;
  selectedProviderKeySource?: TSource;
  diagnostics: RuntimeWebDiagnostic[];
};

export type RuntimeWebProviderSelectionParams<
  TProvider extends {
    id: string;
    requiresCredential?: boolean;
  },
  TToolConfig extends Record<string, unknown> | undefined,
  TSource extends string,
  TMetadata extends RuntimeWebProviderMetadataBase<TSource>,
> = {
  scopePath: string;
  toolConfig: TToolConfig;
  enabled: boolean;
  providers: TProvider[];
  configuredProvider?: string;
  metadata: TMetadata;
  diagnostics: RuntimeWebDiagnostic[];
  sourceConfig: OpenClawConfig;
  resolvedConfig: OpenClawConfig;
  context: ResolverContext;
  defaults: SecretDefaults | undefined;
  deferKeylessFallback: boolean;
  fallbackUsedCode: RuntimeWebWarningCode;
  noFallbackCode: RuntimeWebWarningCode;
  autoDetectSelectedCode: RuntimeWebWarningCode;
  readConfiguredCredential: (params: {
    provider: TProvider;
    config: OpenClawConfig;
    toolConfig: TToolConfig;
  }) => unknown;
  resolveSecretInput: (params: {
    value: unknown;
    path: string;
    envVars: string[];
  }) => Promise<SecretResolutionResult<TSource>>;
  setResolvedCredential: (params: {
    resolvedConfig: OpenClawConfig;
    provider: TProvider;
    value: string;
  }) => void;
  inactivePathsForProvider: (provider: TProvider) => string[];
  hasConfiguredSecretRef: (value: unknown, defaults: SecretDefaults | undefined) => boolean;
  mergeRuntimeMetadata?: (params: {
    provider: TProvider;
    metadata: TMetadata;
    toolConfig: TToolConfig;
    selectedResolution?: SecretResolutionResult<TSource>;
  }) => Promise<void>;
};

function pushInactiveProviderCredentialWarnings<
  TProvider extends { id: string; requiresCredential?: boolean },
  TToolConfig extends Record<string, unknown> | undefined,
  TSource extends string,
  TMetadata extends RuntimeWebProviderMetadataBase<TSource>,
>(params: {
  selection: RuntimeWebProviderSelectionParams<TProvider, TToolConfig, TSource, TMetadata>;
  skipProviderId?: string;
  details: string;
}): void {
  for (const provider of params.selection.providers) {
    if (provider.id === params.skipProviderId) {
      continue;
    }
    const value = params.selection.readConfiguredCredential({
      provider,
      config: params.selection.sourceConfig,
      toolConfig: params.selection.toolConfig,
    });
    if (!params.selection.hasConfiguredSecretRef(value, params.selection.defaults)) {
      continue;
    }
    for (const path of params.selection.inactivePathsForProvider(provider)) {
      pushInactiveSurfaceWarning({
        context: params.selection.context,
        path,
        details: params.details,
      });
    }
  }
}

export function ensureObject(
  target: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const current = target[key];
  if (isRecord(current)) {
    return current;
  }
  const next: Record<string, unknown> = {};
  target[key] = next;
  return next;
}

export function normalizeKnownProvider(
  value: unknown,
  providers: Array<{ id: string }>,
): string | undefined {
  const normalized = normalizeOptionalLowercaseString(value);
  if (!normalized) {
    return undefined;
  }
  if (providers.some((provider) => provider.id === normalized)) {
    return normalized;
  }
  return undefined;
}

export function hasConfiguredSecretRef(
  value: unknown,
  defaults: SecretDefaults | undefined,
): boolean {
  return Boolean(
    resolveSecretInputRef({
      value,
      defaults,
    }).ref,
  );
}

export type RuntimeWebProviderSurface<TProvider extends { id: string }> = {
  providers: TProvider[];
  configuredProvider?: string;
  enabled: boolean;
  hasConfiguredSurface: boolean;
};

export type ResolveRuntimeWebProviderSurfaceParams<
  TProvider extends {
    id: string;
    requiresCredential?: boolean;
  },
  TToolConfig extends Record<string, unknown> | undefined,
> = {
  contract: "webSearchProviders" | "webFetchProviders";
  rawProvider: string;
  providerPath: string;
  toolConfig: TToolConfig;
  diagnostics: RuntimeWebDiagnostic[];
  metadataDiagnostics: RuntimeWebDiagnostic[];
  invalidAutoDetectCode: RuntimeWebWarningCode;
  sourceConfig: OpenClawConfig;
  context: ResolverContext;
  configuredBundledPluginIdHint?: string;
  resolveProviders: (params: { configuredBundledPluginId?: string }) => Promise<TProvider[]>;
  sortProviders: (providers: TProvider[]) => TProvider[];
  readConfiguredCredential: (params: {
    provider: TProvider;
    config: OpenClawConfig;
    toolConfig: TToolConfig;
  }) => unknown;
  ignoreKeylessProvidersForConfiguredSurface?: boolean;
  emptyProvidersWhenSurfaceMissing?: boolean;
  normalizeConfiguredProviderAgainstActiveProviders?: boolean;
};

export async function resolveRuntimeWebProviderSurface<
  TProvider extends {
    id: string;
    requiresCredential?: boolean;
  },
  TToolConfig extends Record<string, unknown> | undefined,
>(
  params: ResolveRuntimeWebProviderSurfaceParams<TProvider, TToolConfig>,
): Promise<RuntimeWebProviderSurface<TProvider>> {
  let configuredBundledPluginId = params.configuredBundledPluginIdHint;
  if (!configuredBundledPluginId && params.rawProvider) {
    const resolveManifestContractOwnerPluginId = await loadResolveManifestContractOwnerPluginId();
    configuredBundledPluginId = resolveManifestContractOwnerPluginId({
      contract: params.contract,
      value: params.rawProvider,
      origin: "bundled",
      config: params.sourceConfig,
      env: { ...process.env, ...params.context.env },
    });
  }
  let allProviders = params.sortProviders(
    await params.resolveProviders({
      configuredBundledPluginId,
    }),
  );
  if (
    params.rawProvider &&
    params.configuredBundledPluginIdHint &&
    configuredBundledPluginId &&
    !allProviders.some((provider) => provider.id === params.rawProvider)
  ) {
    configuredBundledPluginId = undefined;
  }
  if (params.rawProvider && !configuredBundledPluginId) {
    const resolveManifestContractOwnerPluginId = await loadResolveManifestContractOwnerPluginId();
    configuredBundledPluginId = resolveManifestContractOwnerPluginId({
      contract: params.contract,
      value: params.rawProvider,
      origin: "bundled",
      config: params.sourceConfig,
      env: { ...process.env, ...params.context.env },
    });
    allProviders = params.sortProviders(
      await params.resolveProviders({
        configuredBundledPluginId,
      }),
    );
  }
  const hasConfiguredSurface =
    Boolean(params.toolConfig) ||
    allProviders.some((provider) => {
      if (
        params.ignoreKeylessProvidersForConfiguredSurface &&
        provider.requiresCredential === false
      ) {
        return false;
      }
      return (
        params.readConfiguredCredential({
          provider,
          config: params.sourceConfig,
          toolConfig: params.toolConfig,
        }) !== undefined
      );
    });
  const providers =
    hasConfiguredSurface || !params.emptyProvidersWhenSurfaceMissing ? allProviders : [];
  const configuredProvider = normalizeKnownProvider(
    params.rawProvider,
    params.normalizeConfiguredProviderAgainstActiveProviders ? providers : allProviders,
  );

  if (params.rawProvider && !configuredProvider) {
    const diagnostic: RuntimeWebDiagnostic = {
      code: params.invalidAutoDetectCode,
      message: `${params.providerPath} is "${params.rawProvider}". Falling back to auto-detect precedence.`,
      path: params.providerPath,
    };
    params.diagnostics.push(diagnostic);
    params.metadataDiagnostics.push(diagnostic);
    pushWarning(params.context, {
      code: params.invalidAutoDetectCode,
      path: params.providerPath,
      message: diagnostic.message,
    });
  }

  return {
    providers,
    configuredProvider,
    enabled:
      hasConfiguredSurface && (!isRecord(params.toolConfig) || params.toolConfig.enabled !== false),
    hasConfiguredSurface,
  };
}

export async function resolveRuntimeWebProviderSelection<
  TProvider extends {
    id: string;
    requiresCredential?: boolean;
  },
  TToolConfig extends Record<string, unknown> | undefined,
  TSource extends string,
  TMetadata extends RuntimeWebProviderMetadataBase<TSource>,
>(
  params: RuntimeWebProviderSelectionParams<TProvider, TToolConfig, TSource, TMetadata>,
): Promise<void> {
  if (params.configuredProvider) {
    params.metadata.providerConfigured = params.configuredProvider;
    params.metadata.providerSource = "configured";
  }

  if (params.enabled) {
    const candidates = params.configuredProvider
      ? params.providers.filter((provider) => provider.id === params.configuredProvider)
      : params.providers;
    const unresolvedWithoutFallback: Array<{ provider: string; path: string; reason: string }> = [];

    let selectedProvider: string | undefined;
    let selectedResolution: SecretResolutionResult<TSource> | undefined;
    let keylessFallbackProvider: TProvider | undefined;

    for (const provider of candidates) {
      if (provider.requiresCredential === false) {
        if (params.deferKeylessFallback && !params.configuredProvider) {
          keylessFallbackProvider ||= provider;
          continue;
        }
        selectedProvider = provider.id;
        selectedResolution = {
          source: "missing" as TSource,
          secretRefConfigured: false,
          fallbackUsedAfterRefFailure: false,
        };
        break;
      }

      const path = params.inactivePathsForProvider(provider)[0] ?? "";
      const value = params.readConfiguredCredential({
        provider,
        config: params.sourceConfig,
        toolConfig: params.toolConfig,
      });
      const resolution = await params.resolveSecretInput({
        value,
        path,
        envVars: "envVars" in provider && Array.isArray(provider.envVars) ? provider.envVars : [],
      });

      if (resolution.secretRefConfigured && resolution.fallbackUsedAfterRefFailure) {
        const diagnostic: RuntimeWebDiagnostic = {
          code: params.fallbackUsedCode,
          message:
            `${path} SecretRef could not be resolved; using ${resolution.fallbackEnvVar ?? "env fallback"}. ` +
            (resolution.unresolvedRefReason ?? "").trim(),
          path,
        };
        params.diagnostics.push(diagnostic);
        params.metadata.diagnostics.push(diagnostic);
        pushWarning(params.context, {
          code: params.fallbackUsedCode,
          path,
          message: diagnostic.message,
        });
      }

      if (resolution.secretRefConfigured && !resolution.value && resolution.unresolvedRefReason) {
        unresolvedWithoutFallback.push({
          provider: provider.id,
          path,
          reason: resolution.unresolvedRefReason,
        });
      }

      if (params.configuredProvider) {
        selectedProvider = provider.id;
        selectedResolution = resolution;
        if (resolution.value) {
          params.setResolvedCredential({
            resolvedConfig: params.resolvedConfig,
            provider,
            value: resolution.value,
          });
        }
        break;
      }

      if (resolution.value) {
        selectedProvider = provider.id;
        selectedResolution = resolution;
        params.setResolvedCredential({
          resolvedConfig: params.resolvedConfig,
          provider,
          value: resolution.value,
        });
        break;
      }
    }

    if (!selectedProvider && keylessFallbackProvider) {
      selectedProvider = keylessFallbackProvider.id;
      selectedResolution = {
        source: "missing" as TSource,
        secretRefConfigured: false,
        fallbackUsedAfterRefFailure: false,
      };
    }

    const failUnresolvedNoFallback = (unresolved: { path: string; reason: string }) => {
      const diagnostic: RuntimeWebDiagnostic = {
        code: params.noFallbackCode,
        message: unresolved.reason,
        path: unresolved.path,
      };
      params.diagnostics.push(diagnostic);
      params.metadata.diagnostics.push(diagnostic);
      pushWarning(params.context, {
        code: params.noFallbackCode,
        path: unresolved.path,
        message: unresolved.reason,
      });
      throw new Error(`[${params.noFallbackCode}] ${unresolved.reason}`);
    };

    if (params.configuredProvider) {
      const unresolved = unresolvedWithoutFallback[0];
      if (unresolved) {
        failUnresolvedNoFallback(unresolved);
      }
    } else {
      if (!selectedProvider && unresolvedWithoutFallback.length > 0) {
        failUnresolvedNoFallback(unresolvedWithoutFallback[0]);
      }

      if (selectedProvider) {
        const selectedProviderEntry = params.providers.find(
          (entry) => entry.id === selectedProvider,
        );
        const selectedDetails =
          selectedProviderEntry?.requiresCredential === false
            ? `${params.scopePath} auto-detected keyless provider "${selectedProvider}" as the default fallback.`
            : `${params.scopePath} auto-detected provider "${selectedProvider}" from available credentials.`;
        const diagnostic: RuntimeWebDiagnostic = {
          code: params.autoDetectSelectedCode,
          message: selectedDetails,
          path: `${params.scopePath}.provider`,
        };
        params.diagnostics.push(diagnostic);
        params.metadata.diagnostics.push(diagnostic);
      }
    }

    if (selectedProvider) {
      params.metadata.selectedProvider = selectedProvider;
      params.metadata.selectedProviderKeySource = selectedResolution?.source;
      if (!params.configuredProvider) {
        params.metadata.providerSource = "auto-detect";
      }
      const provider = params.providers.find((entry) => entry.id === selectedProvider);
      if (provider && params.mergeRuntimeMetadata) {
        await params.mergeRuntimeMetadata({
          provider,
          metadata: params.metadata,
          toolConfig: params.toolConfig,
          selectedResolution,
        });
      }
    }
  }

  if (params.enabled && !params.configuredProvider && params.metadata.selectedProvider) {
    pushInactiveProviderCredentialWarnings({
      selection: params,
      skipProviderId: params.metadata.selectedProvider,
      details: `${params.scopePath} auto-detected provider is "${params.metadata.selectedProvider}".`,
    });
  } else if (params.toolConfig && !params.enabled) {
    pushInactiveProviderCredentialWarnings({
      selection: params,
      details: `${params.scopePath} is disabled.`,
    });
  }

  if (params.enabled && params.toolConfig && params.configuredProvider) {
    pushInactiveProviderCredentialWarnings({
      selection: params,
      skipProviderId: params.configuredProvider,
      details: `${params.scopePath}.provider is "${params.configuredProvider}".`,
    });
  }
}
