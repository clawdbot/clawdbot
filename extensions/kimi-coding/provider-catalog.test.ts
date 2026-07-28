// Kimi Coding tests cover provider catalog plugin behavior.
import { describe, expect, it } from "vitest";
import { buildKimiCodingProvider, normalizeKimiCodingModelId } from "./provider-catalog.js";
import { isKimiK3ModelId, KIMI_K3_MODEL_IDS } from "./provider-policy-api.js";

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
      "k3-256k",
    ]);
    expect(provider.models.find((model) => model.id === "k3")).toMatchObject({
      name: "Kimi K3",
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: "low",
        low: "low",
        medium: "high",
        high: "high",
        xhigh: "max",
        max: "max",
      },
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
      contextWindow: 1_048_576,
      maxTokens: 131_072,
      compat: { codeMode: "preferred" },
    });
    expect(provider.models.find((model) => model.id === "k3-256k")).toMatchObject({
      name: "Kimi K3 (256k)",
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: "low",
        low: "low",
        medium: "high",
        high: "high",
        xhigh: "max",
        max: "max",
      },
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
      contextWindow: 262_144,
      maxTokens: 131_072,
      compat: { codeMode: "preferred" },
    });
    expect(provider.models.find((model) => model.id === "kimi-for-coding-highspeed")).toMatchObject(
      {
        name: "Kimi K2.7 Code HighSpeed",
        reasoning: true,
        contextWindow: 262_144,
        maxTokens: 32_768,
      },
    );
    // K2.7 stays unflagged here and in the sibling `moonshot` catalog; only K3 is preferred.
    for (const id of ["kimi-for-coding", "kimi-for-coding-highspeed"]) {
      expect(provider.models.find((model) => model.id === id)?.compat?.codeMode).toBeUndefined();
    }
  });

  it("covers every K3 catalog row with the K3 thinking policy", () => {
    // The manifest owns the rows and `provider-policy-api` owns the thinking
    // profile, so a new K3 variant must land in both or lose its levels.
    const thinkingRows = buildKimiCodingProvider()
      .models.filter((model) => model.thinkingLevelMap)
      .map((model) => model.id);

    expect(thinkingRows).toEqual([...KIMI_K3_MODEL_IDS]);
  });

  it("normalizes legacy Kimi coding model ids to the stable API model id", () => {
    expect(normalizeKimiCodingModelId("kimi-code")).toBe("kimi-for-coding");
    expect(normalizeKimiCodingModelId("k2p5")).toBe("kimi-for-coding");
    expect(normalizeKimiCodingModelId("kimi-for-coding")).toBe("kimi-for-coding");
    expect(normalizeKimiCodingModelId("k3")).toBe("k3");
    expect(normalizeKimiCodingModelId("k3[1m]")).toBe("k3");
    expect(normalizeKimiCodingModelId("kimi-for-coding-highspeed")).toBe(
      "kimi-for-coding-highspeed",
    );
    expect(isKimiK3ModelId("k3")).toBe(true);
    expect(isKimiK3ModelId("K3-256K")).toBe(true);
    expect(isKimiK3ModelId("kimi-for-coding")).toBe(false);
  });
});
