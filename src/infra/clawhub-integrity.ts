import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

/** Normalizes ClawHub SHA-256 metadata into Subresource Integrity format. */
export function normalizeClawHubSha256Integrity(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const prefixedBase64 = /^sha256-([A-Za-z0-9+/]+={0,1})$/.exec(trimmed);
  if (prefixedBase64?.[1]) {
    try {
      const decoded = Buffer.from(prefixedBase64[1], "base64");
      if (decoded.length === 32) {
        return `sha256-${decoded.toString("base64")}`;
      }
    } catch {
      return null;
    }
    return null;
  }
  const prefixedHex = /^sha256:([A-Fa-f0-9]{64})$/.exec(trimmed);
  if (prefixedHex?.[1]) {
    return `sha256-${Buffer.from(prefixedHex[1], "hex").toString("base64")}`;
  }
  if (/^[A-Fa-f0-9]{64}$/.test(trimmed)) {
    return `sha256-${Buffer.from(trimmed, "hex").toString("base64")}`;
  }
  return null;
}

/** Normalizes ClawHub SHA-256 metadata into lowercase hex form. */
export function normalizeClawHubSha256Hex(value: string): string | null {
  const trimmed = value.trim();
  if (!/^[A-Fa-f0-9]{64}$/.test(trimmed)) {
    return null;
  }
  return normalizeLowercaseStringOrEmpty(trimmed);
}
