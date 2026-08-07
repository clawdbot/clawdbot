import { createMediaProviderRegistry } from "../media-generation/provider-registry.js";

/** Registry for music-generation providers contributed by plugin capabilities. */
export const {
  listProviders: listMusicGenerationProviders,
  getProvider: getMusicGenerationProvider,
} = createMediaProviderRegistry("musicGenerationProviders");
