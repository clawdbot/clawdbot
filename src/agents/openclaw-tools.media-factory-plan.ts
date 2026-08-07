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
import { isCapabilityProviderConfigured } from "./tools/media-tool-shared.js";

/**
 * Plans optional media-tool factory registration from config, policy, capabilities, and auth.
 * Generation eligibility is decided once here so create*GenerateTool can skip a second scan.
 */
type OptionalMediaToolFactoryPlan = {
  image: boolean;
  imageGenerate: boolean;
  videoGenerate: boolean;
  musicGenerate: boolean;
  pdf: boolean;
};

type PreparedGenerationProviderKey =
  | "imageGenerationProviders"
  | "videoGenerationProviders"
  | "musicGenerationProviders";

type PreparedCapabilityProvider = {
  id: string;
  aliases?: string[];
  defaultModel?: string;
  models?: readonly string[];
  isConfigured?: (ctx: { cfg?: OpenClawConfig; agentDir?: string }) => boolean;
};

function resolvePreparedGenerationProviders(
  prepared: PreparedModelRuntimeSnapshot["mediaCapabilityProviders"] | undefined,
  key: PreparedGenerationProviderKey,
): PreparedCapabilityProvider[] | undefined {
  const providers = prepared?.[key];
  if (!providers) {
    return undefined;
  }
  // Project prepared runtime providers onto the narrow readiness surface used by
  // isCapabilityProviderConfigured (id + optional isConfigured). Avoid casting the
  // full image/video/music provider unions — they are not assignable to each other.
  return providers.map((provider) => ({
    id: provider.id,
    ...(typeof provider.isConfigured === "function"
      ? {
          isConfigured: (ctx: { cfg?: OpenClawConfig; agentDir?: string }) =>
            provider.isConfigured?.(ctx) === true,
        }
      : {}),
  }));
}

/**
 * Generation readiness for the factory plan.
 * - Explicit model config wins even when a prepared family is empty (prepared runtimes are
 *   not a deny list for configured models).
 * - Prepared families evaluate provider isConfigured callbacks.
 * - Without prepared providers, use snapshot capability (workspace scope + base-url guards).
 *   Do not fall back to raw auth-only checks; that would reintroduce snapshot leaks.
 */
function planGenerationToolAvailability(params: {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  authStore?: AuthProfileStore;
  modelConfig?: AgentModelConfig;
  providerKey: PreparedGenerationProviderKey;
  preparedProviders?: PreparedCapabilityProvider[];
  snapshot: Parameters<typeof hasSnapshotCapabilityAvailability>[0]["snapshot"];
}): boolean {
  if (hasExplicitToolModelConfig(params.modelConfig)) {
    return true;
  }
  if (params.preparedProviders !== undefined) {
    return params.preparedProviders.some((provider) =>
      isCapabilityProviderConfigured({
        providers: params.preparedProviders!,
        provider,
        cfg: params.config,
        workspaceDir: params.workspaceDir,
        agentDir: params.agentDir,
        authStore: params.authStore,
      }),
    );
  }
  return hasSnapshotCapabilityAvailability({
    snapshot: params.snapshot,
    authStore: params.authStore,
    key: params.providerKey,
    config: params.config,
  });
}

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
  agentDir?: string;
  modelHasVision?: boolean;
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
  const explicitPdf = hasExplicitPdfModelConfig(params.config);
  if (params.config?.plugins?.enabled === false) {
    // Provider credentials can make the built-in image tool usable even when plugin tools are
    // globally disabled. Keep the provider/env lookup independent from that global plugin gate.
    const providerSignalConfig: OpenClawConfig | undefined = params.config
      ? {
          ...params.config,
          plugins: params.config.plugins ? { ...params.config.plugins, enabled: true } : undefined,
        }
      : undefined;
    const snapshot =
      params.preparedModelRuntime?.metadataSnapshot ??
      loadCapabilityMetadataSnapshot({
        config: params.config,
        ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
      });
    const preparedProviders =
      params.preparedModelRuntime?.mediaCapabilityProviders?.mediaUnderstandingProviders;
    // Optional media tools are plugin/capability backed. Disabling plugins shuts them off even when
    // stale defaults or env availability would otherwise appear to make a tool available.
    // Image understanding can still be available via modelHasVision, explicit config, or a
    // configured vision provider with a usable auth/env signal.
    const imageWhenPluginsDisabled =
      Boolean(params.agentDir?.trim()) &&
      (params.modelHasVision === true ||
        hasExplicitImageModelConfig(params.config) ||
        hasConfiguredVisionModelAuthSignal({
          config: providerSignalConfig,
          snapshot,
          authStore: params.authStore,
          preparedProviders,
        }));
    return {
      image: imageWhenPluginsDisabled,
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
  const image = resolveImageToolFactoryAvailable({
    config: params.config,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    modelHasVision: params.modelHasVision,
    authStore: params.authStore,
    preparedModelRuntime: params.preparedModelRuntime,
  });
  // Generation readiness (explicit model, prepared isConfigured, snapshot guards) lives here so
  // create*GenerateTool can skip a second availability scan on the tool-prep hot path.
  return {
    image,
    imageGenerate:
      allowImageGenerate &&
      planGenerationToolAvailability({
        config: params.config,
        agentDir: params.agentDir,
        workspaceDir: params.workspaceDir,
        authStore: params.authStore,
        modelConfig: defaults?.mediaModels?.image,
        providerKey: "imageGenerationProviders",
        preparedProviders: resolvePreparedGenerationProviders(
          preparedProviders,
          "imageGenerationProviders",
        ),
        snapshot,
      }),
    videoGenerate:
      allowVideoGenerate &&
      planGenerationToolAvailability({
        config: params.config,
        agentDir: params.agentDir,
        workspaceDir: params.workspaceDir,
        authStore: params.authStore,
        modelConfig: defaults?.mediaModels?.video,
        providerKey: "videoGenerationProviders",
        preparedProviders: resolvePreparedGenerationProviders(
          preparedProviders,
          "videoGenerationProviders",
        ),
        snapshot,
      }),
    musicGenerate:
      allowMusicGenerate &&
      planGenerationToolAvailability({
        config: params.config,
        agentDir: params.agentDir,
        workspaceDir: params.workspaceDir,
        authStore: params.authStore,
        modelConfig: defaults?.mediaModels?.music,
        providerKey: "musicGenerationProviders",
        preparedProviders: resolvePreparedGenerationProviders(
          preparedProviders,
          "musicGenerationProviders",
        ),
        snapshot,
      }),
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
