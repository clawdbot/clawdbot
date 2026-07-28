/** Lightweight direct loader for bundled provider policy public artifacts. */
import type { ModelProviderConfig } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  ProviderModelRouteResolution,
  ProviderNormalizeModelCatalogIdContext,
  ProviderResolveModelRoutesContext,
} from "../plugin-sdk/provider-model-types.js";
import { resolveBundledPluginsDir } from "./bundled-dir.js";
import type {
  ProviderApplyConfigDefaultsContext,
  ProviderNormalizeConfigContext,
  ProviderResolveConfigApiKeyContext,
} from "./provider-config-context.types.js";
import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
} from "./provider-thinking.types.js";
import {
  loadBundledPluginPublicArtifactModuleSync,
  loadPluginPublicArtifactModuleSync,
} from "./public-surface-loader.js";

const PROVIDER_POLICY_ARTIFACT_CANDIDATES = ["provider-policy-api.js"] as const;
const providerPolicySurfaceByPluginId = new Map<string, BundledProviderPolicySurface | null>();

/** Provider policy hooks loaded from bundled plugin public artifacts. */
export type BundledProviderPolicySurface = {
  normalizeConfig?: (ctx: ProviderNormalizeConfigContext) => ModelProviderConfig | null | undefined;
  applyConfigDefaults?: (
    ctx: ProviderApplyConfigDefaultsContext,
  ) => OpenClawConfig | null | undefined;
  resolveConfigApiKey?: (ctx: ProviderResolveConfigApiKeyContext) => string | null | undefined;
  resolveThinkingProfile?: (
    ctx: ProviderDefaultThinkingPolicyContext,
  ) => ProviderThinkingProfile | null | undefined;
  resolveModelRoutes?: (
    ctx: ProviderResolveModelRoutesContext,
  ) => ProviderModelRouteResolution | null | undefined;
  normalizeModelCatalogId?: (
    ctx: ProviderNormalizeModelCatalogIdContext,
  ) => string | null | undefined;
};

function hasProviderPolicyHook(
  mod: Record<string, unknown>,
): mod is Record<string, unknown> & BundledProviderPolicySurface {
  return (
    typeof mod.normalizeConfig === "function" ||
    typeof mod.applyConfigDefaults === "function" ||
    typeof mod.resolveConfigApiKey === "function" ||
    typeof mod.resolveThinkingProfile === "function" ||
    typeof mod.resolveModelRoutes === "function" ||
    typeof mod.normalizeModelCatalogId === "function"
  );
}

function resolveCachedProviderPolicySurface(params: {
  cacheKey: string;
  loadModule: (artifactBasename: string) => Record<string, unknown>;
  missingSurfacePrefix: string;
}): BundledProviderPolicySurface | null {
  const cached = providerPolicySurfaceByPluginId.get(params.cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  for (const artifactBasename of PROVIDER_POLICY_ARTIFACT_CANDIDATES) {
    try {
      const mod = params.loadModule(artifactBasename);
      if (hasProviderPolicyHook(mod)) {
        providerPolicySurfaceByPluginId.set(params.cacheKey, mod);
        return mod;
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(params.missingSurfacePrefix)) {
        continue;
      }
      throw error;
    }
  }
  providerPolicySurfaceByPluginId.set(params.cacheKey, null);
  return null;
}

/** Loads policy hooks directly by canonical bundled plugin id. */
export function resolveDirectBundledProviderPolicySurface(
  pluginId: string,
): BundledProviderPolicySurface | null {
  return resolveCachedProviderPolicySurface({
    cacheKey: `${resolveBundledPluginsDir() ?? ""}\0${pluginId}`,
    loadModule: (artifactBasename) =>
      loadBundledPluginPublicArtifactModuleSync<Record<string, unknown>>({
        dirName: pluginId,
        artifactBasename,
      }),
    missingSurfacePrefix: "Unable to resolve bundled plugin public surface ",
  });
}

/** Loads policy hooks from a host-verified official external plugin install. */
export function resolveTrustedExternalProviderPolicySurface(params: {
  pluginId: string;
  pluginRoot: string;
  trustedOfficialInstall?: boolean;
}): BundledProviderPolicySurface | null {
  if (params.trustedOfficialInstall !== true) {
    return null;
  }
  return resolveCachedProviderPolicySurface({
    cacheKey: `${params.pluginRoot}\0${params.pluginId}`,
    loadModule: (artifactBasename) =>
      loadPluginPublicArtifactModuleSync<Record<string, unknown>>({
        pluginRoot: params.pluginRoot,
        artifactBasename,
      }),
    missingSurfacePrefix: "Unable to resolve plugin public surface ",
  });
}
