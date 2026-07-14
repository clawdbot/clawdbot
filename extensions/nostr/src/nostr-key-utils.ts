// Nostr helper module supports nostr key utils behavior.
import { getPublicKey, nip19 } from "nostr-tools";

/**
 * Validate and normalize a private key (accepts hex or nsec format)
 */
export function validatePrivateKey(key: string): Uint8Array {
  const trimmed = key.trim();

  // Handle nsec (bech32) format
  if (trimmed.startsWith("nsec1")) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== "nsec") {
      throw new Error("Invalid nsec key: wrong type");
    }
    return decoded.data;
  }

  // Handle hex format
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new Error("Private key must be 64 hex characters or nsec bech32 format");
  }

  // Convert hex string to Uint8Array
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number.parseInt(trimmed.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Get public key from private key (hex or nsec format)
 */
export function getPublicKeyFromPrivate(privateKey: string): string {
  const sk = validatePrivateKey(privateKey);
  return getPublicKey(sk);
}

/**
 * Normalize a pubkey to hex format (accepts npub or hex)
 */
export function normalizePubkey(input: string): string {
  const trimmed = input.trim();

  // npub format - decode to hex
  if (trimmed.startsWith("npub1")) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== "npub" || typeof decoded.data !== "string") {
      throw new Error("Invalid npub key");
    }
    // nip19.decode(npub).data is already the hex pubkey (string), not Uint8Array.
    return decoded.data.toLowerCase();
  }

  // Already hex - validate and return lowercase
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new Error("Pubkey must be 64 hex characters or npub format");
  }
  return trimmed.toLowerCase();
}
