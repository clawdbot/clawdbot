import { describe, expect, it } from "vitest";
import {
  classifyModelFailure,
  failureCooldownMs,
  rankSmartModels,
  selectSmartModel,
} from "./smart-model-router.js";

describe("smart model router", () => {
  const candidates = [
    {
      provider: "openrouter",
      model: "free-coder",
      free: true,
      available: true,
      capabilities: { coding: 0.95, chat: 0.7 },
      latencyMs: 500,
      successRate: 0.92,
      supportsTools: true,
    },
    {
      provider: "openrouter",
      model: "free-general",
      free: true,
      available: true,
      capabilities: { coding: 0.65, chat: 0.9 },
      latencyMs: 300,
      successRate: 0.95,
    },
    {
      provider: "openrouter",
      model: "paid-coder",
      free: false,
      available: true,
      capabilities: { coding: 1 },
      latencyMs: 250,
      successRate: 0.99,
      supportsTools: true,
    },
  ];

  it("prefers task capability for coding", () => {
    const ranked = rankSmartModels(candidates, { policy: "free-only", task: "coding" });
    expect(ranked[0]?.model).toBe("free-coder");
  });

  it("never selects paid models in free-only mode", () => {
    const selected = selectSmartModel(candidates, { policy: "free-only", task: "coding" });
    expect(selected?.free).toBe(true);
    expect(selected?.model).not.toBe("paid-coder");
  });

  it("requires explicit paid fallback in free-first mode", () => {
    expect(selectSmartModel(candidates, { policy: "free-first", task: "coding" })?.free).toBe(true);
    expect(
      selectSmartModel(candidates, {
        policy: "free-first",
        task: "coding",
        allowPaidFallback: true,
      })?.model,
    ).toBe("paid-coder");
  });

  it("excludes unavailable and cooling-down models", () => {
    const ranked = rankSmartModels(
      candidates.map((candidate) =>
        candidate.model === "free-coder"
          ? { ...candidate, cooldownUntil: Date.now() + 60_000 }
          : candidate,
      ),
      { policy: "free-only", task: "coding" },
    );
    expect(ranked.some((candidate) => candidate.model === "free-coder")).toBe(false);
  });

  it("classifies provider failures", () => {
    expect(classifyModelFailure(429)).toBe("rate-limit");
    expect(classifyModelFailure(401)).toBe("authentication");
    expect(classifyModelFailure(403)).toBe("permission");
    expect(classifyModelFailure(408)).toBe("timeout");
    expect(classifyModelFailure(500)).toBe("provider-error");
    expect(classifyModelFailure(400, "maximum context length exceeded")).toBe("context-length");
    expect(classifyModelFailure(400, "tool calling unsupported")).toBe("tool-incompatible");
    expect(classifyModelFailure(400, "quota exhausted")).toBe("quota");
  });

  it("does not cooldown permanent credential failures", () => {
    expect(failureCooldownMs("authentication")).toBe(0);
    expect(failureCooldownMs("permission")).toBe(0);
    expect(failureCooldownMs("rate-limit")).toBeGreaterThan(0);
  });
});
