// Provides secure random ids and bounded random numbers.
import { randomBytes, randomInt, randomUUID } from "node:crypto";

/** Generates a cryptographically secure UUID for runtime ids and cache keys. */
export function generateSecureUuid(): string {
  return randomUUID();
}

/** Generates a URL-safe cryptographic token from the requested byte count. */
export function generateSecureToken(bytes = 16): string {
  return randomBytes(bytes).toString("base64url");
}

/** Generates a hex-encoded cryptographic token from the requested byte count. */
export function generateSecureHex(bytes = 16): string {
  return randomBytes(bytes).toString("hex");
}

/** Returns a cryptographically secure fraction in the range [0, 1). */
export function generateSecureFraction(): number {
  return randomBytes(4).readUInt32BE(0) / 0x1_0000_0000;
}

/** Generates a cryptographically secure integer in `[0, maxExclusive)`. */
export function generateSecureInt(maxExclusive: number): number;
/** Generates a cryptographically secure integer in `[minInclusive, maxExclusive)`. */
export function generateSecureInt(minInclusive: number, maxExclusive: number): number;
export function generateSecureInt(a: number, b?: number): number {
  return typeof b === "number" ? randomInt(a, b) : randomInt(a);
}
