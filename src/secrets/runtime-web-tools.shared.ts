/** Shared helpers for web-tool secret metadata resolution. */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSecretInputRef } from "../config/types.secrets.js";
import { createLazyRuntimeNamedExport } from "../shared/lazy-runtime.js";
import { setPathExistingStrict } from "./path-utils.js";
import type {
  ResolverContext,
  SecretDefaults,
  SecretResolverWarningCode,
} from "./runtime-shared.js";
import { pushInactiveSurfaceWarning, pushWarning } from "./runtime-shared.js";
import type { RuntimeWebDiagnostic, RuntimeWebDiagnosticCode } from "./runtime-web-tools.types.js";
export { isRecord } from "./shared.js";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "./shared.js";

const loadResolveManifestContractOwnerPluginId = createLazyRuntimeNamedExport(
  () => import("./runtime-web-tools-manifest.runtime.js"),
  "resolveManifestContractOwnerPluginId",
);

type RuntimeWebWarningCode = Extract<RuntimeWebDiagnosticCode, SecretResolverWarningCode>;
/**
 * Result of resolving one provider credential from config, SecretRef, env, or fallback.
 */
export type SecretResolutionResult<TSource extends string> = {
  value?: string;
  source: TSource;
  secretRefConfigured: boolean;
  unresolvedRefReason?: string;
  fallbackEnvVar?: string;
  fallbackUsedAfterRefFailure: boolean;
};

/**
 * Metadata fields shared by runtime web search and fetch provider selection.
 */
export type RuntimeWebProviderMetadataBase<TSource extends string> = {
  providerConfigured?: string;
  providerSource: "configured" | "auto-detect" | "none";
  selectedProvider?: string;
  selectedProviderKeySource?: TSource;
  diagnostics: RuntimeWebDiagnostic[];
};

/**
 * Parameters shared by web search/fetch provider selection after provider surface discovery.
 */
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
  /** Allow keyless providers to be selected when no provider is explicitly configured. */
  allowKeylessAutoSelect: boolean;
  /** Defer keyless providers until credential-bearing auto-detect candidates are exhausted. */
  deferKeylessFallback: boolean;
  fallbackUsedCode: RuntimeWebWarningCode;
  noFallbackCode: RuntimeWebWarningCode;
  autoDetectSelectedCode: RuntimeWebWarningCode;
  /** Reads the primary credential location for a provider from source config. */
  readConfiguredCredential: (params: {
    provider: TProvider;
    config: OpenClawConfig;
    toolConfig: TToolConfig;
  }) => unknown;
  readConfiguredCredentialFallback?: (params: {
    provider: TProvider;
    config: OpenClawConfig;
    toolConfig: TToolConfig;
  }) => { path: string; value: unknown } | undefined;
  /** Resolves inline/env/SecretRef credentials and reports the winning source. */
  resolveSecretInput: (params: {
    value: unknown;
    path: string;
    envVars: string[];
  }) => Promise<SecretResolutionResult<TSource>>;
  /** Writes the selected credential into the resolved runtime config snapshot. */
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

/**
 * Ensures a nested config object exists and returns it for mutation.
 */
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

