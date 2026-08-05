// Registers transcript providers and resolves enabled source runtimes.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolvePluginCapabilityProvider,
  resolvePluginCapabilityProviders,
} from "../plugins/capability-provider-runtime.js";
import {
  buildCapabilityProviderMaps,
  normalizeCapabilityProviderId,
} from "../plugins/provider-registry-shared.js";
import type { TranscriptSourceProvider } from "./provider-types.js";

/**
 * Transcript source provider registry.
 *
 * Transcript providers are plugin capability providers; this module exposes
 * canonical/alias lookup through the shared capability runtime.
 */
/** Normalize transcript source provider ids for registry lookup. */
export function normalizeTranscriptSourceProviderId(
  providerId: string | undefined,
): string | undefined {
  return normalizeCapabilityProviderId(providerId);
}

/** List canonical transcript source providers for a config snapshot. */
export function listTranscriptSourceProviders(cfg?: OpenClawConfig): TranscriptSourceProvider[] {
  const providers = resolvePluginCapabilityProviders({ key: "transcriptSourceProviders", cfg });
  return [...buildCapabilityProviderMaps(providers).canonical.values()];
}

/** Resolve a transcript provider by canonical id or alias. */
export function getTranscriptSourceProvider(
  providerId: string | undefined,
  cfg?: OpenClawConfig,
): TranscriptSourceProvider | undefined {
  const normalized = normalizeTranscriptSourceProviderId(providerId);
  if (!normalized) {
    return undefined;
  }
  return resolvePluginCapabilityProvider({
    key: "transcriptSourceProviders",
    providerId: normalized,
    cfg,
  });
}
