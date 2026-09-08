/** Lightweight direct loader for bundled provider policy public artifacts. */
import type { ModelProviderConfig } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  ProviderFastModePolicyContext,
  ProviderModelRouteResolution,
  ProviderNormalizeModelCatalogIdContext,
  ProviderResponseModelEquivalenceContext,
  ProviderResolveModelRoutesContext,
  ProviderToolSearchPolicyContext,
} from "../plugin-sdk/provider-model-types.js";
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
  loadBundledPluginPublicArtifactModuleFromCandidatesSync,
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

type ProviderProjectRealtimeVoicePublicConfigContext = {
  providerConfig: Record<string, unknown>;
  config: Record<string, unknown>;
};

export type RealtimeVoicePublicClientHints = {
  modelSource?: "gateway";
  gatewayRelaySupported?: boolean;
};

export type RealtimeVoicePublicProjection = {
  config: Record<string, unknown>;
  clientHints?: RealtimeVoicePublicClientHints;
};

type EmbeddingProviderSetupInspection = {
  provider: string;
  reason: string;
  requirement?: string;
  fixHint?: string;
};

export type InspectEmbeddingProviderSetup = (params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  agentId: string;
  provider: string;
}) => EmbeddingProviderSetupInspection | null | Promise<EmbeddingProviderSetupInspection | null>;

/** Provider policy hooks supported by bundled and trusted official plugins. */
export type ProviderPolicySurface = {
  resolveFastModeSupport?: (ctx: ProviderFastModePolicyContext) => boolean | undefined;
  deprecatedProfileIds?: readonly string[];
  normalizeConfig?: (ctx: ProviderNormalizeConfigContext) => ModelProviderConfig | null | undefined;
  applyConfigDefaults?: (
    ctx: ProviderApplyConfigDefaultsContext,
  ) => OpenClawConfig | null | undefined;
  resolveConfigApiKey?: (ctx: ProviderResolveConfigApiKeyContext) => string | null | undefined;
  resolveThinkingProfile?: (
    ctx: ProviderDefaultThinkingPolicyContext,
  ) => ProviderThinkingProfile | null | undefined;
  /** Prefer compact tool discovery, or veto a managed-service default for a hosted route. */
  resolveToolSearchMode?: (ctx: ProviderToolSearchPolicyContext) => "tools" | false | undefined;
  resolveModelRoutes?: (
    ctx: ProviderResolveModelRoutesContext,
  ) => ProviderModelRouteResolution | null | undefined;
  normalizeModelCatalogId?: (
    ctx: ProviderNormalizeModelCatalogIdContext,
  ) => string | null | undefined;
  isResponseModelEquivalent?: (
    ctx: ProviderResponseModelEquivalenceContext,
  ) => boolean | null | undefined;
  inspectEmbeddingProviderSetup?: InspectEmbeddingProviderSetup;
};

/** Provider policy hooks loaded only from bundled plugin public artifacts. */
export type BundledProviderPolicySurface = ProviderPolicySurface & {
  projectConfiguredModelRow?: (
    ctx: ProviderProjectConfiguredModelRowContext,
  ) => ProviderRuntimeModel | null | undefined;
  projectRealtimeVoicePublicProjection?: (
    ctx: ProviderProjectRealtimeVoicePublicConfigContext,
  ) => RealtimeVoicePublicProjection | null | undefined;
};

const PROVIDER_POLICY_HOOK_KEYS = [
  "resolveFastModeSupport",
  "normalizeConfig",
  "applyConfigDefaults",
  "resolveConfigApiKey",
  "resolveThinkingProfile",
  "resolveToolSearchMode",
  "resolveModelRoutes",
  "normalizeModelCatalogId",
  "isResponseModelEquivalent",
  "inspectEmbeddingProviderSetup",
] as const satisfies readonly (keyof ProviderPolicySurface)[];

function extractProviderPolicySurface(mod: Record<string, unknown>): ProviderPolicySurface | null {
  const surface: ProviderPolicySurface = {};
  if (
    Array.isArray(mod.deprecatedProfileIds) &&
    mod.deprecatedProfileIds.every((value) => typeof value === "string")
  ) {
    surface.deprecatedProfileIds = mod.deprecatedProfileIds;
  }
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
  if (typeof mod.projectRealtimeVoicePublicProjection === "function") {
    Object.assign(surface, {
      projectRealtimeVoicePublicProjection: mod.projectRealtimeVoicePublicProjection,
    });
  }
  return Object.keys(surface).length > 0 ? surface : null;
}

function resolveProviderPolicySurface<T extends ProviderPolicySurface>(params: {
  loadModule: (artifactBasename: string) => Record<string, unknown>;
  missingSurfacePrefix: string;
  extractSurface: (mod: Record<string, unknown>) => T | null;
}): T | null {
  for (const artifactBasename of PROVIDER_POLICY_ARTIFACT_CANDIDATES) {
    try {
      const mod = params.loadModule(artifactBasename);
      const surface = params.extractSurface(mod);
      if (surface) {
        return surface;
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(params.missingSurfacePrefix)) {
        continue;
      }
      throw error;
    }
  }
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
  const mod = loadBundledPluginPublicArtifactModuleFromCandidatesSync<Record<string, unknown>>({
    dirName: pluginId,
    artifactCandidates: PROVIDER_POLICY_ARTIFACT_CANDIDATES,
  });
  return mod ? extractBundledProviderPolicySurface(mod) : null;
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
  return resolveProviderPolicySurface({
    loadModule: (artifactBasename) =>
      loadPluginPublicArtifactModuleSync<Record<string, unknown>>({
        pluginRoot: params.pluginRoot,
        artifactBasename,
      }),
    missingSurfacePrefix: "Unable to resolve plugin public surface ",
    extractSurface: extractProviderPolicySurface,
  });
}
