// Control UI module implements uuid behavior.
type CryptoLike = {
  randomUUID?: (() => string) | undefined;
  getRandomValues?: (<T extends Exclude<BufferSource, ArrayBuffer>>(array: T) => T) | undefined;
};

let warnedWeakCrypto = false;

function uuidFromBytes(bytes: Uint8Array): string {
  const versionByte = bytes[6];
  const variantByte = bytes[8];
  if (versionByte === undefined || variantByte === undefined) {
    throw new Error("UUID byte buffer is shorter than 9 bytes");
  }
  bytes[6] = (versionByte & 0x0f) | 0x40; // version 4
  bytes[8] = (variantByte & 0x3f) | 0x80; // variant 1

  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20)}`;
}

function warnWeakCryptoOnce() {
  if (warnedWeakCrypto) {
    return;
  }
  warnedWeakCrypto = true;
  console.warn("[uuid] crypto API missing; refusing insecure UUID generation");
}

export function generateUUID(cryptoLike: CryptoLike | null = globalThis.crypto): string {
  if (cryptoLike && typeof cryptoLike.randomUUID === "function") {
    return cryptoLike.randomUUID();
  }

  if (cryptoLike && typeof cryptoLike.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    cryptoLike.getRandomValues(bytes);
    return uuidFromBytes(bytes);
  }

  warnWeakCryptoOnce();
  throw new Error("Web Crypto is required for UUID generation");
}
