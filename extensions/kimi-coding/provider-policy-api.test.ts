import { describe, expect, it } from "vitest";
import { isKimiK3ModelId, resolveThinkingProfile } from "./provider-policy-api.js";

describe("Kimi Code provider policy", () => {
  it.each(["k3", "k3[1m]"])("exposes off and max for %s", (modelId) => {
    expect(resolveThinkingProfile({ provider: "kimi", modelId })).toEqual({
      levels: [
        { id: "off", label: "off" },
        { id: "max", label: "max" },
      ],
      defaultLevel: "max",
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
    expect(isKimiK3ModelId("k3[1M]")).toBe(true);
    expect(isKimiK3ModelId("kimi-for-coding")).toBe(false);
  });
});
