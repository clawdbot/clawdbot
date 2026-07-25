import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";

const SECRET_SENTINEL_PREFIX = "oc-sent-v2.";
const SECRET_SENTINEL_SUFFIX = ".end";
const SECRET_SENTINEL_SOURCE = "oc-sent-v2\\.[A-Za-z0-9_-]+\\.end";
const SECRET_SENTINEL_CIPHER = "aes-256-gcm";
const SECRET_SENTINEL_NONCE_BYTES = 12;
const SECRET_SENTINEL_SCOPE_BYTES = 8;
const SECRET_SENTINEL_TAG_BYTES = 16;
const SECRET_SENTINEL_HEADER_BYTES =
  SECRET_SENTINEL_SCOPE_BYTES + SECRET_SENTINEL_NONCE_BYTES + SECRET_SENTINEL_TAG_BYTES;

export const SECRET_SENTINEL_PATTERN = new RegExp(SECRET_SENTINEL_SOURCE, "g");

// One process key keeps sentinels resolvable for in-flight requests without a
// plaintext registry that retains every historical credential until exit.
const secretSentinelKeys = randomBytes(64);
const secretSentinelCipherKey = secretSentinelKeys.subarray(0, 32);
const secretSentinelNonceKey = secretSentinelKeys.subarray(32);

function secretSentinelsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const configured = env.OPENCLAW_SECRET_SENTINELS?.trim().toLowerCase();
  return configured !== "off" && configured !== "0" && configured !== "false";
}

export function looksLikeSecretSentinel(value: string): boolean {
  return new RegExp(`^${SECRET_SENTINEL_SOURCE}$`).test(value);
}

export function containsSecretSentinel(value: string): boolean {
  return value.includes(SECRET_SENTINEL_PREFIX);
}

function secretSentinelScope(label: string): Buffer {
  return createHash("sha256").update(label).digest().subarray(0, SECRET_SENTINEL_SCOPE_BYTES);
}

/** Seals a secret into authenticated ciphertext that only this process can resolve. */
export function mintSecretSentinel(value: string, meta: { label: string }): string {
  registerSecretValueForRedaction(value);
  if (!secretSentinelsEnabled()) {
    return value;
  }
  const scope = secretSentinelScope(meta.label);
  // A keyed nonce preserves the old stable-by-value-and-label behavior without
  // retaining a reverse plaintext map. Different plaintexts collide only at
  // the 96-bit HMAC truncation boundary.
  const nonce = createHmac("sha256", secretSentinelNonceKey)
    .update(scope)
    .update(value)
    .digest()
    .subarray(0, SECRET_SENTINEL_NONCE_BYTES);
  const cipher = createCipheriv(SECRET_SENTINEL_CIPHER, secretSentinelCipherKey, nonce);
  cipher.setAAD(scope);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const sealed = Buffer.concat([scope, nonce, cipher.getAuthTag(), ciphertext]);
  return `${SECRET_SENTINEL_PREFIX}${sealed.toString("base64url")}${SECRET_SENTINEL_SUFFIX}`;
}

/** Opens a process-local sentinel and rejects malformed or tampered values. */
export function resolveSecretSentinel(sentinel: string): string | undefined {
  if (!looksLikeSecretSentinel(sentinel)) {
    return undefined;
  }
  try {
    const encoded = sentinel.slice(SECRET_SENTINEL_PREFIX.length, -SECRET_SENTINEL_SUFFIX.length);
    const sealed = Buffer.from(encoded, "base64url");
    if (sealed.length < SECRET_SENTINEL_HEADER_BYTES) {
      return undefined;
    }
    const scope = sealed.subarray(0, SECRET_SENTINEL_SCOPE_BYTES);
    const nonce = sealed.subarray(
      SECRET_SENTINEL_SCOPE_BYTES,
      SECRET_SENTINEL_SCOPE_BYTES + SECRET_SENTINEL_NONCE_BYTES,
    );
    const tagStart = SECRET_SENTINEL_SCOPE_BYTES + SECRET_SENTINEL_NONCE_BYTES;
    const tag = sealed.subarray(tagStart, tagStart + SECRET_SENTINEL_TAG_BYTES);
    const ciphertext = sealed.subarray(SECRET_SENTINEL_HEADER_BYTES);
    const decipher = createDecipheriv(SECRET_SENTINEL_CIPHER, secretSentinelCipherKey, nonce);
    decipher.setAAD(scope);
    decipher.setAuthTag(tag);
    const value = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    // Refresh the bounded redaction registry whenever a live sentinel is used.
    registerSecretValueForRedaction(value);
    return value;
  } catch {
    return undefined;
  }
}

/** Swaps every known sentinel substring and reports unknown sentinel-shaped values. */
export function swapSecretSentinelsInText(text: string): { text: string; unknown: string[] } {
  if (!containsSecretSentinel(text)) {
    return { text, unknown: [] };
  }
  const unknown = new Set<string>();
  const swapped = text.replace(new RegExp(SECRET_SENTINEL_SOURCE, "g"), (sentinel) => {
    const value = resolveSecretSentinel(sentinel);
    if (value === undefined) {
      unknown.add(sentinel);
      return sentinel;
    }
    return value;
  });
  return { text: swapped, unknown: [...unknown] };
}
