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

// -----------------------------------------------------------------------------
// Plivo webhook verification
// -----------------------------------------------------------------------------

/**
 * Result of Plivo webhook verification with detailed info.
 */
export interface PlivoVerificationResult {
  ok: boolean;
  reason?: string;
  verificationUrl?: string;
  /** Signature version used for verification */
  version?: "v3" | "v2";
}

function normalizeSignatureBase64(input: string): string {
  // Canonicalize base64 to match Plivo SDK behavior (decode then re-encode).
  return Buffer.from(input, "base64").toString("base64");
}

function getBaseUrlNoQuery(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}${u.pathname}`;
}

function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) {
    const dummy = Buffer.from(a);
    crypto.timingSafeEqual(dummy, dummy);
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function validatePlivoV2Signature(params: {
  authToken: string;
  signature: string;
  nonce: string;
  url: string;
}): boolean {
  const baseUrl = getBaseUrlNoQuery(params.url);
  const digest = crypto
    .createHmac("sha256", params.authToken)
    .update(baseUrl + params.nonce)
    .digest("base64");
  const expected = normalizeSignatureBase64(digest);
  const provided = normalizeSignatureBase64(params.signature);
  return timingSafeEqualString(expected, provided);
}

type PlivoParamMap = Record<string, string[]>;

function toParamMapFromSearchParams(sp: URLSearchParams): PlivoParamMap {
  const map: PlivoParamMap = {};
  for (const [key, value] of sp.entries()) {
    if (!map[key]) map[key] = [];
    map[key].push(value);
  }
  return map;
}

function sortedQueryString(params: PlivoParamMap): string {
  const parts: string[] = [];
  for (const key of Object.keys(params).sort()) {
    const values = [...params[key]].sort();
    for (const value of values) {
      parts.push(`${key}=${value}`);
    }
  }
  return parts.join("&");
}

function sortedParamsString(params: PlivoParamMap): string {
  const parts: string[] = [];
  for (const key of Object.keys(params).sort()) {
    const values = [...params[key]].sort();
    for (const value of values) {
      parts.push(`${key}${value}`);
    }
  }
  return parts.join("");
}

function constructPlivoV3BaseUrl(params: {
  method: "GET" | "POST";
  url: string;
  postParams: PlivoParamMap;
}): string {
  const hasPostParams = Object.keys(params.postParams).length > 0;
  const u = new URL(params.url);
  const baseNoQuery = `${u.protocol}//${u.host}${u.pathname}`;

  const queryMap = toParamMapFromSearchParams(u.searchParams);
  const queryString = sortedQueryString(queryMap);

  // In the Plivo V3 algorithm, the query portion is always sorted, and if we
  // have POST params we add a '.' separator after the query string.
  let baseUrl = baseNoQuery;
  if (queryString.length > 0 || hasPostParams) {
    baseUrl = `${baseNoQuery}?${queryString}`;
  }
  if (queryString.length > 0 && hasPostParams) {
    baseUrl = `${baseUrl}.`;
  }

  if (params.method === "GET") {
    return baseUrl;
  }

  return baseUrl + sortedParamsString(params.postParams);
}

function validatePlivoV3Signature(params: {
  authToken: string;
  signatureHeader: string;
  nonce: string;
  method: "GET" | "POST";
  url: string;
  postParams: PlivoParamMap;
}): boolean {
  const baseUrl = constructPlivoV3BaseUrl({
    method: params.method,
    url: params.url,
    postParams: params.postParams,
  });

  const hmacBase = `${baseUrl}.${params.nonce}`;
  const digest = crypto
    .createHmac("sha256", params.authToken)
    .update(hmacBase)
    .digest("base64");
  const expected = normalizeSignatureBase64(digest);

  // Header can contain multiple signatures separated by commas.
  const provided = params.signatureHeader
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => normalizeSignatureBase64(s));

  for (const sig of provided) {
    if (timingSafeEqualString(expected, sig)) return true;
  }
  return false;
}

/**
 * Verify Plivo webhooks using V3 signature if present; fall back to V2.
 *
 * Header names (case-insensitive; Node provides lower-case keys):
 * - V3: X-Plivo-Signature-V3 / X-Plivo-Signature-V3-Nonce
 * - V2: X-Plivo-Signature-V2 / X-Plivo-Signature-V2-Nonce
 */
export function verifyPlivoWebhook(
  ctx: WebhookContext,
  authToken: string,
  options?: {
    /** Override the public URL origin (host) used for verification */
    publicUrl?: string;
    /** Skip verification entirely (only for development) */
    skipVerification?: boolean;
  },
): PlivoVerificationResult {
  if (options?.skipVerification) {
    return { ok: true, reason: "verification skipped (dev mode)" };
  }

  const signatureV3 = getHeader(ctx.headers, "x-plivo-signature-v3");
  const nonceV3 = getHeader(ctx.headers, "x-plivo-signature-v3-nonce");
  const signatureV2 = getHeader(ctx.headers, "x-plivo-signature-v2");
  const nonceV2 = getHeader(ctx.headers, "x-plivo-signature-v2-nonce");

  const reconstructed = reconstructWebhookUrl(ctx);
  let verificationUrl = reconstructed;
  if (options?.publicUrl) {
    try {
      const req = new URL(reconstructed);
      const base = new URL(options.publicUrl);
      base.pathname = req.pathname;
      base.search = req.search;
      verificationUrl = base.toString();
    } catch {
      verificationUrl = reconstructed;
    }
  }

  if (signatureV3 && nonceV3) {
    const method =
      ctx.method === "GET" || ctx.method === "POST" ? ctx.method : null;

    if (!method) {
      return {
        ok: false,
        version: "v3",
        verificationUrl,
        reason: `Unsupported HTTP method for Plivo V3 signature: ${ctx.method}`,
      };
    }

    const postParams = toParamMapFromSearchParams(new URLSearchParams(ctx.rawBody));
    const ok = validatePlivoV3Signature({
      authToken,
      signatureHeader: signatureV3,
      nonce: nonceV3,
      method,
      url: verificationUrl,
      postParams,
    });
    return ok
      ? { ok: true, version: "v3", verificationUrl }
      : {
          ok: false,
          version: "v3",
          verificationUrl,
          reason: "Invalid Plivo V3 signature",
        };
  }

  if (signatureV2 && nonceV2) {
    const ok = validatePlivoV2Signature({
      authToken,
      signature: signatureV2,
      nonce: nonceV2,
      url: verificationUrl,
    });
    return ok
      ? { ok: true, version: "v2", verificationUrl }
      : {
          ok: false,
          version: "v2",
          verificationUrl,
          reason: "Invalid Plivo V2 signature",
        };
  }

  return {
    ok: false,
    reason: "Missing Plivo signature headers (V3 or V2)",
    verificationUrl,
  };
}
