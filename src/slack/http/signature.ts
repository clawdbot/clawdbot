import { createHmac, timingSafeEqual } from "node:crypto";

export type VerifySlackSignatureArgs = {
  signature: string;
  timestamp: string;
  body: string;
  signingSecret: string;
};

/**
 * Verify a Slack request signature using HMAC-SHA256 and replay protection.
 */
export const verifySlackSignature = ({
  signature,
  timestamp,
  body,
  signingSecret,
}: VerifySlackSignatureArgs): boolean => {
  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) {
    return false;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (nowSeconds - timestampSeconds > 60 * 5) {
    return false;
  }

  const baseString = `v0:${timestamp}:${body}`;
  const digest = createHmac("sha256", signingSecret)
    .update(baseString)
    .digest("hex");
  const expectedSignature = `v0=${digest}`;

  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (signatureBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(signatureBuffer, expectedBuffer);
};
