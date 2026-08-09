const CLOUD_RECOVERY_STORAGE_PREFIX = "openclaw.new-session.cloud-recovery.v1:";

export function cloudSessionRecoveryStorageKey(gatewayUrl: string, recoveryScope: string): string {
  return `${CLOUD_RECOVERY_STORAGE_PREFIX}${gatewayUrl}:${recoveryScope}`;
}

export function hasCloudSessionRecovery(gatewayUrl: string, recoveryScope: string): boolean {
  if (!gatewayUrl || !recoveryScope) {
    return false;
  }
  try {
    return (
      globalThis.sessionStorage?.getItem(
        cloudSessionRecoveryStorageKey(gatewayUrl, recoveryScope),
      ) !== null
    );
  } catch {
    return false;
  }
}
