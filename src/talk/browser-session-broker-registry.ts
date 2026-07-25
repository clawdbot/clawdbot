import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { getActivePluginHttpRouteRegistry } from "../plugins/runtime.js";
import type { RealtimeVoiceBrowserSessionBroker } from "./provider-types.js";

export function listRealtimeVoiceBrowserSessionBrokers(
  providerId: string,
): RealtimeVoiceBrowserSessionBroker[] {
  const normalizedProviderId = normalizeOptionalLowercaseString(providerId);
  if (!normalizedProviderId) {
    return [];
  }
  // Browser-session credentials and their HTTP exchange handler must come from
  // the same pinned registry. The general active registry can change after the
  // Gateway binds, which would mint credentials that the live route cannot see.
  return (getActivePluginHttpRouteRegistry()?.realtimeVoiceBrowserSessionBrokers ?? [])
    .map((entry) => entry.broker)
    .filter(
      (broker) => normalizeOptionalLowercaseString(broker.providerId) === normalizedProviderId,
    );
}

export function getRealtimeVoiceBrowserSessionBroker(
  providerId: string,
  brokerId: string,
): RealtimeVoiceBrowserSessionBroker | undefined {
  const normalizedBrokerId = normalizeOptionalLowercaseString(brokerId);
  if (!normalizedBrokerId) {
    return undefined;
  }
  return listRealtimeVoiceBrowserSessionBrokers(providerId).find(
    (broker) => normalizeOptionalLowercaseString(broker.id) === normalizedBrokerId,
  );
}
