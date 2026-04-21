export type QaThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "adaptive"
  | "max";

export function normalizeQaThinkingLevel(input: unknown): QaThinkingLevel | undefined {
  const value = typeof input === "string" ? input.trim().toLowerCase() : "";
  const collapsed = value.replace(/[\s_-]+/g, "");
  if (collapsed === "off") {
    return "off";
  }
  if (collapsed === "minimal" || collapsed === "min") {
    return "minimal";
  }
  if (collapsed === "low") {
    return "low";
  }
  if (collapsed === "medium" || collapsed === "med") {
    return "medium";
  }
  if (collapsed === "high") {
    return "high";
  }
  if (collapsed === "xhigh" || collapsed === "extrahigh") {
    return "xhigh";
  }
  if (collapsed === "adaptive" || collapsed === "auto") {
    return "adaptive";
  }
  if (collapsed === "max") {
    return "max";
  }
  return undefined;
}
