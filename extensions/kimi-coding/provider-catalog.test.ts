import { describe, expect, it } from "vitest";
import { buildKimiCodingProvider } from "./provider-catalog.js";

describe("kimi provider catalog", () => {
  it("builds the bundled Kimi coding defaults", () => {
    const provider = buildKimiCodingProvider();

    expect(provider.api).toBe("anthropic-messages");
    expect(provider.baseUrl).toBe("https://api.kimi.com/coding/");
    expect(provider.headers).toEqual({ "User-Agent": "claude-code/0.1.0" });
    expect(provider.models.map((model) => model.id)).toEqual(["kimi-code", "k2p5"]);
  });
});
