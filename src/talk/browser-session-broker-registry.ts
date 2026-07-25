import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { RealtimeVoiceBrowserSessionBroker } from "./provider-types.js";

type BrowserSessionBrokerRegistryState = {
  brokersByKey: Map<string, RealtimeVoiceBrowserSessionBroker>;
};

const BROWSER_SESSION_BROKER_REGISTRY_KEY = Symbol.for(
  "openclaw.realtimeVoiceBrowserSessionBrokerRegistry",
);

function resolveRegistryState(): BrowserSessionBrokerRegistryState {
  const processStore = process as NodeJS.Process & Record<PropertyKey, unknown>;
  const existing = processStore[BROWSER_SESSION_BROKER_REGISTRY_KEY];
  if (existing) {
    return existing as BrowserSessionBrokerRegistryState;
  }
  const created = resolveGlobalSingleton(BROWSER_SESSION_BROKER_REGISTRY_KEY, () => ({
    brokersByKey: new Map(),
  }));
  // Plugin packages can be evaluated in separate Jiti contexts while sharing one process.
  processStore[BROWSER_SESSION_BROKER_REGISTRY_KEY] = created;
  return created;
}

function normalizeBrokerKey(providerId: string, brokerId: string): string | undefined {
  const provider = normalizeOptionalLowercaseString(providerId);
  const broker = normalizeOptionalLowercaseString(brokerId);
  return provider && broker ? `${provider}:${broker}` : undefined;
}

export function registerRealtimeVoiceBrowserSessionBroker(
  broker: RealtimeVoiceBrowserSessionBroker,
): () => void {
  const key = normalizeBrokerKey(broker.providerId, broker.id);
  if (!key) {
    throw new Error("Realtime voice browser-session broker requires id and providerId");
  }
  const normalized = {
    ...broker,
    id: normalizeOptionalLowercaseString(broker.id)!,
    providerId: normalizeOptionalLowercaseString(broker.providerId)!,
  };
  const state = resolveRegistryState();
  state.brokersByKey.set(key, normalized);
  return () => {
    if (state.brokersByKey.get(key) === normalized) {
      state.brokersByKey.delete(key);
    }
  };
}

export function getRealtimeVoiceBrowserSessionBroker(
  providerId: string,
  brokerId: string,
): RealtimeVoiceBrowserSessionBroker | undefined {
  const key = normalizeBrokerKey(providerId, brokerId);
  return key ? resolveRegistryState().brokersByKey.get(key) : undefined;
}
