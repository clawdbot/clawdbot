import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { NextcloudTalkWebhookHeaders } from "./types.js";

const SIGNATURE_HEADER = "x-nextcloud-talk-signature";
const RANDOM_HEADER = "x-nextcloud-talk-random";
const BACKEND_HEADER = "x-nextcloud-talk-backend";

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

  const expectedBuf = Buffer.from(expected, "utf8");
  const signatureBuf = Buffer.from(signature, "utf8");

  // Pad to equal length before constant-time comparison to prevent
  // leaking length information via early-return timing.
  // Note: digest("hex") always produces lowercase ASCII (64 bytes for SHA-256),
  // so expectedBuf is always 64 bytes — no variable-length concern on the expected side.
  const maxLen = Math.max(expectedBuf.length, signatureBuf.length);
  const paddedExpected = Buffer.alloc(maxLen);
  const paddedSignature = Buffer.alloc(maxLen);
  expectedBuf.copy(paddedExpected);
  signatureBuf.copy(paddedSignature);

  // Use crypto.timingSafeEqual instead of manual XOR loop to avoid
  // potential JIT-optimisation timing leaks in the JavaScript engine.
  const timingResult = timingSafeEqual(paddedExpected, paddedSignature);
  return expectedBuf.length === signatureBuf.length && timingResult;
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
