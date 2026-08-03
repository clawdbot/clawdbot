import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setPathExistingStrict } from "./path-utils.js";
import { digestRuntimeWebOwnerContract } from "./runtime-owner-contract.js";
import type {
  RuntimeWebProviderMetadataBase,
  RuntimeWebProviderSelectionParams,
  RuntimeWebUnavailableProvider,
} from "./runtime-web-tools-selection.types.js";

/** Writes a resolved credential value to its original config path. */
export function setResolvedCredentialPath(params: {
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

type ProviderBase = { id: string; requiresCredential?: boolean };

function getProviderEnvVars(provider: object): string[] {
  return "envVars" in provider && Array.isArray(provider.envVars) ? provider.envVars : [];
}

/**
 * Resolves credentials for providers that are not selected for generic web
 * search/fetch but have enabled standalone tools that share the same credential.
 */
export async function resolveStandaloneProviderCredentials<
  TProvider extends ProviderBase,
  TToolConfig extends Record<string, unknown> | undefined,
  TSource extends string,
  TMetadata extends RuntimeWebProviderMetadataBase<TSource>,
>(params: {
  selection: RuntimeWebProviderSelectionParams<TProvider, TToolConfig, TSource, TMetadata>;
  selectedProvider?: string;
  unavailableProviders: RuntimeWebUnavailableProvider[];
}): Promise<void> {
  const { selection, selectedProvider, unavailableProviders } = params;
  if (!selection.standaloneToolProviderIds) {
    return;
  }
  for (const provider of selection.providers) {
    if (provider.id === selectedProvider || !selection.standaloneToolProviderIds.has(provider.id)) {
      continue;
    }
    const value = selection.readConfiguredCredential({
      provider,
      config: selection.sourceConfig,
      toolConfig: selection.toolConfig,
    });
    if (!selection.hasConfiguredSecretRef(value, selection.defaults)) {
      continue;
    }
    const paths = selection.inactivePathsForProvider(provider);
    if (paths.length === 0) {
      continue;
    }
    const path = paths[0] ?? "";
    const contractDigest = digestRuntimeWebOwnerContract({ ...selection, providerId: provider.id });
    const resolution = await selection.resolveSecretInput({
      providerId: provider.id,
      value,
      path,
      envVars: getProviderEnvVars(provider),
      contractDigest,
    });
    if (resolution.value) {
      for (const inactivePath of paths) {
        setResolvedCredentialPath({
          resolvedConfig: selection.resolvedConfig,
          path: inactivePath,
          value: resolution.value,
        });
      }
      selection.setResolvedCredential({
        resolvedConfig: selection.resolvedConfig,
        provider,
        value: resolution.value,
      });
    } else if (resolution.secretRefConfigured && resolution.unresolvedRefReason) {
      const ref = resolution.secretRef;
      const refKey = resolution.secretRefKey;
      if (ref && refKey) {
        for (const inactivePath of paths) {
          unavailableProviders.push({
            providerId: provider.id,
            path: inactivePath,
            ref,
            refKey,
            reason: resolution.unresolvedRefReason,
            contractDigest,
            restoreResolvedValue: (resolvedValue) =>
              selection.setResolvedCredential({
                resolvedConfig: selection.resolvedConfig,
                provider,
                value: resolvedValue,
              }),
          });
        }
      }
    }
  }
}

/**
 * Resolves credentials for enabled standalone-tool plugins whose providers were
 * not loaded into the primary selection surface (e.g., because the surface was
 * narrowed to the configured provider). Each missing plugin's providers are
 * loaded on demand and resolved using the same credential hooks.
 */
export async function resolveMissingStandaloneProviderCredentials<
  TProvider extends ProviderBase,
  TToolConfig extends Record<string, unknown> | undefined,
  TSource extends string,
  TMetadata extends RuntimeWebProviderMetadataBase<TSource>,
>(params: {
  selection: RuntimeWebProviderSelectionParams<TProvider, TToolConfig, TSource, TMetadata>;
  configuredProvider?: string;
  missingStandalonePluginIds: ReadonlySet<string>;
  resolveProviders: (pluginId: string) => Promise<TProvider[]>;
  unavailableProviders: RuntimeWebUnavailableProvider[];
}): Promise<void> {
  const {
    selection,
    configuredProvider,
    missingStandalonePluginIds,
    resolveProviders,
    unavailableProviders,
  } = params;
  if (missingStandalonePluginIds.size === 0) {
    return;
  }
  for (const pluginId of missingStandalonePluginIds) {
    const providers = await resolveProviders(pluginId);
    if (providers.length === 0) {
      continue;
    }
    const standaloneToolProviderIds = new Set(providers.map((provider) => provider.id));
    await resolveStandaloneProviderCredentials({
      selection: { ...selection, providers, standaloneToolProviderIds },
      selectedProvider: configuredProvider,
      unavailableProviders,
    });
  }
}
