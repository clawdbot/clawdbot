/** Stable degraded-owner id for one configured web provider surface. */
export function runtimeWebSecretOwnerId(kind: "search" | "fetch", providerId: string): string {
  return `web-${kind}:${providerId}`;
}
