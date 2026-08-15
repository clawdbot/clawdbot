// Generates and verifies pairing bearer tokens.
import { randomBytes } from "node:crypto";
import { safeEqualSecret } from "../security/secret-equal.js";

/** Random byte length for base64url device/node/bootstrap bearer tokens. */
const PAIRING_TOKEN_BYTES = 32;

/** Generate a URL-safe bearer token for pairing and bootstrap flows. */
export function generatePairingToken(): string {
  return randomBytes(PAIRING_TOKEN_BYTES).toString("base64url");
}

/** Verify nonblank pairing tokens with constant-time secret comparison. */
export function verifyPairingToken(provided: string, expected: string): boolean {
  if (provided.trim().length === 0 || expected.trim().length === 0) {
    return false;
  }
  return safeEqualSecret(provided, expected);
}
