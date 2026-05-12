import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
import type { AgentModelConfig } from "../config/types.agents-shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { listProfilesForProvider } from "./auth-profiles/profile-list.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { isToolAllowedByPolicyName } from "./tool-policy-match.js";
import { DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY } from "./tool-policy.js";
import {
  hasSnapshotCapabilityAvailability,
  hasSnapshotProviderEnvAvailability,
  loadCapabilityMetadataSnapshot,
} from "./tools/manifest-capability-availability.js";

export type OptionalMediaToolFactoryPlan = {
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

export function mergeFactoryPolicyList(
  ...lists: Array<string[] | undefined>
): string[] | undefined {
  const merged = lists.flatMap((list) => (Array.isArray(list) ? list : []));
  return merged.length > 0 ? Array.from(new Set(merged)) : undefined;
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
  return Array.from(new Set(["*", ...withoutDefaultPluginMarker]));
}

export function resolveImageToolFactoryAvailable(params: {
  config?: OpenClawConfig;
  agentDir?: string;
  modelHasVision?: boolean;
  authStore?: AuthProfileStore;
}): boolean {
  if (!params.agentDir?.trim()) {
    return false;
  }
  if (params.modelHasVision || hasExplicitImageModelConfig(params.config)) {
    return true;
  }
  const snapshot = loadCapabilityMetadataSnapshot({
    config: params.config,
  });
  return (
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
    })
  );
}

function hasConfiguredVisionModelAuthSignal(params: {
  config?: OpenClawConfig;
  snapshot: Pick<PluginMetadataSnapshot, "index" | "plugins">;
  authStore?: AuthProfileStore;
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
    if (params.authStore && listProfilesForProvider(params.authStore, providerId).length > 0) {
      return true;
    }
    if (
      hasSnapshotProviderEnvAvailability({
        snapshot: params.snapshot,
        providerId,
        config: params.config,
      })
    ) {
      return true;
    }
  }
  return false;
}

export function resolveOptionalMediaToolFactoryPlan(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  authStore?: AuthProfileStore;
  toolAllowlist?: string[];
  toolDenylist?: string[];
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
  const explicitImageGeneration = hasExplicitToolModelConfig(defaults?.imageGenerationModel);
  const explicitVideoGeneration = hasExplicitToolModelConfig(defaults?.videoGenerationModel);
  const explicitMusicGeneration = hasExplicitToolModelConfig(defaults?.musicGenerationModel);
  const explicitPdf = hasExplicitPdfModelConfig(params.config);
  if (params.config?.plugins?.enabled === false) {
    return {
      imageGenerate: false,
      videoGenerate: false,
      musicGenerate: false,
      pdf: false,
    };
  }
  const snapshot = loadCapabilityMetadataSnapshot({
    config: params.config,
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
  });
  return {
    imageGenerate:
      allowImageGenerate &&
      (explicitImageGeneration ||
        hasSnapshotCapabilityAvailability({
          snapshot,
          authStore: params.authStore,
          key: "imageGenerationProviders",
          config: params.config,
        })),
    videoGenerate:
      allowVideoGenerate &&
      (explicitVideoGeneration ||
        hasSnapshotCapabilityAvailability({
          snapshot,
          authStore: params.authStore,
          key: "videoGenerationProviders",
          config: params.config,
        })),
    musicGenerate:
      allowMusicGenerate &&
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
