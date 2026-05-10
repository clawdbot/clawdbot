import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
} from "openclaw/plugin-sdk/plugin-entry";
import { resolveXaiCatalogEntry } from "./model-definitions.js";

export function resolveThinkingProfile(
  ctx: ProviderDefaultThinkingPolicyContext,
): ProviderThinkingProfile {
  const reasoning = ctx.reasoning ?? resolveXaiCatalogEntry(ctx.modelId)?.reasoning;
  if (ctx.provider !== "xai" || !reasoning) {
    return { levels: [{ id: "off" }], defaultLevel: "off" };
  }
  return {
    levels: [{ id: "off" }, { id: "minimal" }, { id: "low" }, { id: "medium" }, { id: "high" }],
    defaultLevel: "low",
  };
}
