import { createMediaProviderRegistry } from "../media-generation/provider-registry.js";

/** Registry for video-generation providers contributed by plugin capabilities. */
export const {
  listProviders: listVideoGenerationProviders,
  getProvider: getVideoGenerationProvider,
} = createMediaProviderRegistry("videoGenerationProviders");
