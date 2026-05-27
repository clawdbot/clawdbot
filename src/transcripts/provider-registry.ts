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

export function normalizeTranscriptSourceProviderId(
  providerId: string | undefined,
): string | undefined {
  return normalizeCapabilityProviderId(providerId);
}

function resolveTranscriptsSourceProviderEntries(cfg?: OpenClawConfig): TranscriptSourceProvider[] {
  return resolvePluginCapabilityProviders({
    key: "transcriptSourceProviders",
    cfg,
  });
}

function buildProviderMaps(cfg?: OpenClawConfig): {
  canonical: Map<string, TranscriptSourceProvider>;
  aliases: Map<string, TranscriptSourceProvider>;
} {
  return buildCapabilityProviderMaps(resolveTranscriptsSourceProviderEntries(cfg));
}

export function listTranscriptSourceProviders(cfg?: OpenClawConfig): TranscriptSourceProvider[] {
  return [...buildProviderMaps(cfg).canonical.values()];
}

export function getTranscriptSourceProvider(
  providerId: string | undefined,
  cfg?: OpenClawConfig,
): TranscriptSourceProvider | undefined {
  const normalized = normalizeTranscriptSourceProviderId(providerId);
  if (!normalized) {
    return undefined;
  }
  const directProvider = resolvePluginCapabilityProvider({
    key: "transcriptSourceProviders",
    providerId: normalized,
    cfg,
  });
  if (directProvider) {
    return directProvider;
  }
  return buildProviderMaps(cfg).aliases.get(normalized);
}
