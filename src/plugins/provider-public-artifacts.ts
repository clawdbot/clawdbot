import { normalizeProviderId } from "../agents/provider-id.js";
import type { ModelProviderConfig } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadBundledPluginPublicArtifactModuleSync } from "./public-surface-loader.js";
import type {
  ProviderApplyConfigDefaultsContext,
  ProviderNormalizeConfigContext,
  ProviderResolveConfigApiKeyContext,
} from "./types.js";

const PROVIDER_POLICY_ARTIFACT_CANDIDATES = ["provider-policy-api.js"] as const;

export type BundledProviderPolicySurface = {
  normalizeConfig?: (ctx: ProviderNormalizeConfigContext) => ModelProviderConfig | null | undefined;
  applyConfigDefaults?: (
    ctx: ProviderApplyConfigDefaultsContext,
  ) => OpenClawConfig | null | undefined;
  resolveConfigApiKey?: (ctx: ProviderResolveConfigApiKeyContext) => string | null | undefined;
};

const bundledProviderPolicySurfaceCache = new Map<string, BundledProviderPolicySurface | null>();

function hasProviderPolicyHook(
  mod: Record<string, unknown>,
): mod is Record<string, unknown> & BundledProviderPolicySurface {
  return (
    typeof mod.normalizeConfig === "function" ||
    typeof mod.applyConfigDefaults === "function" ||
    typeof mod.resolveConfigApiKey === "function"
  );
}

function tryLoadBundledProviderPolicySurface(
  pluginId: string,
): BundledProviderPolicySurface | null {
  for (const artifactBasename of PROVIDER_POLICY_ARTIFACT_CANDIDATES) {
    try {
      const mod = loadBundledPluginPublicArtifactModuleSync<Record<string, unknown>>({
        dirName: pluginId,
        artifactBasename,
      });
      if (hasProviderPolicyHook(mod)) {
        return mod;
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Unable to resolve bundled plugin public surface ")
      ) {
        continue;
      }
      throw error;
    }
  }
  return null;
}

export function clearBundledProviderPolicySurfaceCache(): void {
  bundledProviderPolicySurfaceCache.clear();
}

export function resolveBundledProviderPolicySurface(
  providerId: string,
): BundledProviderPolicySurface | null {
  const normalizedProviderId = normalizeProviderId(providerId);
  if (!normalizedProviderId) {
    return null;
  }
  if (bundledProviderPolicySurfaceCache.has(normalizedProviderId)) {
    return bundledProviderPolicySurfaceCache.get(normalizedProviderId) ?? null;
  }

  const surface = tryLoadBundledProviderPolicySurface(normalizedProviderId);
  if (surface) {
    bundledProviderPolicySurfaceCache.set(normalizedProviderId, surface);
    return surface;
  }

  bundledProviderPolicySurfaceCache.set(normalizedProviderId, null);
  return null;
}
