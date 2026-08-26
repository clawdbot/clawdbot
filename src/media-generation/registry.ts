import { createMediaProviderRegistry } from "./provider-registry.js";

/** Registry for image-generation providers contributed by plugin capabilities. */
export const {
  listProviders: listImageGenerationProviders,
  getProvider: getImageGenerationProvider,
} = createMediaProviderRegistry("imageGenerationProviders");

/** Registry for music-generation providers contributed by plugin capabilities. */
export const {
  listProviders: listMusicGenerationProviders,
  getProvider: getMusicGenerationProvider,
} = createMediaProviderRegistry("musicGenerationProviders");

/** Registry for video-generation providers contributed by plugin capabilities. */
export const {
  listProviders: listVideoGenerationProviders,
  getProvider: getVideoGenerationProvider,
} = createMediaProviderRegistry("videoGenerationProviders");
