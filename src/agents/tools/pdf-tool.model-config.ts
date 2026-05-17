import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  providerSupportsNativePdfDocument,
  resolveAutoMediaKeyProviders,
  resolveDefaultMediaModel,
} from "../../media-understanding/defaults.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { isMinimaxVlmProvider } from "../minimax-vlm.js";
import {
  coerceImageModelConfig,
  type ImageModelConfig,
  resolveConfiguredImageModelRefs,
  resolveProviderVisionModelFromConfig,
} from "./image-tool.helpers.js";
import { hasAuthForProvider, resolveDefaultModelRef } from "./model-config.helpers.js";
import { coercePdfModelConfig } from "./pdf-tool.helpers.js";

function resolveImageCandidateRefs(params: {
  cfg?: OpenClawConfig;
  agentDir: string;
  workspaceDir?: string;
  authStore?: AuthProfileStore;
  filter?: (providerId: string) => boolean;
}): string[] {
  return resolveAutoMediaKeyProviders({
    capability: "image",
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
  })
    .filter((providerId) => !params.filter || params.filter(providerId))
    .filter((providerId) =>
      hasAuthForProvider({
        provider: providerId,
        agentDir: params.agentDir,
        authStore: params.authStore,
      }),
    )
    .map((providerId) => {
      const modelId =
        resolveProviderVisionModelFromConfig({
          cfg: params.cfg,
          provider: providerId,
        })?.split("/")[1] ??
        resolveDefaultMediaModel({
          cfg: params.cfg,
          workspaceDir: params.workspaceDir,
          providerId,
          capability: "image",
          includeConfiguredImageModels: !isMinimaxVlmProvider(providerId),
        });
      return modelId ? `${providerId}/${modelId}` : null;
    })
    .filter((value): value is string => Boolean(value));
}

export function resolvePdfModelConfigForTool(params: {
  cfg?: OpenClawConfig;
  agentDir: string;
  workspaceDir?: string;
  authStore?: AuthProfileStore;
}): ImageModelConfig | null {
  const explicitPdf = coercePdfModelConfig(params.cfg);
  if (explicitPdf.primary?.trim() || (explicitPdf.fallbacks?.length ?? 0) > 0) {
    return resolveConfiguredImageModelRefs({
      cfg: params.cfg,
      imageModelConfig: explicitPdf,
    });
  }

  const explicitImage = coerceImageModelConfig(params.cfg);
  if (explicitImage.primary?.trim() || (explicitImage.fallbacks?.length ?? 0) > 0) {
    return resolveConfiguredImageModelRefs({
      cfg: params.cfg,
      imageModelConfig: explicitImage,
    });
  }

  const primary = resolveDefaultModelRef(params.cfg);
  const googleOk = hasAuthForProvider({
    provider: "google",
    agentDir: params.agentDir,
    authStore: params.authStore,
  });

  const fallbacks: string[] = [];
  const addFallback = (ref: string) => {
    const trimmed = ref.trim();
    if (trimmed && !fallbacks.includes(trimmed)) {
      fallbacks.push(trimmed);
    }
  };

  let preferred: string | null = null;

  const providerOk = hasAuthForProvider({
    provider: primary.provider,
    agentDir: params.agentDir,
    authStore: params.authStore,
  });
  const providerVision = resolveProviderVisionModelFromConfig({
    cfg: params.cfg,
    provider: primary.provider,
  });
  const providerDefault =
    providerVision?.split("/")[1] ??
    resolveDefaultMediaModel({
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      providerId: primary.provider,
      capability: "image",
      includeConfiguredImageModels: !isMinimaxVlmProvider(primary.provider),
    });
  const primarySupportsNativePdf = providerSupportsNativePdfDocument({
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
    providerId: primary.provider,
  });
  const nativePdfCandidates = resolveImageCandidateRefs({
    cfg: params.cfg,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    authStore: params.authStore,
    filter: (providerId) =>
      providerSupportsNativePdfDocument({
        cfg: params.cfg,
        workspaceDir: params.workspaceDir,
        providerId,
      }),
  });
  const genericImageCandidates = resolveImageCandidateRefs({
    cfg: params.cfg,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    authStore: params.authStore,
  });

  if (params.cfg?.models?.providers && typeof params.cfg.models.providers === "object") {
    for (const [providerKey, providerCfg] of Object.entries(params.cfg.models.providers)) {
      const providerId = providerKey.trim();
      if (
        !providerId ||
        isMinimaxVlmProvider(providerId) ||
        !hasAuthForProvider({
          provider: providerId,
          agentDir: params.agentDir,
          authStore: params.authStore,
        })
      ) {
        continue;
      }
      const models = providerCfg?.models ?? [];
      const modelId = models
        .find(
          (model) =>
            Boolean(model?.id?.trim()) &&
            Array.isArray(model?.input) &&
            model.input.includes("image"),
        )
        ?.id?.trim();
      if (!modelId) {
        continue;
      }
      const ref = `${providerId}/${modelId}`;
      if (!genericImageCandidates.includes(ref)) {
        genericImageCandidates.push(ref);
      }
    }
  }

  if (primary.provider === "google" && googleOk && providerVision && primarySupportsNativePdf) {
    preferred = providerVision;
  } else if (providerOk && primarySupportsNativePdf && (providerVision || providerDefault)) {
    preferred = providerVision ?? `${primary.provider}/${providerDefault}`;
  } else {
    preferred = nativePdfCandidates[0] ?? genericImageCandidates[0] ?? null;
  }

  if (preferred?.trim()) {
    for (const candidate of [...nativePdfCandidates, ...genericImageCandidates]) {
      if (candidate !== preferred) {
        addFallback(candidate);
      }
    }
    const pruned = fallbacks.filter((ref) => ref !== preferred);
    return { primary: preferred, ...(pruned.length > 0 ? { fallbacks: pruned } : {}) };
  }

  return null;
}
