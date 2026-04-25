import { describe, expect, it } from "vitest";
import { isLiveTestEnabled } from "../../src/agents/live-test-helpers.js";
import { createKimiWebSearchProvider } from "./src/kimi-web-search-provider.js";

const KIMI_SEARCH_KEY =
  process.env.KIMI_API_KEY?.trim() || process.env.MOONSHOT_API_KEY?.trim() || "";
const describeLive = isLiveTestEnabled() && KIMI_SEARCH_KEY.length > 0 ? describe : describe.skip;

describeLive("moonshot plugin live", () => {
  it("runs Kimi web search through the provider tool", async () => {
    const provider = createKimiWebSearchProvider();
    const tool = provider.createTool?.({
      config: {},
      searchConfig: { kimi: { apiKey: KIMI_SEARCH_KEY }, cacheTtlMinutes: 0 },
    } as never);

    const result = await tool?.execute({ query: "OpenClaw GitHub", count: 1 });

    expect(result?.provider).toBe("kimi");
    expect(typeof result?.content).toBe("string");
    expect((result?.content as string).length).toBeGreaterThan(20);
    expect(Array.isArray(result?.citations)).toBe(true);
  }, 120_000);
});
