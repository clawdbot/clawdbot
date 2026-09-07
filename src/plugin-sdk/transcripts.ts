/**
 * Public SDK subpath for transcript source provider types and registry lookup.
 */
import {
  acquirePluginCapabilityProvider,
  acquirePluginCapabilityProviders,
} from "../plugins/capability-provider-runtime.js";
import {
  getTranscriptSourceProviderCore as getProviderCore,
  listTranscriptSourceProvidersCore as listProvidersCore,
} from "../transcripts/provider-registry.js";
import { withLegacyPluginSdkResourceScope } from "./legacy-registry-resource-scope.js";
export type {
  TranscriptImportRequest,
  TranscriptOccupancyWatchRequest,
  TranscriptOccupancyWatchHandle,
  TranscriptParticipant,
  TranscriptSessionDescriptor,
  TranscriptSourceKind,
  TranscriptSourceLocator,
  TranscriptSourceAccessControl,
  TranscriptSourceProvider,
  TranscriptSourceStatus,
  TranscriptStartRequest,
  TranscriptToolAction,
  TranscriptToolCaller,
  TranscriptsStartResult,
  TranscriptStopRequest,
  TranscriptsStopResult,
  TranscriptUtterance,
} from "../transcripts/provider-types.js";
export { normalizeTranscriptSourceProviderId } from "../transcripts/provider-registry.js";
export { resolveTranscriptsConfig } from "../transcripts/config.js";
export {
  createMeetingTranscriptSourceProvider,
  type MeetingTranscriptSourceRuntime,
} from "../meeting-bot/transcripts-bridge.js";

/** @deprecated Use acquireTranscriptSourceProvider and release after all callbacks finish. */
export function getTranscriptSourceProvider(...args: Parameters<typeof getProviderCore>) {
  return withLegacyPluginSdkResourceScope(() => getProviderCore(...args));
}

/** @deprecated Use acquireTranscriptSourceProviders and release after all callbacks finish. */
export function listTranscriptSourceProviders(...args: Parameters<typeof listProvidersCore>) {
  return withLegacyPluginSdkResourceScope(() => listProvidersCore(...args));
}

export function acquireTranscriptSourceProvider(
  providerId: string,
  cfg?: Parameters<typeof listProvidersCore>[0],
) {
  return acquirePluginCapabilityProvider({ key: "transcriptSourceProviders", providerId, cfg });
}

export function acquireTranscriptSourceProviders(
  cfg?: Parameters<typeof listProvidersCore>[0],
  additionalProviderIds?: readonly string[],
) {
  return acquirePluginCapabilityProviders({
    key: "transcriptSourceProviders",
    cfg,
    additionalProviderIds,
  });
}
