// Senseaudio tests cover live web search provider behavior.
import { isLiveTestEnabled } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { createSenseAudioWebSearchProvider } from "./src/senseaudio-web-search-provider.js";

const SENSEAUDIO_SEARCH_KEY = process.env.SENSEAUDIO_API_KEY?.trim() || "";
const describeLive =
  isLiveTestEnabled() && SENSEAUDIO_SEARCH_KEY.length > 0 ? describe : describe.skip;
const SENSEAUDIO_LIVE_SEARCH_TIMEOUT_SECONDS = 90;

function isTransientSenseAudioSearchError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === "AbortError") {
    return true;
  }
  const message = error.message.toLowerCase();
  return message.includes("timeout") || message.includes("aborted");
}

describeLive("senseaudio plugin live", () => {
  it("runs SenseAudio web search through the provider tool", async () => {
    const provider = createSenseAudioWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: {
        senseaudio: { apiKey: SENSEAUDIO_SEARCH_KEY },
        cacheTtlMinutes: 0,
        timeoutSeconds: SENSEAUDIO_LIVE_SEARCH_TIMEOUT_SECONDS,
      },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    let result: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        result = await tool.execute({ query: "OpenClaw GitHub" });
        break;
      } catch (error) {
        if (!isTransientSenseAudioSearchError(error) || attempt === 1) {
          throw error;
        }
      }
    }

    if (!result) {
      throw new Error("Expected SenseAudio search result");
    }
    expect(result.provider).toBe("senseaudio");
    expect(typeof result.content).toBe("string");
    expect((result.content as string).length).toBeGreaterThan(20);
    expect(Array.isArray(result.citations)).toBe(true);
  }, 240_000);
});
