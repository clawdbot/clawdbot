import {
  buildModelAliasIndex,
  inferUniqueProviderFromConfiguredModels,
  modelKey,
  resolveModelRefFromString,
  type ModelRef,
} from "../../agents/model-selection.js";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../../config/model-input.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

export type ImageModelOverridePlan =
  | {
      kind: "inline-session";
    }
  | {
      kind: "inline-image-model";
      modelOverride: string;
      modelOverrideFallbacks: string[];
    }
  | {
      kind: "media-paths";
      reason: "no-image-attachments" | "no-image-model" | "not-vision-capable";
    };

export type ImageModelCapabilityResolver = (ref: ModelRef) => Promise<boolean>;

type ImageModelCandidate = {
  raw: string;
  ref: ModelRef;
  key: string;
};

function resolveImageModelCandidate(params: {
  raw: string;
  cfg: OpenClawConfig;
  defaultProvider: string;
}): ImageModelCandidate | null {
  const trimmed = params.raw.trim();
  if (!trimmed) {
    return null;
  }
  const imageDefaultProvider = trimmed.includes("/")
    ? params.defaultProvider
    : (inferUniqueProviderFromConfiguredModels({ cfg: params.cfg, model: trimmed }) ??
      params.defaultProvider);
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider: imageDefaultProvider,
  });
  const resolved = resolveModelRefFromString({
    cfg: params.cfg,
    raw: trimmed,
    defaultProvider: imageDefaultProvider,
    aliasIndex,
  });
  if (!resolved) {
    return null;
  }
  const ref = resolved.ref;
  return {
    raw: trimmed,
    ref,
    key: modelKey(ref.provider, ref.model),
  };
}

export async function resolveImageModelOverridePlan(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  defaultProvider: string;
  defaultModel: string;
  hasImageAttachments: boolean;
  sessionModelSupportsImages: boolean;
  modelSupportsImages: ImageModelCapabilityResolver;
}): Promise<ImageModelOverridePlan> {
  if (!params.hasImageAttachments) {
    return { kind: "media-paths", reason: "no-image-attachments" };
  }
  if (params.sessionModelSupportsImages) {
    return { kind: "inline-session" };
  }

  const imageModelConfig = params.cfg.agents?.defaults?.imageModel;
  const primary = resolveAgentModelPrimaryValue(imageModelConfig);
  const rawCandidates = [
    ...(primary ? [primary] : []),
    ...resolveAgentModelFallbackValues(imageModelConfig),
  ];
  if (rawCandidates.length === 0) {
    return { kind: "media-paths", reason: "no-image-model" };
  }

  const runnableCandidates: ImageModelCandidate[] = [];
  for (const raw of rawCandidates) {
    const candidate = resolveImageModelCandidate({
      raw,
      cfg: params.cfg,
      defaultProvider: params.defaultProvider,
    });
    if (!candidate) {
      continue;
    }
    if (!(await params.modelSupportsImages(candidate.ref))) {
      continue;
    }
    runnableCandidates.push(candidate);
  }

  const selected = runnableCandidates[0];
  if (!selected) {
    return { kind: "media-paths", reason: "not-vision-capable" };
  }

  return {
    kind: "inline-image-model",
    modelOverride: selected.key,
    modelOverrideFallbacks: runnableCandidates.slice(1).map((candidate) => candidate.key),
  };
}
