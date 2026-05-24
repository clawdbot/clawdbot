import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolvePluginCapabilityProvider,
  resolvePluginCapabilityProviders,
} from "../plugins/capability-provider-runtime.js";
import {
  buildCapabilityProviderMaps,
  normalizeCapabilityProviderId,
} from "../plugins/provider-registry-shared.js";
import type { MeetingNotesSourceProviderPlugin } from "./provider-types.js";

export function normalizeMeetingNotesSourceProviderId(
  providerId: string | undefined,
): string | undefined {
  return normalizeCapabilityProviderId(providerId);
}

function resolveMeetingNotesSourceProviderEntries(
  cfg?: OpenClawConfig,
): MeetingNotesSourceProviderPlugin[] {
  return resolvePluginCapabilityProviders({
    key: "meetingNotesSourceProviders",
    cfg,
  });
}

function buildProviderMaps(cfg?: OpenClawConfig): {
  canonical: Map<string, MeetingNotesSourceProviderPlugin>;
  aliases: Map<string, MeetingNotesSourceProviderPlugin>;
} {
  return buildCapabilityProviderMaps(resolveMeetingNotesSourceProviderEntries(cfg));
}

export function listMeetingNotesSourceProviders(
  cfg?: OpenClawConfig,
): MeetingNotesSourceProviderPlugin[] {
  return [...buildProviderMaps(cfg).canonical.values()];
}

export function getMeetingNotesSourceProvider(
  providerId: string | undefined,
  cfg?: OpenClawConfig,
): MeetingNotesSourceProviderPlugin | undefined {
  const normalized = normalizeMeetingNotesSourceProviderId(providerId);
  if (!normalized) {
    return undefined;
  }
  const directProvider = resolvePluginCapabilityProvider({
    key: "meetingNotesSourceProviders",
    providerId: normalized,
    cfg,
  });
  if (directProvider) {
    return directProvider;
  }
  return buildProviderMaps(cfg).aliases.get(normalized);
}
