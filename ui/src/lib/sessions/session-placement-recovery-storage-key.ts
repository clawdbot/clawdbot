const RECOVERY_STORAGE_PREFIX = "openclaw.new-session.session-placement-recovery.v1:";

// Web Storage keys are JS strings, so frame UTF-16 code units directly.
// This keeps every component unambiguous without rejecting lone surrogates.
export function sessionPlacementRecoveryScopeStoragePrefix(
  gatewayUrl: string,
  recoveryScope: string,
): string {
  return `${RECOVERY_STORAGE_PREFIX}${gatewayUrl.length}:${gatewayUrl}:${recoveryScope.length}:${recoveryScope}:`;
}

export function sessionPlacementRecoveryExactStorageKey(
  gatewayUrl: string,
  recoveryScope: string,
  sessionKey: string,
): string {
  return `${sessionPlacementRecoveryScopeStoragePrefix(gatewayUrl, recoveryScope)}${sessionKey.length}:${sessionKey}`;
}

// Enumerate scope ownership without loading payload validators into the startup graph.
export function listSessionPlacementRecoveryStorageKeys(
  gatewayUrl: string,
  recoveryScope: string,
): string[] {
  try {
    const storage = globalThis.sessionStorage;
    const prefix = sessionPlacementRecoveryScopeStoragePrefix(gatewayUrl, recoveryScope);
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(prefix)) {
        keys.push(key);
      }
    }
    return keys.toSorted();
  } catch {
    return [];
  }
}
