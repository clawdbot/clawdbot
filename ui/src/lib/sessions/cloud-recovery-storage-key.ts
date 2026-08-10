const CLOUD_RECOVERY_LEGACY_STORAGE_PREFIX = "openclaw.new-session.cloud-recovery.v1:";
const CLOUD_RECOVERY_STORAGE_PREFIX = "openclaw.new-session.cloud-recovery.v2:";

// Web Storage keys are JS strings, so frame UTF-16 code units directly.
// This keeps every component unambiguous without rejecting lone surrogates.
function frameCloudRecoveryStorageKeyPart(value: string): string {
  return `${value.length}:${value}`;
}

export function cloudSessionRecoveryLegacyStorageKey(
  gatewayUrl: string,
  recoveryScope: string,
): string {
  return `${CLOUD_RECOVERY_LEGACY_STORAGE_PREFIX}${gatewayUrl}:${recoveryScope}`;
}

export function cloudSessionRecoveryScopeStoragePrefix(
  gatewayUrl: string,
  recoveryScope: string,
): string {
  return `${CLOUD_RECOVERY_STORAGE_PREFIX}${frameCloudRecoveryStorageKeyPart(gatewayUrl)}:${frameCloudRecoveryStorageKeyPart(recoveryScope)}:`;
}

export function cloudSessionRecoveryExactStorageKey(
  gatewayUrl: string,
  recoveryScope: string,
  sessionKey: string,
): string {
  return `${cloudSessionRecoveryScopeStoragePrefix(gatewayUrl, recoveryScope)}${frameCloudRecoveryStorageKeyPart(sessionKey)}`;
}
