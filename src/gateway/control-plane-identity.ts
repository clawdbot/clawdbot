/** Normalizes an optional control-plane identity field without creating empty keys. */
export function normalizeControlPlaneIdentityPart(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}
