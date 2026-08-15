// Kilocode tests cover implicit provider plugin behavior.
import { describe, expect, it } from "vitest";
import { buildKilocodeProvider } from "./provider-catalog.js";

describe("Kilo Gateway implicit provider", () => {
  it("publishes the Kilo static provider catalog used by implicit provider setup", () => {
    const provider = buildKilocodeProvider();

    expect(provider.baseUrl).toBe("https://api.kilo.ai/api/gateway/");
    expect(provider.api).toBe("openai-completions");
    expect(provider.models).toStrictEqual([
      {
        id: "kilo-auto/balanced",
        name: "Auto Balanced",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0.325, output: 1.95, cacheRead: 0.0325, cacheWrite: 0.40625 },
        contextWindow: 1000000,
        maxTokens: 65536,
      },
    ]);
  });
});
