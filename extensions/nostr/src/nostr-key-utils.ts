import { decode } from "nostr-tools/nip19";
import { getPublicKey } from "nostr-tools/pure";
import { validatePrivateKey } from "./private-key.js";

export { validatePrivateKey };

export function getPublicKeyFromPrivate(privateKey: string): string {
  return getPublicKey(validatePrivateKey(privateKey));
}

export function normalizePubkey(input: string): string {
  const trimmed = input.trim();

  if (trimmed.startsWith("npub1") || trimmed.startsWith("NPUB1")) {
    const decoded = decode(trimmed);
    if (decoded.type !== "npub" || typeof decoded.data !== "string") {
      throw new Error("Invalid npub key");
    }
    // nip19.decode(npub).data is already the hex pubkey (string), not Uint8Array.
    return decoded.data.toLowerCase();
  }

  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new Error("Pubkey must be 64 hex characters or npub format");
  }
  return trimmed.toLowerCase();
}
