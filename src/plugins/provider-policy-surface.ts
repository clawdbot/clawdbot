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
import type { ProviderRuntimeModel } from "./provider-runtime-model.types.js";
import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
} from "./provider-thinking.types.js";
import {
  loadBundledPluginPublicArtifactModuleSync,
  loadPluginPublicArtifactModuleSync,
} from "./public-surface-loader.js";

const PROVIDER_POLICY_ARTIFACT_CANDIDATES = ["provider-policy-api.js"] as const;

type ProviderProjectConfiguredModelRowContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  provider: string;
  modelId: string;
  model: ProviderRuntimeModel;
};

/** Provider policy hooks supported by bundled and trusted official plugins. */
export type ProviderPolicySurface = {
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

/** Provider policy hooks loaded only from bundled plugin public artifacts. */
export type BundledProviderPolicySurface = ProviderPolicySurface & {
  projectConfiguredModelRow?: (
    ctx: ProviderProjectConfiguredModelRowContext,
  ) => ProviderRuntimeModel | null | undefined;
};

const bundledProviderPolicySurfaceByPluginId = new Map<
  string,
  BundledProviderPolicySurface | null
>();
const externalProviderPolicySurfaceByPluginId = new Map<string, ProviderPolicySurface | null>();

const PROVIDER_POLICY_HOOK_KEYS = [
  "normalizeConfig",
  "applyConfigDefaults",
  "resolveConfigApiKey",
  "resolveThinkingProfile",
  "resolveModelRoutes",
  "normalizeModelCatalogId",
] as const satisfies readonly (keyof ProviderPolicySurface)[];

function extractProviderPolicySurface(mod: Record<string, unknown>): ProviderPolicySurface | null {
  const surface: ProviderPolicySurface = {};
  for (const key of PROVIDER_POLICY_HOOK_KEYS) {
    const hook = mod[key];
    if (typeof hook === "function") {
      Object.assign(surface, { [key]: hook });
    }
  }
  return Object.keys(surface).length > 0 ? surface : null;
}

function extractBundledProviderPolicySurface(
  mod: Record<string, unknown>,
): BundledProviderPolicySurface | null {
  const surface: BundledProviderPolicySurface = extractProviderPolicySurface(mod) ?? {};
  if (typeof mod.projectConfiguredModelRow === "function") {
    surface.projectConfiguredModelRow =
      mod.projectConfiguredModelRow as BundledProviderPolicySurface["projectConfiguredModelRow"];
  }
  return Object.keys(surface).length > 0 ? surface : null;
}

function resolveCachedProviderPolicySurface<T extends ProviderPolicySurface>(params: {
  cache: Map<string, T | null>;
  cacheKey: string;
  loadModule: (artifactBasename: string) => Record<string, unknown>;
  missingSurfacePrefix: string;
  extractSurface: (mod: Record<string, unknown>) => T | null;
}): T | null {
  const cached = params.cache.get(params.cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  for (const artifactBasename of PROVIDER_POLICY_ARTIFACT_CANDIDATES) {
    try {
      const mod = params.loadModule(artifactBasename);
      const surface = params.extractSurface(mod);
      if (surface) {
        params.cache.set(params.cacheKey, surface);
        return surface;
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(params.missingSurfacePrefix)) {
        continue;
      }
      throw error;
    }
  }
  params.cache.set(params.cacheKey, null);
  return null;
}

/** Loads policy hooks directly by canonical bundled plugin id. */
export function resolveDirectBundledProviderPolicySurface(
  pluginId: string,
): BundledProviderPolicySurface | null {
  // Provider refs are not necessarily plugin directories. Let manifest-owned
  // policy resolution handle namespaced refs without weakening artifact path checks.
  if (
    pluginId === "." ||
    pluginId === ".." ||
    pluginId.includes("/") ||
    pluginId.includes("\\") ||
    pluginId.includes(":")
  ) {
    return null;
  }
  return resolveCachedProviderPolicySurface({
    cache: bundledProviderPolicySurfaceByPluginId,
    cacheKey: `${resolveBundledPluginsDir() ?? ""}\0${pluginId}`,
    loadModule: (artifactBasename) =>
      loadBundledPluginPublicArtifactModuleSync<Record<string, unknown>>({
        dirName: pluginId,
        artifactBasename,
      }),
    missingSurfacePrefix: "Unable to resolve bundled plugin public surface ",
    extractSurface: extractBundledProviderPolicySurface,
  });
}

/** Loads policy hooks from a host-verified official external plugin install. */
export function resolveTrustedExternalProviderPolicySurface(params: {
  pluginId: string;
  pluginRoot: string;
  trustedOfficialInstall?: boolean;
}): ProviderPolicySurface | null {
  if (params.trustedOfficialInstall !== true) {
    return null;
  }
  return resolveCachedProviderPolicySurface({
    cache: externalProviderPolicySurfaceByPluginId,
    cacheKey: `${params.pluginRoot}\0${params.pluginId}`,
    loadModule: (artifactBasename) =>
      loadPluginPublicArtifactModuleSync<Record<string, unknown>>({
        pluginRoot: params.pluginRoot,
        artifactBasename,
      }),
    missingSurfacePrefix: "Unable to resolve plugin public surface ",
    extractSurface: extractProviderPolicySurface,
  });
}
