/**
 * Webex authentication and webhook signature verification
 *
 * Webex uses HMAC-SHA1 for webhook signature verification via the X-Spark-Signature header.
 */

import { createHmac } from "node:crypto";

/**
 * Verify a Webex webhook signature.
 *
 * Webex signs webhook payloads using HMAC-SHA1 with the webhook secret.
 * The signature is sent in the X-Spark-Signature header as a hex string.
 *
 * @param rawBody - The raw request body as a string or buffer
 * @param signature - The X-Spark-Signature header value
 * @param secret - The webhook secret configured when creating the webhook
 * @returns true if the signature is valid
 */
export function verifyWebexWebhookSignature(
  rawBody: string | Buffer,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature) {
    return false;
  }

  const expectedSignature = createHmac("sha1", secret)
    .update(rawBody)
    .digest("hex");

  // Use timing-safe comparison
  if (signature.length !== expectedSignature.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < signature.length; i++) {
    result |= signature.charCodeAt(i) ^ expectedSignature.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Parse and validate a Webex bot token.
 *
 * Bot tokens start with specific prefixes depending on the type.
 * This function performs basic validation but does not verify against the API.
 */
export function parseWebexBotToken(token: string | undefined): {
  valid: boolean;
  token?: string;
  type?: "bot" | "integration" | "guest" | "unknown";
  error?: string;
} {
  if (!token) {
    return { valid: false, error: "No token provided" };
  }

  const trimmed = token.trim();
  if (!trimmed) {
    return { valid: false, error: "Empty token" };
  }

  // Webex tokens are base64-encoded and typically quite long
  if (trimmed.length < 50) {
    return { valid: false, error: "Token appears too short" };
  }

  // Try to decode and identify token type
  // Bot tokens typically decode to JSON with type info
  try {
    // Tokens are URL-safe base64
    const decoded = Buffer.from(trimmed, "base64").toString("utf8");

    // Check for known patterns
    if (decoded.includes('"bot"')) {
      return { valid: true, token: trimmed, type: "bot" };
    }
    if (decoded.includes('"integration"')) {
      return { valid: true, token: trimmed, type: "integration" };
    }
    if (decoded.includes('"guest"')) {
      return { valid: true, token: trimmed, type: "guest" };
    }
  } catch {
    // Token might not be pure base64, that's okay
  }

  // Accept token even if we can't determine type
  return { valid: true, token: trimmed, type: "unknown" };
}

/**
 * Extract bot ID from token claims.
 *
 * Some Webex tokens contain the bot/user ID in their claims.
 * This is a best-effort extraction; use GET /people/me for authoritative info.
 */
export function extractBotIdFromToken(token: string): string | undefined {
  try {
    // Try multiple decoding approaches
    const decoded = Buffer.from(token, "base64").toString("utf8");

    // Look for machine account pattern
    const machineMatch = decoded.match(/"machineAccountUuid":\s*"([^"]+)"/);
    if (machineMatch?.[1]) {
      return machineMatch[1];
    }

    // Look for bot ID pattern
    const idMatch = decoded.match(/"id":\s*"([^"]+)"/);
    if (idMatch?.[1]) {
      return idMatch[1];
    }
  } catch {
    // Extraction failed, return undefined
  }
  return undefined;
}

/**
 * Authorization header helper
 */
export function getWebexAuthHeader(botToken: string): string {
  return `Bearer ${botToken}`;
}
