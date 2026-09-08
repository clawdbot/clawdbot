// Xai plugin module implements runtime model compat behavior.
// Reasoning effort is configurable only for current flagship Grok models; encrypted reasoning
// include/replay is handled separately in stream.ts for every reasoning-capable xAI model.
import { applyXaiModelCompat } from "./model-compat.js";
import { isXaiFrontierModelId, isXaiGrok46ModelId } from "./model-id.js";
import { supportsXaiPromptCacheKey } from "./provider-routing.js";

type XaiRuntimeModelCompat = {
  api?: unknown;
  baseUrl?: unknown;
  compat?: unknown;
  id?: unknown;
  reasoning?: unknown;
  thinkingLevelMap?: XaiThinkingLevelMap;
};
type XaiThinkingLevelMap = Partial<
  Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh", string | null>
>;

const XAI_UNSUPPORTED_REASONING_EFFORTS = {
  off: null,
  minimal: null,
  low: null,
  medium: null,
  high: null,
  xhigh: null,
} satisfies NonNullable<XaiRuntimeModelCompat["thinkingLevelMap"]>;

const XAI_REASONING_EFFORTS = {
  off: null,
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
} satisfies NonNullable<XaiRuntimeModelCompat["thinkingLevelMap"]>;

const XAI_SUPPORTED_REASONING_EFFORTS = ["low", "medium", "high"] as const;

function isGrok43Model(id: string): boolean {
  return id === "grok-latest" || id === "grok-4.3" || id.startsWith("grok-4.3-");
}

export function applyXaiRuntimeModelCompat<T extends XaiRuntimeModelCompat>(
  model: T,
): T & { compat: Record<string, unknown>; thinkingLevelMap: XaiThinkingLevelMap } {
  const withCompat = applyXaiModelCompat(model);
  const id = typeof withCompat.id === "string" ? withCompat.id.trim().toLowerCase() : "";
  const supportsReasoningEffort =
    withCompat.reasoning === true && (isGrok43Model(id) || isXaiFrontierModelId(id));
  const existingCompat =
    withCompat.compat && typeof withCompat.compat === "object"
      ? { ...(withCompat.compat as Record<string, unknown>) }
      : {};
  if (supportsXaiPromptCacheKey(withCompat)) {
    existingCompat.supportsPromptCacheKey ??= true;
    existingCompat.supportsLongCacheRetention ??= false;
  }
  return {
    ...withCompat,
    compat: {
      ...existingCompat,
      supportsReasoningEffort,
      ...(supportsReasoningEffort
        ? {
            supportedReasoningEfforts: [
              ...(isGrok43Model(id) ? ["none"] : []),
              ...XAI_SUPPORTED_REASONING_EFFORTS,
              ...(isXaiGrok46ModelId(id) ? ["xhigh"] : []),
            ],
          }
        : {}),
    },
    thinkingLevelMap: {
      ...withCompat.thinkingLevelMap,
      ...(supportsReasoningEffort ? XAI_REASONING_EFFORTS : XAI_UNSUPPORTED_REASONING_EFFORTS),
      ...(supportsReasoningEffort && isGrok43Model(id) ? { off: "none" } : {}),
      ...(supportsReasoningEffort && isXaiGrok46ModelId(id) ? { xhigh: "xhigh" } : {}),
    },
  };
}
