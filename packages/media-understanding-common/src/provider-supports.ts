// Media Understanding Common module implements provider supports behavior.
import type { MediaUnderstandingCapability } from "./types.js";

type MediaCapabilityProvider = {
  transcribeAudio?: unknown;
  transcribeAudioWithContext?: unknown;
  describeImage?: unknown;
  describeVideo?: unknown;
};

// Capability checks for media-understanding provider objects.

/** Return true when a provider exposes the method for a media capability. */
export function providerSupportsCapability(
  provider: MediaCapabilityProvider | undefined,
  capability: MediaUnderstandingCapability,
): boolean {
  if (!provider) {
    return false;
  }
  if (capability === "audio") {
    return Boolean(provider.transcribeAudioWithContext || provider.transcribeAudio);
  }
  if (capability === "image") {
    return Boolean(provider.describeImage);
  }
  return Boolean(provider.describeVideo);
}
