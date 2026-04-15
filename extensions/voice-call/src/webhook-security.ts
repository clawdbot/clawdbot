import crypto from "node:crypto";
import { safeEqualSecret } from "openclaw/plugin-sdk/browser-security-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { getHeader } from "./http-headers.js";
import type { WebhookContext } from "./types.js";

const REPLAY_WINDOW_MS = 10 * 60 * 1000;
const REPLAY_CACHE_MAX_ENTRIES = 10_000;
const REPLAY_CACHE_PRUNE_INTERVAL = 64;

type ReplayCache = {
  seenUntil: Map<string, number>;
  calls: number;
};

const twilioReplayCache: ReplayCache = {
  seenUntil: new Map<string, number>(),
  calls: 0,
};

const plivoReplayCache: ReplayCache = {
  seenUntil: new Map<string, number>(),
  calls: 0,
};

const telnyxReplayCache: ReplayCache = {
  seenUntil: new Map<string, number>(),
  calls: 0,
};

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function createSkippedVerificationReplayKey(provider: string, ctx: WebhookContext): string {
  return `${provider}:skip:${sha256Hex(`${ctx.method}\n${ctx.url}\n${ctx.rawBody}`)}`;
}

function pruneReplayCache(cache: ReplayCache, now: number): void {
  for (const [key, expiresAt] of cache.seenUntil) {
    if (expiresAt <= now) {
      cache.seenUntil.delete(key);
    }
  }
  while (cache.seenUntil.size > REPLAY_CACHE_MAX_ENTRIES) {
    const oldest = cache.seenUntil.keys().next().value;
    if (!oldest) {
      break;
    }
    cache.seenUntil.delete(oldest);
  }
}

function markReplay(cache: ReplayCache, replayKey: string): boolean {
  const now = Date.now();
  cache.calls += 1;
  if (cache.calls % REPLAY_CACHE_PRUNE_INTERVAL === 0) {
    pruneReplayCache(cache, now);
  }

  const existing = cache.seenUntil.get(replayKey);
  if (existing && existing > now) {
    return true;
  }

  cache.seenUntil.set(replayKey, now + REPLAY_WINDOW_MS);
  if (cache.seenUntil.size > REPLAY_CACHE_MAX_ENTRIES) {
    pruneReplayCache(cache, now);
  }
  return false;
}

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

  const dataToSign = buildTwilioDataToSign(url, params);

  // HMAC-SHA1 with auth token, then base64 encode
  const expectedSignature = crypto
    .createHmac("sha1", authToken)
    .update(dataToSign)
    .digest("base64");

  // Use timing-safe comparison to prevent timing attacks
  return timingSafeEqual(signature, expectedSignature);
}

