// Kimi Coding tests cover provider catalog plugin behavior.
import { describe, expect, it } from "vitest";
import { buildKimiCodingProvider, normalizeKimiCodingModelId } from "./provider-catalog.js";
import { isKimiK3ModelId } from "./provider-policy-api.js";

describe("kimi provider catalog", () => {
  it("builds the bundled Kimi coding defaults", () => {
    const provider = buildKimiCodingProvider();

    expect(provider.api).toBe("anthropic-messages");
    expect(provider.baseUrl).toBe("https://api.kimi.com/coding/");
    expect(provider.headers).toEqual({ "User-Agent": "claude-code/0.1.0" });
    expect(provider.models.map((model) => model.id)).toEqual([
      "kimi-for-coding",
      "kimi-for-coding-highspeed",
      "k3",
      "k3[1m]",
    ]);
    expect(provider.models.find((model) => model.id === "k3")).toMatchObject({
      name: "Kimi K3",
      reasoning: true,
      contextWindow: 262_144,
      maxTokens: 32_768,
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: null,
        medium: null,
        high: null,
        xhigh: "max",
        max: "max",
      },
    });
    expect(provider.models.find((model) => model.id === "k3[1m]")).toMatchObject({
      name: "Kimi K3 (1M)",
      contextWindow: 1_048_576,
      maxTokens: 32_768,
    });
    expect(provider.models.find((model) => model.id === "kimi-for-coding-highspeed")).toMatchObject(
      {
        name: "Kimi K2.7 Code HighSpeed",
        reasoning: true,
        contextWindow: 262_144,
        maxTokens: 32_768,
      },
    );
  });

  it("normalizes legacy Kimi coding model ids to the stable API model id", () => {
    expect(normalizeKimiCodingModelId("kimi-code")).toBe("kimi-for-coding");
    expect(normalizeKimiCodingModelId("k2p5")).toBe("kimi-for-coding");
    expect(normalizeKimiCodingModelId("kimi-for-coding")).toBe("kimi-for-coding");
    expect(normalizeKimiCodingModelId("k3")).toBe("k3");
    expect(normalizeKimiCodingModelId("kimi-for-coding-highspeed")).toBe(
      "kimi-for-coding-highspeed",
    );
    expect(isKimiK3ModelId("k3")).toBe(true);
    expect(isKimiK3ModelId("k3[1m]")).toBe(true);
    expect(isKimiK3ModelId("kimi-for-coding")).toBe(false);
  });
});
