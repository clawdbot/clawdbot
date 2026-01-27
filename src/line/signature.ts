import crypto from "node:crypto";

export function validateLineSignature(
  body: string,
  signature: string,
  channelSecret: string,
): boolean {
  const hash = crypto.createHmac("SHA256", channelSecret).update(body).digest("base64");
  const hashBuffer = Buffer.from(hash);
  const signatureBuffer = Buffer.from(signature);

  // Use constant-time comparison to prevent timing attacks.
  if (hashBuffer.length !== signatureBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(hashBuffer, signatureBuffer);
}