function buildTwilioDataToSign(url: string, params: URLSearchParams): string {
  let dataToSign = url;
  const sortedParams = Array.from(params.entries()).toSorted((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  );
  for (const [key, value] of sortedParams) {
    dataToSign += key + value;
  }
  return dataToSign;
}

function buildCanonicalTwilioParamString(params: URLSearchParams): string {
  return Array.from(params.entries())
    .toSorted((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

/**
 * Timing-safe string comparison to prevent timing attacks.
 */
function timingSafeEqual(a: string, b: string): boolean {
  return safeEqualSecret(a, b);
}

/**
 * Configuration for secure URL reconstruction.
 */
export interface WebhookUrlOptions {
  /**
   * Whitelist of allowed hostnames. If provided, only these hosts will be
   * accepted from forwarding headers. This prevents host header injection attacks.
   *
   * SECURITY: You must provide this OR set trustForwardingHeaders=true to use
   * X-Forwarded-Host headers. Without either, forwarding headers are ignored.
   */
  allowedHosts?: string[];
  /**
   * Explicitly trust X-Forwarded-* headers without a whitelist.
   * WARNING: Only set this to true if you trust your proxy configuration
   * and understand the security implications.
   *
   * @default false
   */
  trustForwardingHeaders?: boolean;
  /**
   * List of trusted proxy IP addresses. X-Forwarded-* headers will only be
   * trusted if the request comes from one of these IPs.
   * Requires remoteIP to be set for validation.
   */
  trustedProxyIPs?: string[];
  /**
   * The IP address of the incoming request (for proxy validation).
   */
  remoteIP?: string;
}

/**
 * Validate that a hostname matches RFC 1123 format.
 * Prevents injection of malformed hostnames.
 */
function isValidHostname(hostname: string): boolean {
  if (!hostname || hostname.length > 253) {
    return false;
  }
  // RFC 1123 hostname: alphanumeric, hyphens, dots
  // Also allow ngrok/tunnel subdomains
  const hostnameRegex =
    /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
  return hostnameRegex.test(hostname);
}

/**
 * Safely extract hostname from a host header value.
 * Handles IPv6 addresses and prevents injection via malformed values.
 */
function extractHostname(hostHeader: string): string | null {
  if (!hostHeader) {
    return null;
  }

  let hostname: string;

  // Handle IPv6 addresses: [::1]:8080
  if (hostHeader.startsWith("[")) {
    const endBracket = hostHeader.indexOf("]");
    if (endBracket === -1) {
      return null; // Malformed IPv6
    }
    hostname = hostHeader.substring(1, endBracket);
    return normalizeLowercaseStringOrEmpty(hostname);
  }

  // Handle IPv4/domain with optional port
  // Check for @ which could indicate user info injection attempt
  if (hostHeader.includes("@")) {
    return null; // Reject potential injection: attacker.com:80@legitimate.com
  }

  hostname = hostHeader.split(":")[0];

  // Validate the extracted hostname
  if (!isValidHostname(hostname)) {
    return null;
  }

  return normalizeLowercaseStringOrEmpty(hostname);
}

function extractHostnameFromHeader(headerValue: string): string | null {
  const first = headerValue.split(",")[0]?.trim();
  if (!first) {
    return null;
  }
  return extractHostname(first);
}

function normalizeAllowedHosts(allowedHosts?: string[]): Set<string> | null {
  if (!allowedHosts || allowedHosts.length === 0) {
    return null;
  }
  const normalized = new Set<string>();
  for (const host of allowedHosts) {
    const extracted = extractHostname(host.trim());
    if (extracted) {
      normalized.add(extracted);
    }
  }
  return normalized.size > 0 ? normalized : null;
}

/**
 * Reconstruct the public webhook URL from request headers.
 *
 * SECURITY: This function validates host headers to prevent host header
 * injection attacks. When using forwarding headers (X-Forwarded-Host, etc.),
 * always provide allowedHosts to whitelist valid hostnames.
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
export function reconstructWebhookUrl(ctx: WebhookContext, options?: WebhookUrlOptions): string {
  const { headers } = ctx;

  // SECURITY: Only trust forwarding headers if explicitly configured.
  // Either allowedHosts must be set (for whitelist validation) or
  // trustForwardingHeaders must be true (explicit opt-in to trust).
  const allowedHosts = normalizeAllowedHosts(options?.allowedHosts);
  const hasAllowedHosts = allowedHosts !== null;
  const explicitlyTrusted = options?.trustForwardingHeaders === true;

  // Also check trusted proxy IPs if configured
  const trustedProxyIPs = options?.trustedProxyIPs?.filter(Boolean) ?? [];
  const hasTrustedProxyIPs = trustedProxyIPs.length > 0;
  const remoteIP = options?.remoteIP ?? ctx.remoteAddress;
  const fromTrustedProxy =
    !hasTrustedProxyIPs || (remoteIP ? trustedProxyIPs.includes(remoteIP) : false);

  // Only trust forwarding headers if: (has whitelist OR explicitly trusted) AND from trusted proxy
  const shouldTrustForwardingHeaders = (hasAllowedHosts || explicitlyTrusted) && fromTrustedProxy;

  const isAllowedForwardedHost = (host: string): boolean => !allowedHosts || allowedHosts.has(host);

  // Determine protocol - only trust X-Forwarded-Proto from trusted proxies
  let proto = "https";
  if (shouldTrustForwardingHeaders) {
    const forwardedProto = getHeader(headers, "x-forwarded-proto");
    if (forwardedProto === "http" || forwardedProto === "https") {
      proto = forwardedProto;
    }
  }

  // Determine host - with security validation
  let host: string | null = null;

  if (shouldTrustForwardingHeaders) {
    // Try forwarding headers in priority order
    const forwardingHeaders = ["x-forwarded-host", "x-original-host", "ngrok-forwarded-host"];

    for (const headerName of forwardingHeaders) {
      const headerValue = getHeader(headers, headerName);
      if (headerValue) {
        const extracted = extractHostnameFromHeader(headerValue);
        if (extracted && isAllowedForwardedHost(extracted)) {
          host = extracted;
          break;
        }
      }
    }
  }

  // Fallback to Host header if no valid forwarding header found
  if (!host) {
    const hostHeader = getHeader(headers, "host");
    if (hostHeader) {
      const extracted = extractHostnameFromHeader(hostHeader);
      if (extracted) {
        host = extracted;
      }
    }
  }

  // Last resort: try to extract from ctx.url
  if (!host) {
    try {
      const parsed = new URL(ctx.url);
      const extracted = extractHostname(parsed.host);
      if (extracted) {
        host = extracted;
      }
    } catch {
      // URL parsing failed - use empty string (will result in invalid URL)
      host = "";
    }
  }

  if (!host) {
    host = "";
  }

  // Extract path from the context URL (fallback to "/" on parse failure)
  let path = "/";
  try {
    const parsed = new URL(ctx.url);
    path = parsed.pathname + parsed.search;
  } catch {
    // URL parsing failed
  }

  return `${proto}://${host}${path}`;
}

function buildTwilioVerificationUrl(
  ctx: WebhookContext,
  publicUrl?: string,
  urlOptions?: WebhookUrlOptions,
): string {
  if (!publicUrl) {
    return reconstructWebhookUrl(ctx, urlOptions);
  }

  try {
    const base = new URL(publicUrl);
    const requestUrl = new URL(ctx.url);
    base.pathname = requestUrl.pathname;
    base.search = requestUrl.search;
    return base.toString();
  } catch {
    return publicUrl;
  }
}

function isLoopbackAddress(address?: string): boolean {
  if (!address) {
    return false;
  }
  if (address === "127.0.0.1" || address === "::1") {
    return true;
  }
  if (address.startsWith("::ffff:127.")) {
    return true;
  }
  return false;
}

function stripPortFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.port) {
      return url;
    }
    parsed.port = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

function setPortOnUrl(url: string, port: string): string {
  try {
    const parsed = new URL(url);
    parsed.port = port;
    return parsed.toString();
  } catch {
    return url;
  }
}

function extractPortFromHostHeader(hostHeader?: string): string | undefined {
  if (!hostHeader) {
    return undefined;
  }
  try {
    const parsed = new URL(`https://${hostHeader}`);
    return parsed.port || undefined;
  } catch {
    return undefined;
  }
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
  /** Request is cryptographically valid but was already processed recently. */
  isReplay?: boolean;
  /** Stable request identity derived from signed Twilio material. */
  verifiedRequestKey?: string;
}

export interface TelnyxVerificationResult {
  ok: boolean;
  reason?: string;
  /** Request is cryptographically valid but was already processed recently. */
  isReplay?: boolean;
  /** Stable request identity derived from signed Telnyx material. */
  verifiedRequestKey?: string;
}

function createTwilioReplayKey(params: {
  verificationUrl: string;
  signature: string;
  requestParams: URLSearchParams;
}): string {
  const canonicalParams = buildCanonicalTwilioParamString(params.requestParams);
  return `twilio:req:${sha256Hex(
    `${params.verificationUrl}\n${canonicalParams}\n${params.signature}`,
  )}`;
}

function decodeBase64OrBase64Url(input: string): Buffer {
  // Telnyx docs say Base64; some tooling emits Base64URL. Accept both.
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + "=".repeat(padLen);
  return Buffer.from(padded, "base64");
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function importEd25519PublicKey(publicKey: string): crypto.KeyObject | string {
  const trimmed = publicKey.trim();

  // PEM (spki) support.
  if (trimmed.startsWith("-----BEGIN")) {
    return trimmed;
  }

  // Base64-encoded raw Ed25519 key (32 bytes) or Base64-encoded DER SPKI key.
  const decoded = decodeBase64OrBase64Url(trimmed);
  if (decoded.length === 32) {
    // JWK is the easiest portable way to import raw Ed25519 keys in Node crypto.
    return crypto.createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: base64UrlEncode(decoded) },
      format: "jwk",
    });
  }

  return crypto.createPublicKey({
    key: decoded,
    format: "der",
    type: "spki",
  });
}

/**
 * Verify Telnyx webhook signature using Ed25519.
 *
 * Telnyx signs `timestamp|payload` and provides:
 * - `telnyx-signature-ed25519` (Base64 signature)
 * - `telnyx-timestamp` (Unix seconds)
 */
export function verifyTelnyxWebhook(
  ctx: WebhookContext,
  publicKey: string | undefined,
  options?: {
    /** Skip verification entirely (only for development) */
    skipVerification?: boolean;
    /** Maximum allowed clock skew (ms). Defaults to 5 minutes. */
    maxSkewMs?: number;
  },
): TelnyxVerificationResult {
  if (options?.skipVerification) {
    const replayKey = createSkippedVerificationReplayKey("telnyx", ctx);
    const isReplay = markReplay(telnyxReplayCache, replayKey);
    return {
      ok: true,
      reason: "verification skipped (dev mode)",
      isReplay,
      verifiedRequestKey: replayKey,
    };
  }

  if (!publicKey) {
    return { ok: false, reason: "Missing telnyx.publicKey (configure to verify webhooks)" };
  }

  const signature = getHeader(ctx.headers, "telnyx-signature-ed25519");
  const timestamp = getHeader(ctx.headers, "telnyx-timestamp");

  if (!signature || !timestamp) {
    return { ok: false, reason: "Missing signature or timestamp header" };
  }

  const eventTimeSec = parseInt(timestamp, 10);
  if (!Number.isFinite(eventTimeSec)) {
    return { ok: false, reason: "Invalid timestamp header" };
  }

  try {
    const signedPayload = `${timestamp}|${ctx.rawBody}`;
    const signatureBuffer = decodeBase64OrBase64Url(signature);
    // Canonicalize equivalent Base64/Base64URL encodings before replay hashing.
    const canonicalSignature = signatureBuffer.toString("base64");
    const key = importEd25519PublicKey(publicKey);

    const isValid = crypto.verify(null, Buffer.from(signedPayload), key, signatureBuffer);
    if (!isValid) {
      return { ok: false, reason: "Invalid signature" };
    }

    const maxSkewMs = options?.maxSkewMs ?? 5 * 60 * 1000;
    const eventTimeMs = eventTimeSec * 1000;
    const now = Date.now();
    if (Math.abs(now - eventTimeMs) > maxSkewMs) {
      return { ok: false, reason: "Timestamp too old" };
    }

    const replayKey = `telnyx:${sha256Hex(`${timestamp}\n${canonicalSignature}\n${ctx.rawBody}`)}`;
    const isReplay = markReplay(telnyxReplayCache, replayKey);
    return { ok: true, isReplay, verifiedRequestKey: replayKey };
  } catch (err) {
    return {
      ok: false,
      reason: `Verification error: ${formatErrorMessage(err)}`,
    };
  }
}

/**
 * Verify Twilio webhook with full context and detailed result.
 */
export function verifyTwilioWebhook(
  ctx: WebhookContext,
  authToken: string,
  options?: {
    /** Override the public URL (e.g., from config) */
    publicUrl?: string;
    /**
     * Allow ngrok free tier compatibility mode (loopback only).
     *
     * IMPORTANT: This does NOT bypass signature verification.
     * It only enables trusting forwarded headers on loopback so we can
     * reconstruct the public ngrok URL that Twilio used for signing.
     */
    allowNgrokFreeTierLoopbackBypass?: boolean;
    /** Skip verification entirely (only for development) */
    skipVerification?: boolean;
    /**
     * Whitelist of allowed hostnames for host header validation.
     * Prevents host header injection attacks.
     */
    allowedHosts?: string[];
    /**
     * Explicitly trust X-Forwarded-* headers without a whitelist.
     * WARNING: Only enable if you trust your proxy configuration.
     * @default false
     */
    trustForwardingHeaders?: boolean;
    /**
     * List of trusted proxy IP addresses. X-Forwarded-* headers will only
     * be trusted from these IPs.
     */
    trustedProxyIPs?: string[];
    /**
     * The remote IP address of the request (for proxy validation).
     */
    remoteIP?: string;
  },
): TwilioVerificationResult {
  // Allow skipping verification for development/testing
  if (options?.skipVerification) {
    const replayKey = createSkippedVerificationReplayKey("twilio", ctx);
    const isReplay = markReplay(twilioReplayCache, replayKey);
    return {
      ok: true,
      reason: "verification skipped (dev mode)",
      isReplay,
      verifiedRequestKey: replayKey,
    };
  }

  const signature = getHeader(ctx.headers, "x-twilio-signature");

  if (!signature) {
    return { ok: false, reason: "Missing X-Twilio-Signature header" };
  }

  const isLoopback = isLoopbackAddress(options?.remoteIP ?? ctx.remoteAddress);
  const allowLoopbackForwarding = options?.allowNgrokFreeTierLoopbackBypass && isLoopback;

  // Reconstruct the URL Twilio used
  const verificationUrl = buildTwilioVerificationUrl(ctx, options?.publicUrl, {
    allowedHosts: options?.allowedHosts,
    trustForwardingHeaders: options?.trustForwardingHeaders || allowLoopbackForwarding,
    trustedProxyIPs: options?.trustedProxyIPs,
    remoteIP: options?.remoteIP,
  });

  // Parse the body as URL-encoded params
  const params = new URLSearchParams(ctx.rawBody);

  const isValid = validateTwilioSignature(authToken, signature, verificationUrl, params);

  if (isValid) {
    const replayKey = createTwilioReplayKey({
      verificationUrl,
      signature,
      requestParams: params,
    });
    const isReplay = markReplay(twilioReplayCache, replayKey);
    return { ok: true, verificationUrl, isReplay, verifiedRequestKey: replayKey };
  }

  // Twilio webhook signatures can differ in whether port is included.
  // Retry a small, deterministic set of URL variants before failing closed.
  const variants = new Set<string>();
  variants.add(verificationUrl);
  variants.add(stripPortFromUrl(verificationUrl));

  if (options?.publicUrl) {
    try {
      const publicPort = new URL(options.publicUrl).port;
      if (publicPort) {
        variants.add(setPortOnUrl(verificationUrl, publicPort));
      }
    } catch {
      // ignore invalid publicUrl; primary verification already used best effort
    }
  }

  const hostHeaderPort = extractPortFromHostHeader(getHeader(ctx.headers, "host"));
  if (hostHeaderPort) {
    variants.add(setPortOnUrl(verificationUrl, hostHeaderPort));
  }

  for (const candidateUrl of variants) {
    if (candidateUrl === verificationUrl) {
      continue;
    }
    const isValidCandidate = validateTwilioSignature(authToken, signature, candidateUrl, params);
    if (!isValidCandidate) {
      continue;
    }
    const replayKey = createTwilioReplayKey({
      verificationUrl: candidateUrl,
      signature,
      requestParams: params,
    });
    const isReplay = markReplay(twilioReplayCache, replayKey);
    return { ok: true, verificationUrl: candidateUrl, isReplay, verifiedRequestKey: replayKey };
  }

  // Check if this is ngrok free tier - the URL might have different format
  const isNgrokFreeTier =
    verificationUrl.includes(".ngrok-free.app") || verificationUrl.includes(".ngrok.io");

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
  /** Request is cryptographically valid but was already processed recently. */
  isReplay?: boolean;
  /** Stable request identity derived from signed Plivo material. */
  verifiedRequestKey?: string;
}

function normalizeSignatureBase64(input: string): string {
  // Canonicalize base64 to match Plivo SDK behavior (decode then re-encode).
  return Buffer.from(input, "base64").toString("base64");
}

function getBaseUrlNoQuery(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}${u.pathname}`;
}

function createPlivoV2ReplayKey(url: string, nonce: string): string {
  return `plivo:v2:${sha256Hex(`${getBaseUrlNoQuery(url)}\n${nonce}`)}`;
}

function createPlivoV3ReplayKey(params: {
  method: "GET" | "POST";
  url: string;
  postParams: PlivoParamMap;
  nonce: string;
}): string {
  const baseUrl = constructPlivoV3BaseUrl({
    method: params.method,
    url: params.url,
    postParams: params.postParams,
  });
  return `plivo:v3:${sha256Hex(`${baseUrl}\n${params.nonce}`)}`;
}

function timingSafeEqualString(a: string, b: string): boolean {
  return safeEqualSecret(a, b);
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
    if (!map[key]) {
      map[key] = [];
    }
    map[key].push(value);
  }
  return map;
}

function sortedQueryString(params: PlivoParamMap): string {
  const parts: string[] = [];
  for (const key of Object.keys(params).toSorted()) {
    const values = [...params[key]].toSorted();
    for (const value of values) {
      parts.push(`${key}=${value}`);
    }
  }
  return parts.join("&");
}

function sortedParamsString(params: PlivoParamMap): string {
  const parts: string[] = [];
  for (const key of Object.keys(params).toSorted()) {
    const values = [...params[key]].toSorted();
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
  const digest = crypto.createHmac("sha256", params.authToken).update(hmacBase).digest("base64");
  const expected = normalizeSignatureBase64(digest);

  // Header can contain multiple signatures separated by commas.
  const provided = params.signatureHeader
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => normalizeSignatureBase64(s));

  for (const sig of provided) {
    if (timingSafeEqualString(expected, sig)) {
      return true;
    }
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
    /**
     * Whitelist of allowed hostnames for host header validation.
     * Prevents host header injection attacks.
     */
    allowedHosts?: string[];
    /**
     * Explicitly trust X-Forwarded-* headers without a whitelist.
     * WARNING: Only enable if you trust your proxy configuration.
     * @default false
     */
    trustForwardingHeaders?: boolean;
    /**
     * List of trusted proxy IP addresses. X-Forwarded-* headers will only
     * be trusted from these IPs.
     */
    trustedProxyIPs?: string[];
    /**
     * The remote IP address of the request (for proxy validation).
     */
    remoteIP?: string;
  },
): PlivoVerificationResult {
  if (options?.skipVerification) {
    const replayKey = createSkippedVerificationReplayKey("plivo", ctx);
    const isReplay = markReplay(plivoReplayCache, replayKey);
    return {
      ok: true,
      reason: "verification skipped (dev mode)",
      isReplay,
      verifiedRequestKey: replayKey,
    };
  }

  const signatureV3 = getHeader(ctx.headers, "x-plivo-signature-v3");
  const nonceV3 = getHeader(ctx.headers, "x-plivo-signature-v3-nonce");
  const signatureV2 = getHeader(ctx.headers, "x-plivo-signature-v2");
  const nonceV2 = getHeader(ctx.headers, "x-plivo-signature-v2-nonce");

  const reconstructed = reconstructWebhookUrl(ctx, {
    allowedHosts: options?.allowedHosts,
    trustForwardingHeaders: options?.trustForwardingHeaders,
    trustedProxyIPs: options?.trustedProxyIPs,
    remoteIP: options?.remoteIP,
  });
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
    const method = ctx.method === "GET" || ctx.method === "POST" ? ctx.method : null;

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
    if (!ok) {
      return {
        ok: false,
        version: "v3",
        verificationUrl,
        reason: "Invalid Plivo V3 signature",
      };
    }
    const replayKey = createPlivoV3ReplayKey({
      method,
      url: verificationUrl,
      postParams,
      nonce: nonceV3,
    });
    const isReplay = markReplay(plivoReplayCache, replayKey);
    return { ok: true, version: "v3", verificationUrl, isReplay, verifiedRequestKey: replayKey };
  }

  if (signatureV2 && nonceV2) {
    const ok = validatePlivoV2Signature({
      authToken,
      signature: signatureV2,
      nonce: nonceV2,
      url: verificationUrl,
    });
    if (!ok) {
      return {
        ok: false,
        version: "v2",
        verificationUrl,
        reason: "Invalid Plivo V2 signature",
      };
    }
    const replayKey = createPlivoV2ReplayKey(verificationUrl, nonceV2);
    const isReplay = markReplay(plivoReplayCache, replayKey);
    return { ok: true, version: "v2", verificationUrl, isReplay, verifiedRequestKey: replayKey };
  }

  return {
    ok: false,
    reason: "Missing Plivo signature headers (V3 or V2)",
    verificationUrl,
  };
}
