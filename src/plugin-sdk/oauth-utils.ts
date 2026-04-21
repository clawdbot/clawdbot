import { createHash, randomBytes } from "node:crypto";

/** Encode a flat object as application/x-www-form-urlencoded form data. */
export function toFormUrlEncoded(data: Record<string, string>): string {
  return Object.entries(data)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

/** Generate a PKCE verifier/challenge pair suitable for OAuth authorization flows. */
export function generatePkceVerifierChallenge(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Generate a PKCE verifier/challenge pair with a 64-character hex verifier. */
export function generateHexPkceVerifierChallenge(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("hex");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}