function normalizeKnownProvider(
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

/**
 * Returns whether a configured value or sibling ref field contains a SecretRef.
 */
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

function getProviderEnvVars(provider: object): string[] {
  return "envVars" in provider && Array.isArray(provider.envVars) ? provider.envVars : [];
}

function setResolvedCredentialPath(params: {
  resolvedConfig: OpenClawConfig;
  path: string;
  value: string;
}): void {
  const pathSegments = params.path
    .split(".")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (pathSegments.length === 0) {
    return;
  }
  try {
    setPathExistingStrict(
      params.resolvedConfig as Record<string, unknown>,
      pathSegments,
      params.value,
    );
  } catch {
    // Env-only provider defaults may not have a config path to mirror.
  }
}

/**
 * Provider set plus effective config state for one runtime web tool surface.
 */
export type RuntimeWebProviderSurface<TProvider extends { id: string }> = {
  providers: TProvider[];
  configuredProvider?: string;
  enabled: boolean;
  hasConfiguredSurface: boolean;
};

/**
 * Parameters for resolving configured/available providers before credential selection.
 */
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
  /** Bundled plugin id already known from caller context, avoiding duplicate manifest lookup. */
  configuredBundledPluginIdHint?: string;
  resolveProviders: (params: { configuredBundledPluginId?: string }) => Promise<TProvider[]>;
  sortProviders: (providers: TProvider[]) => TProvider[];
  readConfiguredCredential: (params: {
    provider: TProvider;
    config: OpenClawConfig;
    toolConfig: TToolConfig;
  }) => unknown;
  readConfiguredCredentialFallback?: (params: {
    provider: TProvider;
    config: OpenClawConfig;
    toolConfig: TToolConfig;
  }) => { path: string; value: unknown } | undefined;
  ignoreKeylessProvidersForConfiguredSurface?: boolean;
  emptyProvidersWhenSurfaceMissing?: boolean;
  normalizeConfiguredProviderAgainstActiveProviders?: boolean;
};

/**
 * Resolves available providers, configured provider validity, and whether the surface is active.
 */
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
  if (
    params.rawProvider &&
    !configuredBundledPluginId &&
    !allProviders.some((provider) => provider.id === params.rawProvider)
  ) {
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
        }) !== undefined ||
        params.readConfiguredCredentialFallback?.({
          provider,
          config: params.sourceConfig,
          toolConfig: params.toolConfig,
        })?.value !== undefined
      );
    });
  const providers =
    hasConfiguredSurface || !params.emptyProvidersWhenSurfaceMissing ? allProviders : [];
  const configuredProvider = normalizeKnownProvider(
    params.rawProvider,
    params.normalizeConfiguredProviderAgainstActiveProviders ? providers : allProviders,
  );
  const invalidConfiguredProvider =
    params.normalizeConfiguredProviderAgainstActiveProviders === true &&
    Boolean(params.rawProvider) &&
    !configuredProvider;

  if (params.rawProvider && !configuredProvider) {
    const diagnostic: RuntimeWebDiagnostic = {
      code: params.invalidAutoDetectCode,
      message: invalidConfiguredProvider
        ? `${params.providerPath} is "${params.rawProvider}". No provider will be selected.`
        : `${params.providerPath} is "${params.rawProvider}". Falling back to auto-detect precedence.`,
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
      hasConfiguredSurface &&
      !invalidConfiguredProvider &&
      (!isRecord(params.toolConfig) || params.toolConfig.enabled !== false),
    hasConfiguredSurface,
  };
}

