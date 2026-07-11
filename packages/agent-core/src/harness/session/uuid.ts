// Agent Core module implements uuid behavior.
let lastTimestamp = -Infinity;
let sequence = 0;

// Small UUIDv7 generator for browser/node package builds without a runtime dep.
function fillRandomBytes(bytes: Uint8Array): void {
  const crypto = globalThis.crypto;
  if (crypto?.getRandomValues) {
    crypto.getRandomValues(bytes as Uint8Array<ArrayBuffer>);
    return;
  }
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
}

/** Generate a monotonic UUIDv7 string. */
export function uuidv7(): string {
  const random = new Uint8Array(16);
  fillRandomBytes(random);
  const timestamp = Date.now();

  if (timestamp > lastTimestamp) {
    sequence = new DataView(random.buffer, random.byteOffset + 6, 4).getUint32(0);
    lastTimestamp = timestamp;
  } else {
    // Same-ms calls increment the sequence so generated ids remain sortable and
    // unique even when random bytes repeat.
    sequence = (sequence + 1) >>> 0;
    if (sequence === 0) {
      lastTimestamp++;
    }
  }

  const bytes = new Uint8Array(16);
  bytes[0] = (lastTimestamp / 0x10000000000) & 0xff;
  bytes[1] = (lastTimestamp / 0x100000000) & 0xff;
  bytes[2] = (lastTimestamp / 0x1000000) & 0xff;
  bytes[3] = (lastTimestamp / 0x10000) & 0xff;
  bytes[4] = (lastTimestamp / 0x100) & 0xff;
  bytes[5] = lastTimestamp & 0xff;
  bytes[6] = 0x70 | ((sequence >>> 28) & 0x0f);
  bytes[7] = (sequence >>> 20) & 0xff;
  bytes[8] = 0x80 | ((sequence >>> 14) & 0x3f);
  bytes[9] = (sequence >>> 6) & 0xff;
  const randomLowBits = random.at(10);
  if (randomLowBits === undefined) {
    throw new Error("UUID random buffer is shorter than 11 bytes");
  }
  bytes[10] = ((sequence & 0x3f) << 2) | (randomLowBits & 0x03);
  bytes.set(random.subarray(11), 11);

  return formatUuid(bytes);
}

function formatUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}
