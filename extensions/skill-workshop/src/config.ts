export type SkillWorkshopConfig = {
  enabled: boolean;
  autoCapture: boolean;
  approvalPolicy: "pending" | "auto";
  reviewMode: "off" | "heuristic" | "llm" | "hybrid";
  reviewInterval: number;
  reviewMinToolCalls: number;
  reviewTimeoutMs: number;
  maxPending: number;
  maxSkillBytes: number;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readInteger(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(Math.max(Math.trunc(value), min), max)
    : fallback;
}

export function resolveConfig(raw: unknown): SkillWorkshopConfig {
  const cfg = asRecord(raw);
  const approvalPolicy = cfg.approvalPolicy === "auto" ? "auto" : "pending";
  const reviewMode =
    cfg.reviewMode === "off" ||
    cfg.reviewMode === "heuristic" ||
    cfg.reviewMode === "llm" ||
    cfg.reviewMode === "hybrid"
      ? cfg.reviewMode
      : "hybrid";
  return {
    enabled: readBoolean(cfg.enabled, true),
    autoCapture: readBoolean(cfg.autoCapture, true),
    approvalPolicy,
    reviewMode,
    reviewInterval: readInteger(cfg.reviewInterval, 15, 1, 200),
    reviewMinToolCalls: readInteger(cfg.reviewMinToolCalls, 8, 1, 500),
    reviewTimeoutMs: readInteger(cfg.reviewTimeoutMs, 45_000, 5_000, 180_000),
    maxPending: readInteger(cfg.maxPending, 50, 1, 200),
    maxSkillBytes: readInteger(cfg.maxSkillBytes, 40_000, 1024, 200_000),
  };
}
