import { createHmac, randomBytes } from "node:crypto";
import type { NextcloudTalkWebhookHeaders } from "./types.js";

const SIGNATURE_HEADER = "x-nextcloud-talk-signature";
const RANDOM_HEADER = "x-nextcloud-talk-random";
const BACKEND_HEADER = "x-nextcloud-talk-backend";

function normalizeLowercaseStringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * Verify the HMAC-SHA256 signature of an incoming webhook request.
 * Signature is calculated as: HMAC-SHA256(random + body, secret)
 */
export function verifyNextcloudTalkSignature(params: {
  signature: string;
  random: string;
  body: string;
  secret: string;
}): boolean {
  const { signature, random, body, secret } = params;
  if (!signature || !random || !secret) {
    return false;
  }

  const expected = createHmac("sha256", secret)
    .update(random + body)
    .digest("hex");

  if (signature.length !== expected.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < signature.length; i++) {
    result |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Extract webhook headers from an incoming request.
 */
export function extractNextcloudTalkHeaders(
  headers: Record<string, string | string[] | undefined>,
): NextcloudTalkWebhookHeaders | null {
  const getHeader = (name: string): string | undefined => {
    const value = headers[name] ?? headers[normalizeLowercaseStringOrEmpty(name)];
    return Array.isArray(value) ? value[0] : value;
  };

  const signature = getHeader(SIGNATURE_HEADER);
  const random = getHeader(RANDOM_HEADER);
  const backend = getHeader(BACKEND_HEADER);

  if (!signature || !random || !backend) {
    return null;
  }

  return { signature, random, backend };
}

/**
 * Generate signature headers for an outbound request to Nextcloud Talk.
 */
export function generateNextcloudTalkSignature(params: { body: string; secret: string }): {
  random: string;
  signature: string;
} {
  const { body, secret } = params;
  const random = randomBytes(32).toString("hex");
  const signature = createHmac("sha256", secret)
    .update(random + body)
    .digest("hex");
  return { random, signature };
}
