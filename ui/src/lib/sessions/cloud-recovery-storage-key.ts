const CLOUD_RECOVERY_STORAGE_PREFIX = "openclaw.new-session.cloud-recovery.v1:";

export function cloudSessionRecoveryStorageKey(gatewayUrl: string, recoveryScope: string): string {
  return `${CLOUD_RECOVERY_STORAGE_PREFIX}${gatewayUrl}:${recoveryScope}`;
}
