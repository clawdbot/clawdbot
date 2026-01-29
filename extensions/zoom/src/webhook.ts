import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify Zoom webhook signature using HMAC-SHA256.
 * https://developers.zoom.us/docs/api/rest/webhook-reference/#verify-webhook-events
 *
 * Zoom sends:
 * - x-zm-signature: v0=<hash>
 * - x-zm-request-timestamp: <timestamp>
 *
 * Message format: v0:<timestamp>:<payload>
 */
export function verifyZoomWebhook(params: {
  payload: string;
  signature: string;
  timestamp: string;
  secret: string;
}): boolean {
  const { payload, signature, timestamp, secret } = params;

  if (!signature || !timestamp || !secret) {
    return false;
  }

  // Build message: v0:<timestamp>:<payload>
  const message = `v0:${timestamp}:${payload}`;

  // Compute expected hash
  const hash = createHmac("sha256", secret).update(message).digest("hex");
  const expected = `v0=${hash}`;

  // Use timing-safe comparison
  try {
    const sigBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);

    if (sigBuffer.length !== expectedBuffer.length) {
      return false;
    }

    return timingSafeEqual(sigBuffer, expectedBuffer);
  } catch {
    return false;
  }
}

/**
 * Handle Zoom URL validation challenge.
 * When Zoom validates the webhook URL, it sends a challenge that must be
 * hashed and returned.
 *
 * https://developers.zoom.us/docs/api/rest/webhook-reference/#validate-your-webhook-endpoint
 */
export function handleZoomChallenge(params: {
  plainToken: string;
  secret: string;
}): { plainToken: string; encryptedToken: string } {
  const { plainToken, secret } = params;

  const encryptedToken = createHmac("sha256", secret).update(plainToken).digest("hex");

  return {
    plainToken,
    encryptedToken,
  };
}
