import { describe, expect, it } from "vitest";
import { buildKimiCodingProvider, normalizeKimiCodingModelId } from "./provider-catalog.js";

describe("kimi provider catalog", () => {
  it("builds the bundled Kimi coding defaults", () => {
    const provider = buildKimiCodingProvider();

    expect(provider.api).toBe("anthropic-messages");
    expect(provider.baseUrl).toBe("https://api.kimi.com/coding/");
    expect(provider.headers).toEqual({ "User-Agent": "claude-code/0.1.0" });
    expect(provider.models.map((model) => model.id)).toEqual([
      "kimi-for-coding",
      "kimi-code",
      "k2p5",
    ]);
  });

  it("normalizes legacy Kimi coding model ids to the stable API model id", () => {
    expect(normalizeKimiCodingModelId("kimi-code")).toBe("kimi-for-coding");
    expect(normalizeKimiCodingModelId("k2p5")).toBe("kimi-for-coding");
    expect(normalizeKimiCodingModelId("kimi-for-coding")).toBe("kimi-for-coding");
  });
});
