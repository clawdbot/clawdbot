/** Compatibility and explicit leases for the shipped speech-provider registry API. */
import {
  acquirePluginCapabilityProvider,
  acquirePluginCapabilityProviders,
} from "../plugins/capability-provider-runtime.js";
import { getSpeechProviderCore, listSpeechProvidersCore } from "../tts/provider-registry.js";
import { withLegacyPluginSdkResourceScope } from "./legacy-registry-resource-scope.js";

/** @deprecated Use acquireSpeechProvider and release it after all provider callbacks complete. */
export function getSpeechProvider(...args: Parameters<typeof getSpeechProviderCore>) {
  return withLegacyPluginSdkResourceScope(() => getSpeechProviderCore(...args));
}

/** @deprecated Use acquireSpeechProviders and release it after all provider callbacks complete. */
export function listSpeechProviders(...args: Parameters<typeof listSpeechProvidersCore>) {
  return withLegacyPluginSdkResourceScope(() => listSpeechProvidersCore(...args));
}

export function acquireSpeechProvider(
  providerId: string,
  cfg?: Parameters<typeof listSpeechProvidersCore>[0],
) {
  return acquirePluginCapabilityProvider({ key: "speechProviders", providerId, cfg });
}

export function acquireSpeechProviders(cfg?: Parameters<typeof listSpeechProvidersCore>[0]) {
  return acquirePluginCapabilityProviders({ key: "speechProviders", cfg });
}
