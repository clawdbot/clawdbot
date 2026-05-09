import { describe, expect, it } from "vitest";
import { buildKilocodeProvider } from "./provider-catalog.js";

describe("Kilo Gateway implicit provider", () => {
  it("publishes the Kilo static provider catalog used by implicit provider setup", () => {
    const provider = buildKilocodeProvider();

    expect(provider.baseUrl).toBe("https://api.kilo.ai/api/gateway/");
    expect(provider.api).toBe("openai-completions");
    expect(provider.models.length).toBeGreaterThan(0);
  });
});
