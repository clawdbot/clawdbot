import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { findCapabilityProviderById } from "../../packages/media-generation-core/src/capability-model-ref.js";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
import type { AgentModelConfig } from "../config/types.agents-shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeMediaProviderId } from "../media-understanding/provider-id.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { listProfilesForProvider } from "./auth-profiles/profile-list.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.js";
import { isToolAllowedByPolicyName } from "./tool-policy-match.js";
import { DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY } from "./tool-policy.js";
import {
  hasSnapshotCapabilityAvailability,
  hasSnapshotCapabilityProviderAvailability,
  hasSnapshotProviderEnvAvailability,
  loadCapabilityMetadataSnapshot,
} from "./tools/manifest-capability-availability.js";

/**
 * Plans optional media-tool factory registration from config, policy, capabilities, and auth.
 */
type OptionalMediaToolFactoryPlan = {
  imageGenerate: boolean;
  videoGenerate: boolean;
  musicGenerate: boolean;
  pdf: boolean;
};

type ToolModelConfig = { primary?: string; fallbacks?: string[] };

function coerceFactoryToolModelConfig(model?: AgentModelConfig): ToolModelConfig {
  const primary = resolveAgentModelPrimaryValue(model);
  const fallbacks = resolveAgentModelFallbackValues(model);
  return {
    ...(primary?.trim() ? { primary: primary.trim() } : {}),
    ...(fallbacks.length > 0 ? { fallbacks } : {}),
  };
}

function hasToolModelConfig(model: ToolModelConfig | undefined): boolean {
  return Boolean(
    model?.primary?.trim() || (model?.fallbacks ?? []).some((entry) => entry.trim().length > 0),
  );
}

function hasExplicitToolModelConfig(modelConfig: AgentModelConfig | undefined): boolean {
  return hasToolModelConfig(coerceFactoryToolModelConfig(modelConfig));
}

function hasExplicitImageModelConfig(config: OpenClawConfig | undefined): boolean {
  return hasExplicitToolModelConfig(config?.agents?.defaults?.imageModel);
}

function hasExplicitPdfModelConfig(config: OpenClawConfig | undefined): boolean {
  return (
    hasExplicitToolModelConfig(config?.agents?.defaults?.pdfModel) ||
    hasExplicitImageModelConfig(config)
  );
}

function isToolAllowedByFactoryPolicy(params: {
  toolName: string;
  allowlist?: string[];
  denylist?: string[];
}): boolean {
  return isToolAllowedByPolicyName(params.toolName, {
    allow: params.allowlist,
    deny: params.denylist,
  });
}

/** Returns true only when an allowlist explicitly enables the requested tool. */
export function isToolExplicitlyAllowedByFactoryPolicy(params: {
  toolName: string;
  allowlist?: string[];
  denylist?: string[];
}): boolean {
  if (!params.allowlist?.some((entry) => typeof entry === "string" && entry.trim().length > 0)) {
    return false;
  }
  return isToolAllowedByFactoryPolicy(params);
}

/** Merges factory policy lists while preserving stable unique entries. */
export function mergeFactoryPolicyList(
  ...lists: Array<string[] | undefined>
): string[] | undefined {
  const merged = lists.flatMap((list) => (Array.isArray(list) ? list : []));
  return merged.length > 0 ? uniqueStrings(merged) : undefined;
}

function mergeBuiltInFactoryAllowlist(...lists: Array<string[] | undefined>): string[] | undefined {
  const allowlist = mergeFactoryPolicyList(...lists);
  if (
    !allowlist?.some(
      (entry) => typeof entry === "string" && entry.trim() === DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY,
    )
  ) {
    return allowlist;
  }
  const withoutDefaultPluginMarker = allowlist.filter(
    (entry) => typeof entry !== "string" || entry.trim() !== DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY,
  );
  return uniqueStrings(["*", ...withoutDefaultPluginMarker]);
}

/** Returns whether the image understanding tool can be constructed for this agent context. */
export function resolveImageToolFactoryAvailable(params: {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  modelHasVision?: boolean;
  authStore?: AuthProfileStore;
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
}): boolean {
  if (!params.agentDir?.trim()) {
    return false;
  }
  if (params.modelHasVision || hasExplicitImageModelConfig(params.config)) {
    return true;
  }
  const snapshot =
    params.preparedModelRuntime?.metadataSnapshot ??
    loadCapabilityMetadataSnapshot({
      config: params.config,
      ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    });
  const preparedProviders =
    params.preparedModelRuntime?.mediaCapabilityProviders?.mediaUnderstandingProviders;
  const hasPreparedImageProvider = preparedProviders?.some(
    (provider) =>
      provider.capabilities?.includes("image") &&
      hasSnapshotCapabilityProviderAvailability({
        snapshot,
        authStore: params.authStore,
        key: "mediaUnderstandingProviders",
        providerId: provider.id,
        config: params.config,
      }),
  );
  return (
    (preparedProviders === undefined
      ? hasSnapshotCapabilityAvailability({
          snapshot,
          authStore: params.authStore,
          key: "mediaUnderstandingProviders",
          config: params.config,
        })
      : hasPreparedImageProvider === true) ||
    hasConfiguredVisionModelAuthSignal({
      config: params.config,
      snapshot,
      authStore: params.authStore,
      preparedProviders,
    })
  );
}

