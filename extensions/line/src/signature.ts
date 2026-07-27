// Line plugin module implements signature behavior.
import crypto from "node:crypto";
import { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";

export function validateLineSignature(
  body: string,
  signature: string,
  channelSecret: string,
): boolean {
  const hash = crypto.createHmac("SHA256", channelSecret).update(body).digest("base64");
  return safeEqualSecret(signature, hash);
}
