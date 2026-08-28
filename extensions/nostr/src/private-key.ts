import { decode } from "nostr-tools/nip19";
import {
  hasConfiguredSecretInput,
  normalizeSecretInputString,
  type SecretInput,
} from "openclaw/plugin-sdk/secret-input";

export const NOSTR_PRIVATE_KEY_ENV_VAR = "NOSTR_PRIVATE_KEY";
// Nostr private keys are secp256k1 scalars. NIP-19 checksums alone do not
// enforce payload length or the curve's valid scalar range.
const SECP256K1_ORDER = BigInt(
  "0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141",
);

/** Validate and normalize a private key (hex or NIP-19 nsec). */
export function validatePrivateKey(key: string): Uint8Array {
  const trimmed = key.trim();
  let bytes: Uint8Array;
  if (trimmed.startsWith("nsec1") || trimmed.startsWith("NSEC1")) {
    let decoded: ReturnType<typeof decode>;
    try {
      decoded = decode(trimmed);
    } catch {
      throw new Error("Invalid nsec private key");
    }
    if (decoded.type !== "nsec") {
      throw new Error("Invalid nsec key type");
    }
    bytes = decoded.data;
  } else {
    if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
      throw new Error("Private key must be 64 hex characters or nsec bech32 format");
    }
    bytes = Uint8Array.from({ length: 32 }, (_, index) =>
      Number.parseInt(trimmed.slice(index * 2, index * 2 + 2), 16),
    );
  }
  if (bytes.length !== 32) {
    throw new Error("Private key must decode to 32 bytes");
  }
  const scalar = Array.from(bytes).reduce((value, byte) => (value << 8n) | BigInt(byte), 0n);
  if (scalar === 0n || scalar >= SECP256K1_ORDER) {
    throw new Error("Private key scalar is out of range");
  }
  return bytes;
}

export function hasConfiguredNostrPrivateKey(value: SecretInput | undefined): boolean {
  return hasConfiguredSecretInput(value) || Boolean(process.env[NOSTR_PRIVATE_KEY_ENV_VAR]?.trim());
}

export function resolveNostrPrivateKey(value: SecretInput | undefined): string {
  const configured = normalizeSecretInputString(value);
  if (configured || hasConfiguredSecretInput(value)) {
    return configured ?? "";
  }
  return process.env[NOSTR_PRIVATE_KEY_ENV_VAR]?.trim() ?? "";
}
