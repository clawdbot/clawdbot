import crypto from "node:crypto";

import type { WebhookContext } from "./types.js";

/**
 * Validate Twilio webhook signature using HMAC-SHA1.
 *
 * Twilio signs requests by concatenating the URL with sorted POST params,
 * then computing HMAC-SHA1 with the auth token.
 *
 * @see https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */
export function validateTwilioSignature(
  authToken: string,
  signature: string | undefined,
  url: string,
  params: URLSearchParams,
): boolean {
  if (!signature) {
    return false;
  }

  // Build the string to sign: URL + sorted params (key+value pairs)
  let dataToSign = url;

  // Sort params alphabetically and append key+value
  const sortedParams = Array.from(params.entries()).sort((a, b) =>
    a[0].localeCompare(b[0]),
  );

  for (const [key, value] of sortedParams) {
    dataToSign += key + value;
  }

  // HMAC-SHA1 with auth token, then base64 encode
  const expectedSignature = crypto
    .createHmac("sha1", authToken)
    .update(dataToSign)
    .digest("base64");

  // Use timing-safe comparison to prevent timing attacks
  return timingSafeEqual(signature, expectedSignature);
}

/**
 * Timing-safe string comparison to prevent timing attacks.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still do comparison to maintain constant time
    const dummy = Buffer.from(a);
    crypto.timingSafeEqual(dummy, dummy);
    return false;
  }

  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Reconstruct the public webhook URL from request headers.
 *
 * When behind a reverse proxy (Tailscale, nginx, ngrok), the original URL
 * used by Twilio differs from the local request URL. We use standard
 * forwarding headers to reconstruct it.
 *
 * Priority order:
 * 1. X-Forwarded-Proto + X-Forwarded-Host (standard proxy headers)
 * 2. X-Original-Host (nginx)
 * 3. Ngrok-Forwarded-Host (ngrok specific)
 * 4. Host header (direct connection)
 */
export function reconstructWebhookUrl(ctx: WebhookContext): string {
  const { headers } = ctx;

  const proto = getHeader(headers, "x-forwarded-proto") || "https";

  const forwardedHost =
    getHeader(headers, "x-forwarded-host") ||
    getHeader(headers, "x-original-host") ||
    getHeader(headers, "ngrok-forwarded-host") ||
    getHeader(headers, "host") ||
    "";

  // Extract path from the context URL (fallback to "/" on parse failure)
  let path = "/";
  try {
    const parsed = new URL(ctx.url);
    path = parsed.pathname + parsed.search;
  } catch {
    // URL parsing failed
  }

  // Remove port from host (ngrok URLs don't have ports)
  const host = forwardedHost.split(":")[0] || forwardedHost;

  return `${proto}://${host}${path}`;
}

/**
 * Get a header value, handling both string and string[] types.
 */
function getHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

/**
 * Result of Twilio webhook verification with detailed info.
 */
export interface TwilioVerificationResult {
  ok: boolean;
  reason?: string;
  /** The URL that was used for verification (for debugging) */
  verificationUrl?: string;
  /** Whether we're running behind ngrok free tier */
  isNgrokFreeTier?: boolean;
}

/**
 * Verify Twilio webhook with full context and detailed result.
 *
 * Handles the special case of ngrok free tier where signature validation
 * may fail due to URL discrepancies (ngrok adds interstitial page handling).
 */
export function verifyTwilioWebhook(
  ctx: WebhookContext,
  authToken: string,
  options?: {
    /** Override the public URL (e.g., from config) */
    publicUrl?: string;
    /** Allow ngrok free tier compatibility mode (less secure) */
    allowNgrokFreeTier?: boolean;
    /** Skip verification entirely (only for development) */
    skipVerification?: boolean;
  },
): TwilioVerificationResult {
  // Allow skipping verification for development/testing
  if (options?.skipVerification) {
    return { ok: true, reason: "verification skipped (dev mode)" };
  }

  const signature = getHeader(ctx.headers, "x-twilio-signature");

  if (!signature) {
    return { ok: false, reason: "Missing X-Twilio-Signature header" };
  }

  // Reconstruct the URL Twilio used
  const verificationUrl = options?.publicUrl || reconstructWebhookUrl(ctx);

  // Parse the body as URL-encoded params
  const params = new URLSearchParams(ctx.rawBody);

  // Validate signature
  const isValid = validateTwilioSignature(
    authToken,
    signature,
    verificationUrl,
    params,
  );

  if (isValid) {
    return { ok: true, verificationUrl };
  }

  // Check if this is ngrok free tier - the URL might have different format
  const isNgrokFreeTier =
    verificationUrl.includes(".ngrok-free.app") ||
    verificationUrl.includes(".ngrok.io");

  if (isNgrokFreeTier && options?.allowNgrokFreeTier) {
    console.warn(
      "[voice-call] Twilio signature validation failed (proceeding for ngrok free tier compatibility)",
    );
    return {
      ok: true,
      reason: "ngrok free tier compatibility mode",
      verificationUrl,
      isNgrokFreeTier: true,
    };
  }

  return {
    ok: false,
    reason: `Invalid signature for URL: ${verificationUrl}`,
    verificationUrl,
    isNgrokFreeTier,
  };
}
