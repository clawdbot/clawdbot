import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { base64url, equalBytes, fromBase64url } from "./encoding.js";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export interface FriendCode {
  code: string;
  expiry: number;
  nonce: string;
}

export function mintFriendCode(
  deviceSecret: Uint8Array,
  options: { expiry: number; nonce?: Uint8Array; rng?: (length: number) => Uint8Array },
): FriendCode {
  if (deviceSecret.length < 32) {
    throw new Error("invalid friend code input");
  }
  const nonce = options.nonce ?? (options.rng ?? randomBytes)(16);
  if (!Number.isSafeInteger(options.expiry) || options.expiry < 0 || nonce.length < 8) {
    throw new Error("invalid friend code input");
  }
  const digest = friendCodeDigest(deviceSecret, options.expiry, nonce);
  return { code: crockford40(digest), expiry: options.expiry, nonce: base64url(nonce) };
}

export function verifyFriendCode(
  code: FriendCode,
  deviceSecret: Uint8Array,
  options: { now?: number; clockSkewSeconds?: number } = {},
): boolean {
  if (deviceSecret.length < 32) {
    return false;
  }
  try {
    const now = options.now ?? Math.floor(Date.now() / 1000);
    if (code.expiry + (options.clockSkewSeconds ?? 0) < now) {
      return false;
    }
    const expected = mintFriendCode(deviceSecret, {
      expiry: code.expiry,
      nonce: fromBase64url(code.nonce),
    });
    return equalBytes(
      new TextEncoder().encode(expected.code),
      new TextEncoder().encode(code.code.toUpperCase()),
    );
  } catch {
    return false;
  }
}

function friendCodeDigest(secret: Uint8Array, expiry: number, nonce: Uint8Array): Uint8Array {
  const input = new Uint8Array(8 + nonce.length);
  new DataView(input.buffer).setBigUint64(0, BigInt(expiry), false);
  input.set(nonce, 8);
  return hmac(sha256, secret, input);
}

function crockford40(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes.slice(0, 5)) {
    value = (value << 8n) | BigInt(byte);
  }
  let output = "";
  for (let index = 0; index < 8; index++) {
    output = CROCKFORD[Number(value & 31n)]! + output;
    value >>= 5n;
  }
  return output;
}
