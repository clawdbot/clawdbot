// Qa Lab plugin module implements qa credentials fingerprint behavior.
import { createHash } from "node:crypto";

export function fingerprintQaCredentialId(credentialId: string | undefined) {
  if (!credentialId) {
    return undefined;
  }
  const digest = createHash("sha256").update(credentialId).digest("hex").slice(0, 16);
  return `sha256:${digest}`;
}
