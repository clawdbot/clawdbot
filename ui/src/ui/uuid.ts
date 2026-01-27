export type CryptoLike = {
  randomUUID?: (() => string) | undefined;
  getRandomValues?: ((array: Uint8Array) => Uint8Array) | undefined;
};

let warnedWeakCrypto = false;

function uuidFromBytes(bytes: Uint8Array): string {
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1

  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20)}`;
}

function weakRandomBytes(): Uint8Array {
  const bytes = new Uint8Array(16);
  const now = Date.now();
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[0] ^= now & 0xff;
  bytes[1] ^= (now >>> 8) & 0xff;
  bytes[2] ^= (now >>> 16) & 0xff;
  bytes[3] ^= (now >>> 24) & 0xff;
  return bytes;
}

function warnWeakCryptoOnce() {
  if (warnedWeakCrypto) return;
  warnedWeakCrypto = true;
  console.warn("[uuid] crypto API missing; falling back to weak randomness");
}

export function generateUUID(cryptoLike: CryptoLike | null = globalThis.crypto): string {
  if (cryptoLike && typeof cryptoLike.randomUUID === "function") return cryptoLike.randomUUID();

  if (cryptoLike && typeof cryptoLike.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    cryptoLike.getRandomValues(bytes);
    return uuidFromBytes(bytes);
  }

  warnWeakCryptoOnce();
  return uuidFromBytes(weakRandomBytes());
}
