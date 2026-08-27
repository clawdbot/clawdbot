const RECOVERY_STORAGE_PREFIX = "openclaw.new-session.session-placement-recovery.v1:";

// Web Storage keys are JS strings, so frame UTF-16 code units directly.
// This keeps every component unambiguous without rejecting lone surrogates.
function frameSessionPlacementRecoveryStorageKeyPart(value: string): string {
  return `${value.length}:${value}`;
}

export function sessionPlacementRecoveryScopeStoragePrefix(
  gatewayUrl: string,
  recoveryScope: string,
): string {
  return `${RECOVERY_STORAGE_PREFIX}${frameSessionPlacementRecoveryStorageKeyPart(gatewayUrl)}:${frameSessionPlacementRecoveryStorageKeyPart(recoveryScope)}:`;
}

export function sessionPlacementRecoveryExactStorageKey(
  gatewayUrl: string,
  recoveryScope: string,
  sessionKey: string,
): string {
  return `${sessionPlacementRecoveryScopeStoragePrefix(gatewayUrl, recoveryScope)}${frameSessionPlacementRecoveryStorageKeyPart(sessionKey)}`;
}
