import { normalizeStoreSessionKey } from "./store-entry.js";

export type SessionMaintenancePreserveKeysProvider = () => Iterable<string> | undefined;

const preserveKeysProviders = new Set<SessionMaintenancePreserveKeysProvider>();

export function registerSessionMaintenancePreserveKeysProvider(
  provider: SessionMaintenancePreserveKeysProvider,
): () => void {
  preserveKeysProviders.add(provider);
  return () => {
    preserveKeysProviders.delete(provider);
  };
}

function addSessionMaintenancePreserveKey(keys: Set<string>, value: string | undefined): void {
  // Match how store keys are normalized in `normalizeStoreSessionKey`
  // (trim + lowercase) so providers can register session keys in any
  // case without missing matches during maintenance lookups.
  const normalized = normalizeStoreSessionKey(value ?? "");
  if (normalized) {
    keys.add(normalized);
  }
}

function addSessionMaintenancePreserveKeys(
  keys: Set<string>,
  values: Iterable<string | undefined> | undefined,
): void {
  for (const value of values ?? []) {
    addSessionMaintenancePreserveKey(keys, value);
  }
}

export function collectSessionMaintenancePreserveKeys(
  baseKeys?: Iterable<string | undefined>,
): Set<string> | undefined {
  const keys = new Set<string>();
  addSessionMaintenancePreserveKeys(keys, baseKeys);
  for (const provider of preserveKeysProviders) {
    try {
      addSessionMaintenancePreserveKeys(keys, provider());
    } catch {
      // Maintenance must remain best-effort if a runtime provider is temporarily unavailable.
    }
  }
  return keys.size > 0 ? keys : undefined;
}
