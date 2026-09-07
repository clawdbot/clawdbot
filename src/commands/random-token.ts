/**
 * Gateway token generation helper.
 *
 * Tokens are opaque random hex strings used by setup when no explicit gateway
 * token or secret reference exists.
 */
import crypto from "node:crypto";

/** Generates a new 192-bit gateway token encoded as hex. */
export function randomToken(): string {
  return crypto.randomBytes(24).toString("hex");
}
