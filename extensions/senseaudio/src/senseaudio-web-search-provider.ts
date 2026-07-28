import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
// Senseaudio provider module implements model/runtime integration.
import type { WebSearchProviderPlugin } from "openclaw/plugin-sdk/provider-web-search-contract";
import { createSenseAudioWebSearchProviderBase } from "./senseaudio-web-search-provider.shared.js";

const loadSenseAudioWebSearchRuntime = createLazyRuntimeModule(
  () => import("./senseaudio-web-search-provider.runtime.js"),
);

// SenseAudio hosted web_search has no result-count control, so no count param.
const SenseAudioSearchSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "Search query string." },
    country: { type: "string", description: "Not supported by SenseAudio." },
    language: { type: "string", description: "Not supported by SenseAudio." },
    freshness: { type: "string", description: "Not supported by SenseAudio." },
    date_after: { type: "string", description: "Not supported by SenseAudio." },
    date_before: { type: "string", description: "Not supported by SenseAudio." },
  },
} satisfies Record<string, unknown>;

export function createSenseAudioWebSearchProvider(): WebSearchProviderPlugin {
  return {
    ...createSenseAudioWebSearchProviderBase(),
    createTool: (ctx) => ({
      description:
        "Search the web using SenseAudio. Returns AI-synthesized answers with citations from native web_search grounding.",
      parameters: SenseAudioSearchSchema,
      execute: async (args, context) => {
        const { executeSenseAudioWebSearchProviderTool } = await loadSenseAudioWebSearchRuntime();
        return await executeSenseAudioWebSearchProviderTool(ctx, args, context?.signal);
      },
    }),
  };
}
