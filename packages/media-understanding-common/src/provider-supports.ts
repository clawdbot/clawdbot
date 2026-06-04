import type { MediaUnderstandingCapability, MediaUnderstandingProvider } from "./types.js";

// Capability checks for media-understanding provider objects.

/** Return true when a provider exposes the method for a media capability. */
export function providerSupportsCapability(
  provider: MediaUnderstandingProvider | undefined,
  capability: MediaUnderstandingCapability,
): boolean {
  if (!provider) {
    return false;
  }
  if (capability === "audio") {
    return Boolean(provider.transcribeAudio);
  }
  if (capability === "image") {
    return Boolean(provider.describeImage);
  }
  return Boolean(provider.describeVideo);
}
