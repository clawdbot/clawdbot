import { createMediaProviderRegistry } from "../media-generation/provider-registry.js";

/** Registry for image-generation providers contributed by plugin capabilities. */
export const {
  listProviders: listImageGenerationProviders,
  getProvider: getImageGenerationProvider,
} = createMediaProviderRegistry("imageGenerationProviders");
