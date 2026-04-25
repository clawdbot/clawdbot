import { describe, expect, it } from "vitest";
import { isLiveTestEnabled } from "../../src/agents/live-test-helpers.js";
import { createMiniMaxWebSearchProvider } from "./src/minimax-web-search-provider.js";

const MINIMAX_SEARCH_KEY =
  process.env.MINIMAX_CODE_PLAN_KEY?.trim() ||
  process.env.MINIMAX_CODING_API_KEY?.trim() ||
  process.env.MINIMAX_API_KEY?.trim() ||
  "";
const describeLive =
  isLiveTestEnabled() && MINIMAX_SEARCH_KEY.length > 0 ? describe : describe.skip;

describeLive("minimax plugin live", () => {
  it("runs MiniMax web search through the provider tool", async () => {
    const provider = createMiniMaxWebSearchProvider();
    const tool = provider.createTool?.({
      config: {},
      searchConfig: { apiKey: MINIMAX_SEARCH_KEY, cacheTtlMinutes: 0 },
    } as never);

    const result = await tool?.execute({ query: "OpenClaw GitHub", count: 1 });

    expect(result?.provider).toBe("minimax");
    expect(result?.count).toBeGreaterThan(0);
    expect(Array.isArray(result?.results)).toBe(true);
  }, 120_000);
});
