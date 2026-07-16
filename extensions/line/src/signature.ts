import crypto from "node:crypto";

export function validateLineSignature(
  body: string,
  signature: string,
  channelSecret: string,
): boolean {
  const hash = crypto.createHmac("SHA256", channelSecret).update(body).digest("base64");
  const hashBuffer = Buffer.from(hash);
  const signatureBuffer = Buffer.from(signature);

  // Pad to equal length before constant-time comparison to prevent
  // leaking length information via early-return timing.
  const maxLen = Math.max(hashBuffer.length, signatureBuffer.length);
  const paddedHash = Buffer.alloc(maxLen);
  const paddedSig = Buffer.alloc(maxLen);
  hashBuffer.copy(paddedHash);
  signatureBuffer.copy(paddedSig);

  // Call timingSafeEqual unconditionally to ensure constant-time execution
  // regardless of length mismatch (avoids && short-circuit timing leak).
  const timingResult = crypto.timingSafeEqual(paddedHash, paddedSig);
  return hashBuffer.length === signatureBuffer.length && timingResult;
}
