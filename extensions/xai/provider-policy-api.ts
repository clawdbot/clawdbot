import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
} from "openclaw/plugin-sdk/plugin-entry";
import { resolveXaiCatalogEntry } from "./model-definitions.js";
import {
  isXaiFrontierModelId,
  isXaiGrok46ModelId,
  normalizeXaiModelId,
  resolveXaiOAuthAutoModelId,
} from "./model-id.js";
import { isXaiProviderId } from "./provider-id.js";

export function resolveThinkingProfile(
  ctx: ProviderDefaultThinkingPolicyContext,
): ProviderThinkingProfile {
  // OAuth catalog rows keep the "auto" alias id and carry the provider-selected
  // target in params.canonicalModelId. Judge that concrete target here too.
  const rawModelId = resolveXaiOAuthAutoModelId(ctx.modelId, ctx.params);
  const modelId = normalizeXaiModelId(rawModelId.trim().toLowerCase());
  const reasoning = ctx.reasoning ?? resolveXaiCatalogEntry(modelId)?.reasoning;
  if (!isXaiProviderId(ctx.provider) || !reasoning) {
    return { levels: [{ id: "off" }], defaultLevel: "off" };
  }
  if (isXaiFrontierModelId(modelId)) {
    const levels: ProviderThinkingProfile["levels"] = isXaiGrok46ModelId(modelId)
      ? [{ id: "low" }, { id: "medium" }, { id: "high" }, { id: "xhigh" }]
      : [{ id: "low" }, { id: "medium" }, { id: "high" }];
    return {
      levels,
      defaultLevel: "high",
    };
  }
  const isGrok43 =
    modelId === "grok-latest" || modelId === "grok-4.3" || modelId.startsWith("grok-4.3-");
  if (!isGrok43) {
    return { levels: [{ id: "off" }], defaultLevel: "off" };
  }
  return {
    levels: [{ id: "off" }, { id: "minimal" }, { id: "low" }, { id: "medium" }, { id: "high" }],
    defaultLevel: "low",
  };
}