function hasConfiguredVisionModelAuthSignal(params: {
  config?: OpenClawConfig;
  snapshot: Pick<PluginMetadataSnapshot, "index" | "plugins">;
  authStore?: AuthProfileStore;
  preparedProviders?: NonNullable<
    PreparedModelRuntimeSnapshot["mediaCapabilityProviders"]
  >["mediaUnderstandingProviders"];
}): boolean {
  const providers = params.config?.models?.providers;
  if (!providers || typeof providers !== "object") {
    return false;
  }
  for (const [providerId, providerConfig] of Object.entries(providers)) {
    if (
      !providerConfig?.models?.some(
        (model) => Array.isArray(model?.input) && model.input.includes("image"),
      )
    ) {
      continue;
    }
    const profileIds = params.authStore
      ? listProfilesForProvider(params.authStore, providerId)
      : [];
    const hasDirectProfile = profileIds.some(
      (profileId) => params.authStore?.profiles[profileId]?.type === "api_key",
    );
    const hasEnv = hasSnapshotProviderEnvAvailability({
      snapshot: params.snapshot,
      providerId,
      config: params.config,
    });
    const needsPreparedCodex =
      normalizeMediaProviderId(providerId) === "openai" &&
      profileIds.length > 0 &&
      !hasDirectProfile &&
      !hasEnv;
    if (
      needsPreparedCodex &&
      params.preparedProviders !== undefined &&
      !findCapabilityProviderById({
        providers: params.preparedProviders,
        providerId: "codex",
        normalizeProviderId: normalizeMediaProviderId,
      })?.capabilities?.includes("image")
    ) {
      continue;
    }
    if (profileIds.length > 0 || hasEnv) {
      return true;
    }
  }
  return false;
}

/** Resolves which optional media tools should be created for the current tool factory call. */
export function resolveOptionalMediaToolFactoryPlan(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  authStore?: AuthProfileStore;
  toolAllowlist?: string[];
  toolDenylist?: string[];
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
}): OptionalMediaToolFactoryPlan {
  const defaults = params.config?.agents?.defaults;
  const toolAllowlist = mergeBuiltInFactoryAllowlist(
    params.config?.tools?.allow,
    params.toolAllowlist,
  );
  const toolDenylist = mergeFactoryPolicyList(params.config?.tools?.deny, params.toolDenylist);
  const allowImageGenerate = isToolAllowedByFactoryPolicy({
    toolName: "image_generate",
    allowlist: toolAllowlist,
    denylist: toolDenylist,
  });
  const allowVideoGenerate = isToolAllowedByFactoryPolicy({
    toolName: "video_generate",
    allowlist: toolAllowlist,
    denylist: toolDenylist,
  });
  const allowMusicGenerate = isToolAllowedByFactoryPolicy({
    toolName: "music_generate",
    allowlist: toolAllowlist,
    denylist: toolDenylist,
  });
  const allowPdf = isToolAllowedByFactoryPolicy({
    toolName: "pdf",
    allowlist: toolAllowlist,
    denylist: toolDenylist,
  });
  const explicitImageGeneration = hasExplicitToolModelConfig(defaults?.mediaModels?.image);
  const explicitVideoGeneration = hasExplicitToolModelConfig(defaults?.mediaModels?.video);
  const explicitMusicGeneration = hasExplicitToolModelConfig(defaults?.mediaModels?.music);
  const explicitPdf = hasExplicitPdfModelConfig(params.config);
  if (params.config?.plugins?.enabled === false) {
    // Optional media tools are plugin/capability backed. Disabling plugins shuts them off even when
    // stale defaults or env availability would otherwise appear to make a tool available.
    return {
      imageGenerate: false,
      videoGenerate: false,
      musicGenerate: false,
      pdf: false,
    };
  }
  const snapshot =
    params.preparedModelRuntime?.metadataSnapshot ??
    loadCapabilityMetadataSnapshot({
      config: params.config,
      ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    });
  const preparedProviders = params.preparedModelRuntime?.mediaCapabilityProviders;
  const preparedFamilyAvailable = (providers: readonly unknown[] | undefined) =>
    providers === undefined || providers.length > 0;
  return {
    imageGenerate:
      allowImageGenerate &&
      preparedFamilyAvailable(preparedProviders?.imageGenerationProviders) &&
      (explicitImageGeneration ||
        hasSnapshotCapabilityAvailability({
          snapshot,
          authStore: params.authStore,
          key: "imageGenerationProviders",
          config: params.config,
        })),
    videoGenerate:
      allowVideoGenerate &&
      preparedFamilyAvailable(preparedProviders?.videoGenerationProviders) &&
      (explicitVideoGeneration ||
        hasSnapshotCapabilityAvailability({
          snapshot,
          authStore: params.authStore,
          key: "videoGenerationProviders",
          config: params.config,
        })),
    musicGenerate:
      allowMusicGenerate &&
      preparedFamilyAvailable(preparedProviders?.musicGenerationProviders) &&
      (explicitMusicGeneration ||
        hasSnapshotCapabilityAvailability({
          snapshot,
          authStore: params.authStore,
          key: "musicGenerationProviders",
          config: params.config,
        })),
    pdf:
      allowPdf &&
      (explicitPdf ||
        hasSnapshotCapabilityAvailability({
          snapshot,
          authStore: params.authStore,
          key: "mediaUnderstandingProviders",
          config: params.config,
        }) ||
        hasConfiguredVisionModelAuthSignal({
          config: params.config,
          snapshot,
          authStore: params.authStore,
        })),
  };
}
