import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  providerSupportsNativePdfDocument,
  resolveAutoMediaKeyProviders,
  resolveDefaultMediaModel,
  resolveDocumentMediaModel,
} from "../../media-understanding/defaults.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { findNormalizedProviderValue } from "../model-selection.js";
import {
  coerceImageModelConfig,
  type ImageModelConfig,
  resolveConfiguredImageModelRefs,
  resolveProviderVisionModelFromConfig,
} from "./image-tool.helpers.js";
import { hasProviderAuthForTool, resolveDefaultModelRef } from "./model-config.helpers.js";
import { coercePdfModelConfig } from "./pdf-tool.helpers.js";

function formatProviderModelRef(providerId: string, modelId: string): string {
  const slash = modelId.indexOf("/");
  if (slash > 0 && modelId.slice(0, slash).trim() === providerId) {
    return modelId;
  }
  return `${providerId}/${modelId}`;
}

function localModelIdForProvider(providerId: string, modelId: string): string {
  const slash = modelId.indexOf("/");
  if (slash > 0 && modelId.slice(0, slash).trim() === providerId) {
    return modelId.slice(slash + 1).trim();
  }
  return modelId.trim();
}

function resolveConfiguredTextModelFromConfig(params: {
  cfg?: OpenClawConfig;
  providerId: string;
}): string | undefined {
  const providers = params.cfg?.models?.providers;
  if (!providers || typeof providers !== "object") {
    return undefined;
  }
  const providerCfg = findNormalizedProviderValue(providers, params.providerId);
  const modelId = providerCfg?.models
    ?.find(
      (model) =>
        Boolean(model?.id?.trim()) && Array.isArray(model?.input) && model.input.includes("text"),
    )
    ?.id?.trim();
  return modelId || undefined;
}

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
      hasProviderAuthForTool({
        provider: providerId,
        cfg: params.cfg,
        workspaceDir: params.workspaceDir,
        agentDir: params.agentDir,
        authStore: params.authStore,
      }),
    )
    .map((providerId) => {
      const documentImageModel = resolveDocumentMediaModel({
        cfg: params.cfg,
        workspaceDir: params.workspaceDir,
        providerId,
        document: "pdf",
        mode: "image",
      });
      if (documentImageModel === false) {
        return null;
      }
      const modelId =
        documentImageModel ??
        resolveProviderVisionModelFromConfig({
          cfg: params.cfg,
          provider: providerId,
        })?.split("/")[1] ??
        resolveDefaultMediaModel({
          cfg: params.cfg,
          workspaceDir: params.workspaceDir,
          providerId,
          capability: "image",
        });
      return modelId ? formatProviderModelRef(providerId, modelId) : null;
    })
    .filter((value): value is string => Boolean(value));
}

function resolveTextExtractionCandidateRefs(params: {
  cfg?: OpenClawConfig;
  primary: { provider: string; model: string };
  agentDir: string;
  workspaceDir?: string;
  authStore?: AuthProfileStore;
}): string[] {
  const candidates: string[] = [];
  const addCandidate = (providerId: string, modelId: string) => {
    const provider = providerId.trim();
    const model = modelId.trim();
    if (!provider || !model) {
      return;
    }
    const ref = formatProviderModelRef(provider, model);
    if (!candidates.includes(ref)) {
      candidates.push(ref);
    }
  };

  const providerIds = [
    params.primary.provider,
    ...resolveAutoMediaKeyProviders({
      capability: "image",
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
    }),
  ];
  for (const providerId of providerIds) {
    if (
      !providerId ||
      !hasProviderAuthForTool({
        provider: providerId,
        cfg: params.cfg,
        workspaceDir: params.workspaceDir,
        agentDir: params.agentDir,
        authStore: params.authStore,
      })
    ) {
      continue;
    }
    const documentTextModel = resolveDocumentMediaModel({
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      providerId,
      document: "pdf",
      mode: "textExtraction",
    });
    if (!documentTextModel) {
      continue;
    }
    const documentImageModel = resolveDocumentMediaModel({
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      providerId,
      document: "pdf",
      mode: "image",
    });
    const preferredTextModel =
      providerId === params.primary.provider
        ? params.primary.model
        : resolveConfiguredTextModelFromConfig({ cfg: params.cfg, providerId });
    const providerDefaultImageModel = resolveDefaultMediaModel({
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      providerId,
      capability: "image",
      includeConfiguredImageModels: false,
    });
    const preferredLocalModel = preferredTextModel
      ? localModelIdForProvider(providerId, preferredTextModel)
      : "";
    const preferredIsImageModel =
      Boolean(preferredLocalModel) &&
      ((typeof documentImageModel === "string" &&
        localModelIdForProvider(providerId, documentImageModel) === preferredLocalModel) ||
        providerDefaultImageModel === preferredLocalModel);
    const model =
      preferredTextModel && !preferredIsImageModel ? preferredTextModel : documentTextModel;
    addCandidate(providerId, model);
  }

  return candidates;
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
  const googleOk = hasProviderAuthForTool({
    provider: "google",
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
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

  const providerOk = hasProviderAuthForTool({
    provider: primary.provider,
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
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
  const textExtractionCandidates = resolveTextExtractionCandidateRefs({
    cfg: params.cfg,
    primary,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    authStore: params.authStore,
  });
  const preferPrimaryTextExtraction =
    providerOk && textExtractionCandidates.some((ref) => ref.startsWith(`${primary.provider}/`));

  if (params.cfg?.models?.providers && typeof params.cfg.models.providers === "object") {
    for (const [providerKey, providerCfg] of Object.entries(params.cfg.models.providers)) {
      const providerId = providerKey.trim();
      const documentImageModel = providerId
        ? resolveDocumentMediaModel({
            cfg: params.cfg,
            workspaceDir: params.workspaceDir,
            providerId,
            document: "pdf",
            mode: "image",
          })
        : undefined;
      if (
        !providerId ||
        documentImageModel === false ||
        !hasProviderAuthForTool({
          provider: providerId,
          cfg: params.cfg,
          workspaceDir: params.workspaceDir,
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

  const fallbackCandidates = preferPrimaryTextExtraction
    ? [...nativePdfCandidates, ...textExtractionCandidates, ...genericImageCandidates]
    : [...nativePdfCandidates, ...genericImageCandidates, ...textExtractionCandidates];

  if (primary.provider === "google" && googleOk && providerVision && primarySupportsNativePdf) {
    preferred = providerVision;
  } else if (providerOk && primarySupportsNativePdf && (providerVision || providerDefault)) {
    preferred = providerVision ?? `${primary.provider}/${providerDefault}`;
  } else {
    preferred = fallbackCandidates[0] ?? null;
  }

  if (preferred?.trim()) {
    for (const candidate of fallbackCandidates) {
      if (candidate !== preferred) {
        addFallback(candidate);
      }
    }
    const pruned = fallbacks.filter((ref) => ref !== preferred);
    return { primary: preferred, ...(pruned.length > 0 ? { fallbacks: pruned } : {}) };
  }

  return null;
}
