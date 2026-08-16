import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createMediaProviderRegistry } from "../media-generation/provider-registry.js";
import { normalizeCapabilityProviderId } from "../plugins/provider-registry-shared.js";
import type { RealtimeTranscriptionProviderId } from "./provider-types.js";

export { normalizeCapabilityProviderId as normalizeRealtimeTranscriptionProviderId };

/** Realtime transcription uses targeted lookup to avoid broad capability discovery. */
export const {
  listProviders: listRealtimeTranscriptionProviders,
  getProvider: getRealtimeTranscriptionProvider,
} = createMediaProviderRegistry("realtimeTranscriptionProviders", { directLookup: true });

/** Canonicalizes a configured provider id while preserving unknown ids. */
export function canonicalizeRealtimeTranscriptionProviderId(
  providerId: string | undefined,
  cfg?: OpenClawConfig,
): RealtimeTranscriptionProviderId | undefined {
  const normalized = normalizeCapabilityProviderId(providerId);
  return normalized
    ? (getRealtimeTranscriptionProvider(normalized, cfg)?.id ?? normalized)
    : undefined;
}
