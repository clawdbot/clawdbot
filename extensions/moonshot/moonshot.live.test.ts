import { isLiveTestEnabled } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { createKimiWebSearchProvider } from "./src/kimi-web-search-provider.js";

const KIMI_SEARCH_KEY =
  process.env.KIMI_API_KEY?.trim() || process.env.MOONSHOT_API_KEY?.trim() || "";
const describeLive = isLiveTestEnabled() && KIMI_SEARCH_KEY.length > 0 ? describe : describe.skip;

function isTransientKimiSearchError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === "AbortError") {
    return true;
  }
  const message = error.message.toLowerCase();
  return message.includes("timeout") || message.includes("aborted");
}

describeLive("moonshot plugin live", () => {
  it("runs Kimi web search through the provider tool", async () => {
    const provider = createKimiWebSearchProvider();
    const tool = provider.createTool?.({
      config: {},
      searchConfig: { kimi: { apiKey: KIMI_SEARCH_KEY }, cacheTtlMinutes: 0, timeoutSeconds: 90 },
    } as never);

    let result: { provider?: string; content?: unknown; citations?: unknown } | undefined;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        result = await tool?.execute({ query: "OpenClaw GitHub", count: 1 });
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        if (!isTransientKimiSearchError(error) || attempt === 1) {
          throw error;
        }
      }
    }
    if (lastError) {
      throw lastError;
    }

    expect(result?.provider).toBe("kimi");
    expect(typeof result?.content).toBe("string");
    expect((result?.content as string).length).toBeGreaterThan(20);
    expect(Array.isArray(result?.citations)).toBe(true);
  }, 120_000);
});
