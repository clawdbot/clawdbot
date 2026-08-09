import { describe, expect, it } from "vitest";
import { isKimiK3ModelId, resolveThinkingProfile } from "./provider-policy-api.js";

describe("Kimi Code provider policy", () => {
  it.each(["k3", "k3-256k"])("exposes adaptive K3 thinking levels for %s", (modelId) => {
    expect(resolveThinkingProfile({ provider: "kimi", modelId })).toEqual({
      levels: [
        { id: "off" },
        { id: "minimal" },
        { id: "low" },
        { id: "medium" },
        { id: "high" },
        { id: "adaptive" },
        { id: "xhigh" },
        { id: "max" },
      ],
      defaultLevel: "high",
      preserveWhenCatalogReasoningFalse: true,
    });
  });

  it("keeps legacy Kimi Code thinking binary and off by default", () => {
    expect(resolveThinkingProfile({ provider: "kimi", modelId: "kimi-for-coding" })).toEqual({
      levels: [
        { id: "off", label: "off" },
        { id: "low", label: "on" },
      ],
      defaultLevel: "off",
    });
  });

  it("recognizes K3 wire ids case-insensitively", () => {
    expect(isKimiK3ModelId("K3")).toBe(true);
    expect(isKimiK3ModelId("K3-256K")).toBe(true);
    expect(isKimiK3ModelId("kimi-for-coding")).toBe(false);
  });
});
