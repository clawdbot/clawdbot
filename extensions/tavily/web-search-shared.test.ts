// Tavily web-search provider contract: keyed auto-detect, keyless explicit setup.
import { describe, expect, it } from "vitest";
import { buildTavilyWebSearchProviderBase } from "./web-search-shared.js";

describe("Tavily web search provider contract", () => {
  it("allows keyless setup without opting into keyless auto-detect", () => {
    const provider = buildTavilyWebSearchProviderBase();
    expect(provider.allowsKeyless).toBe(true);
    expect(provider.requiresCredential).not.toBe(false);
  });
});
