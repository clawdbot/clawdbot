import { randomBytes } from "@noble/hashes/utils.js";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export interface UlidFactoryOptions {
  clock?: () => number;
  rng?: (length: number) => Uint8Array;
}

export function createMonotonicUlidFactory(options: UlidFactoryOptions = {}): () => string {
  const clock = options.clock ?? Date.now;
  const rng = options.rng ?? randomBytes;
  let lastTime = -1;
  let randomness = new Uint8Array(10);
  return () => {
    const now = Math.floor(clock());
    if (!Number.isSafeInteger(now) || now < 0 || now > 0xffffffffffff) {
      throw new Error("invalid ULID clock");
    }
    if (now > lastTime) {
      const generated = rng(10);
      if (generated.length !== 10) {
        throw new Error("invalid ULID rng");
      }
      randomness = generated.slice();
      lastTime = now;
    } else {
      increment(randomness);
    }
    return encodeTime(lastTime) + encodeRandom(randomness);
  };
}

function increment(value: Uint8Array): void {
  for (let index = value.length - 1; index >= 0; index--) {
    value[index] = (value[index]! + 1) & 0xff;
    if (value[index] !== 0) {
      return;
    }
  }
  throw new Error("ULID monotonic overflow");
}

function encodeTime(time: number): string {
  let value = BigInt(time);
  let output = "";
  for (let index = 0; index < 10; index++) {
    output = CROCKFORD[Number(value & 31n)]! + output;
    value >>= 5n;
  }
  return output;
}

function encodeRandom(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  let output = "";
  for (let index = 0; index < 16; index++) {
    output = CROCKFORD[Number(value & 31n)]! + output;
    value >>= 5n;
  }
  return output;
}
