// Senseaudio API module exposes the plugin public contract.
import type { WebSearchProviderPlugin } from "openclaw/plugin-sdk/provider-web-search-contract";
import { createSenseAudioWebSearchProviderBase } from "./src/senseaudio-web-search-provider.shared.js";

export function createSenseAudioWebSearchProvider(): WebSearchProviderPlugin {
  return {
    ...createSenseAudioWebSearchProviderBase(),
    createTool: () => null,
  };
}
