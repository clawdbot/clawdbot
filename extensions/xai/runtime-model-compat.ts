import { applyXaiModelCompat } from "openclaw/plugin-sdk/provider-tools";

type XaiRuntimeModelCompat = {
  compat?: unknown;
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

export function applyXaiRuntimeModelCompat<T extends XaiRuntimeModelCompat>(
  model: T,
): T & { thinkingLevelMap: XaiThinkingLevelMap } {
  const withCompat = applyXaiModelCompat(model);
  return {
    ...withCompat,
    thinkingLevelMap: {
      ...withCompat.thinkingLevelMap,
      ...(withCompat.reasoning ? XAI_REASONING_EFFORTS : XAI_UNSUPPORTED_REASONING_EFFORTS),
    },
  };
}