/**
 * Selects a configured or auto-detected provider and materializes its resolved credential.
 */
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
      const isKeyless = provider.requiresCredential === false;
      if (isKeyless) {
        if (!params.configuredProvider && !params.allowKeylessAutoSelect) {
          continue;
        }
        if (params.deferKeylessFallback && !params.configuredProvider) {
          keylessFallbackProvider ||= provider;
          continue;
        }
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
        envVars: getProviderEnvVars(provider),
      });
      let selectedCandidatePath = path;
      let selectedCandidateResolution = resolution;

      if (!resolution.value && !resolution.secretRefConfigured) {
        const fallback = params.readConfiguredCredentialFallback?.({
          provider,
          config: params.sourceConfig,
          toolConfig: params.toolConfig,
        });
        if (fallback?.value !== undefined) {
          selectedCandidatePath = fallback.path;
          selectedCandidateResolution = await params.resolveSecretInput({
            value: fallback.value,
            path: fallback.path,
            envVars: getProviderEnvVars(provider),
          });
        }
      } else if (resolution.source === "env" && !resolution.secretRefConfigured) {
        const fallback = params.readConfiguredCredentialFallback?.({
          provider,
          config: params.sourceConfig,
          toolConfig: params.toolConfig,
        });
        if (
          fallback?.value !== undefined &&
          params.hasConfiguredSecretRef(fallback.value, params.defaults)
        ) {
          const fallbackResolution = await params.resolveSecretInput({
            value: fallback.value,
            path: fallback.path,
            envVars: getProviderEnvVars(provider),
          });
          if (fallbackResolution.source === "secretRef" && fallbackResolution.value) {
            // Preserve transcript/config bytes for env-selected providers while materializing refs.
            setResolvedCredentialPath({
              resolvedConfig: params.resolvedConfig,
              path: fallback.path,
              value: fallbackResolution.value,
            });
          }
        }
      }

      if (
        selectedCandidateResolution.secretRefConfigured &&
        selectedCandidateResolution.fallbackUsedAfterRefFailure
      ) {
        const diagnostic: RuntimeWebDiagnostic = {
          code: params.fallbackUsedCode,
          message:
            `${selectedCandidatePath} SecretRef could not be resolved; using ${selectedCandidateResolution.fallbackEnvVar ?? "env fallback"}. ` +
            (selectedCandidateResolution.unresolvedRefReason ?? "").trim(),
          path: selectedCandidatePath,
        };
        params.diagnostics.push(diagnostic);
        params.metadata.diagnostics.push(diagnostic);
        pushWarning(params.context, {
          code: params.fallbackUsedCode,
          path: selectedCandidatePath,
          message: diagnostic.message,
        });
      }

      if (
        selectedCandidateResolution.secretRefConfigured &&
        !selectedCandidateResolution.value &&
        selectedCandidateResolution.unresolvedRefReason
      ) {
        unresolvedWithoutFallback.push({
          provider: provider.id,
          path: selectedCandidatePath,
          reason: selectedCandidateResolution.unresolvedRefReason,
        });
      }

      if (
        isKeyless &&
        selectedCandidateResolution.secretRefConfigured &&
        !selectedCandidateResolution.value
      ) {
        continue;
      }

      if (isKeyless && !params.configuredProvider && !selectedCandidateResolution.value) {
        continue;
      }

      if (params.configuredProvider) {
        selectedProvider = provider.id;
        selectedResolution = selectedCandidateResolution;
        if (selectedCandidateResolution.value) {
          setResolvedCredentialPath({
            resolvedConfig: params.resolvedConfig,
            path: selectedCandidatePath,
            value: selectedCandidateResolution.value,
          });
          params.setResolvedCredential({
            resolvedConfig: params.resolvedConfig,
            provider,
            value: selectedCandidateResolution.value,
          });
        }
        break;
      }

      if (isKeyless) {
        selectedProvider = provider.id;
        selectedResolution = selectedCandidateResolution;
        if (selectedCandidateResolution.value) {
          setResolvedCredentialPath({
            resolvedConfig: params.resolvedConfig,
            path: selectedCandidatePath,
            value: selectedCandidateResolution.value,
          });
          params.setResolvedCredential({
            resolvedConfig: params.resolvedConfig,
            provider,
            value: selectedCandidateResolution.value,
          });
        }
        break;
      }

      if (selectedCandidateResolution.value) {
        selectedProvider = provider.id;
        selectedResolution = selectedCandidateResolution;
        setResolvedCredentialPath({
          resolvedConfig: params.resolvedConfig,
          path: selectedCandidatePath,
          value: selectedCandidateResolution.value,
        });
        params.setResolvedCredential({
          resolvedConfig: params.resolvedConfig,
          provider,
          value: selectedCandidateResolution.value,
        });
        break;
      }
    }

    if (!selectedProvider && keylessFallbackProvider && params.allowKeylessAutoSelect) {
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
        failUnresolvedNoFallback(
          expectDefined(unresolvedWithoutFallback[0], "unresolved without fallback entry at 0"),
        );
      }

      if (selectedProvider) {
        const selectedProviderEntry = params.providers.find(
          (entry) => entry.id === selectedProvider,
        );
        const selectedDetails =
          selectedProviderEntry?.requiresCredential === false
            ? `${params.scopePath} auto-detected keyless provider "${selectedProvider}".`
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
