import { createMediaProviderRegistry } from "../media-generation/provider-registry.js";
export { normalizeCapabilityProviderId as normalizeTranscriptSourceProviderId } from "../plugins/provider-registry-shared.js"; // Sanctioned domain alias.

/** Transcript providers use targeted lookup to avoid broad capability discovery. */
export const {
  listProviders: listTranscriptSourceProviders,
  getProvider: getTranscriptSourceProvider,
} = createMediaProviderRegistry("transcriptSourceProviders", { directLookup: true });
