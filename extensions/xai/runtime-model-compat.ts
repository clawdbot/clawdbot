import { applyXaiModelCompat } from "./model-compat.js";

type XaiRuntimeModelCompat = {
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

function normalizeXaiCompatModelId(id: unknown): string {
  return typeof id === "string" ? id.trim().toLowerCase() : "";
}

function supportsConfigurableXaiReasoningEffort(model: XaiRuntimeModelCompat): boolean {
  const id = normalizeXaiCompatModelId(model.id);
  return model.reasoning === true && (id === "grok-4.3" || id.startsWith("grok-4.3-"));
}

function resolveXaiReasoningEffortCompat(model: XaiRuntimeModelCompat): Record<string, unknown> {
  if (supportsConfigurableXaiReasoningEffort(model)) {
    return {
      supportsReasoningEffort: true,
      supportedReasoningEfforts: [...XAI_SUPPORTED_REASONING_EFFORTS],
    };
  }
  return { supportsReasoningEffort: false };
}

export function applyXaiRuntimeModelCompat<T extends XaiRuntimeModelCompat>(
  model: T,
): T & { compat: Record<string, unknown>; thinkingLevelMap: XaiThinkingLevelMap } {
  const withCompat = applyXaiModelCompat(model);
  const supportsReasoningEffort = supportsConfigurableXaiReasoningEffort(withCompat);
  const existingCompat =
    withCompat.compat && typeof withCompat.compat === "object"
      ? (withCompat.compat as Record<string, unknown>)
      : {};
  return {
    ...withCompat,
    compat: {
      ...existingCompat,
      ...resolveXaiReasoningEffortCompat(withCompat),
    },
    thinkingLevelMap: {
      ...withCompat.thinkingLevelMap,
      ...(supportsReasoningEffort ? XAI_REASONING_EFFORTS : XAI_UNSUPPORTED_REASONING_EFFORTS),
    },
  };
}
