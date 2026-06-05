// Github Copilot API module exposes the plugin public contract.
import type { ProviderDefaultThinkingPolicyContext } from "openclaw/plugin-sdk/core";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveStaticCopilotModelOverride } from "./model-metadata.js";

const COPILOT_XHIGH_MODEL_IDS = ["gpt-5.4", "gpt-5.3-codex"] as const;

function compatSupportsXHigh(
  compat: { supportedReasoningEfforts?: readonly string[] | null } | null | undefined,
) {
  return (
    Array.isArray(compat?.supportedReasoningEfforts) &&
    compat.supportedReasoningEfforts.some(
      (effort) => normalizeOptionalLowercaseString(effort) === "xhigh",
    )
  );
}

export function resolveThinkingProfile(context: ProviderDefaultThinkingPolicyContext) {
  if (context.provider.trim().toLowerCase() !== "github-copilot") {
    return null;
  }
  const normalizedModelId = normalizeOptionalLowercaseString(context.modelId) ?? "";
  const staticCompat = resolveStaticCopilotModelOverride(normalizedModelId)?.compat;
  const modelSupportsXHigh =
    COPILOT_XHIGH_MODEL_IDS.includes(normalizedModelId as never) ||
    compatSupportsXHigh(context.compat) ||
    compatSupportsXHigh(staticCompat);

  return {
    levels: [
      { id: "off" as const },
      { id: "minimal" as const },
      { id: "low" as const },
      { id: "medium" as const },
      { id: "high" as const },
      ...(modelSupportsXHigh ? [{ id: "xhigh" as const }] : []),
    ],
  };
}
