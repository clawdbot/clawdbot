// Authenticated HTTP avatar serving and Gravatar proxying for durable user profiles.
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getRuntimeConfig } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  formatUserProfileAvatarEtag,
  getProfileAvatar,
  getUserProfileListItem,
  UserProfileNotFoundError,
} from "../state/user-profiles.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { sendJson, sendMethodNotAllowed } from "./http-common.js";
import {
  authorizeScopedGatewayHttpRequestOrReply,
  resolveSharedSecretHttpOperatorScopes,
} from "./http-utils.js";
import { matchUserProfileAvatarPath } from "./user-profiles-http-path.js";

const GRAVATAR_BASE_URL = "https://www.gravatar.com/avatar";
const GRAVATAR_FETCH_TIMEOUT_MS = 5_000;
// Whole-request budget shared across a profile's linked emails. Lookups run
// sequentially (see the resolution loop) so a secondary email's hash is only
// disclosed to Gravatar after the earlier one is a definite miss; this deadline
// bounds the total wait so an unreachable Gravatar cannot stall the held
// connection by GRAVATAR_FETCH_TIMEOUT_MS × linked-email-count.
const GRAVATAR_TOTAL_TIMEOUT_MS = 6_000;
const GRAVATAR_CACHE_MAX_ENTRIES = 256;
const GRAVATAR_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const GRAVATAR_HIT_TTL_MS = 24 * 60 * 60_000;
const GRAVATAR_MISS_TTL_MS = 15 * 60_000;
const MAX_GRAVATAR_BYTES = 1_000_000;
// Bound the Gravatar fan-out per avatar request. Linked emails are primary-first
// and resolved sequentially with short-circuit, so the cap only matters when
// every earlier email misses; it stops a profile with many linked addresses from
// probing an unbounded number of them against Gravatar.
const MAX_GRAVATAR_EMAIL_LOOKUPS = 8;
const GRAVATAR_MIME_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);

function resolveAvatarCorsOrigin(req: IncomingMessage, cfg: OpenClawConfig): string | undefined {
  const rawOrigin = typeof req.headers.origin === "string" ? req.headers.origin.trim() : "";
  if (!rawOrigin) {
    return undefined;
  }
  let origin: string;
  try {
    const parsed = new URL(rawOrigin);
    if (parsed.origin !== rawOrigin || parsed.username || parsed.password) {
      return undefined;
    }
    origin = parsed.origin;
  } catch {
    return undefined;
  }
  const allowed = cfg.gateway?.controlUi?.allowedOrigins ?? [];
  return allowed.some((candidate) => candidate.trim() === "*" || candidate.trim() === origin)
    ? origin
    : undefined;
}

function setAvatarCorsHeaders(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: OpenClawConfig,
): boolean {
  if (!req.headers.origin) {
    return true;
  }
  const origin = resolveAvatarCorsOrigin(req, cfg);
  if (!origin) {
    return false;
  }
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Vary", "Origin");
  return true;
}

type GravatarHit = {
  kind: "hit";
  bytes: Uint8Array;
  mime: string;
  etag: string;
};

type GravatarResult = GravatarHit | { kind: "miss" } | { kind: "error" };
type CachedGravatarResult = Exclude<GravatarResult, { kind: "error" }> & { expiresAtMs: number };

const gravatarCache = new Map<string, CachedGravatarResult>();
const gravatarRequests = new Map<string, Promise<GravatarResult>>();
let gravatarCacheBytes = 0;

function deleteCachedGravatar(hash: string): void {
  const cached = gravatarCache.get(hash);
  if (cached?.kind === "hit") {
    gravatarCacheBytes -= cached.bytes.byteLength;
  }
  gravatarCache.delete(hash);
}

function hashEmail(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

function getCachedGravatar(hash: string, nowMs: number): GravatarResult | undefined {
  const cached = gravatarCache.get(hash);
  if (!cached) {
    return undefined;
  }
  if (cached.expiresAtMs <= nowMs) {
    deleteCachedGravatar(hash);
    return undefined;
  }
  // Map insertion order is the LRU order. Promote on every hit.
  deleteCachedGravatar(hash);
  gravatarCache.set(hash, cached);
  if (cached.kind === "hit") {
    gravatarCacheBytes += cached.bytes.byteLength;
  }
  return cached.kind === "hit"
    ? { kind: "hit", bytes: cached.bytes, mime: cached.mime, etag: cached.etag }
    : { kind: "miss" };
}

function cacheGravatar(
  hash: string,
  result: Exclude<GravatarResult, { kind: "error" }>,
  nowMs: number,
) {
  const ttlMs = result.kind === "hit" ? GRAVATAR_HIT_TTL_MS : GRAVATAR_MISS_TTL_MS;
  deleteCachedGravatar(hash);
  const cached = { ...result, expiresAtMs: nowMs + ttlMs } satisfies CachedGravatarResult;
  gravatarCache.set(hash, cached);
  if (cached.kind === "hit") {
    gravatarCacheBytes += cached.bytes.byteLength;
  }
  while (
    gravatarCache.size > GRAVATAR_CACHE_MAX_ENTRIES ||
    gravatarCacheBytes > GRAVATAR_CACHE_MAX_BYTES
  ) {
    const oldest = gravatarCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    deleteCachedGravatar(oldest);
  }
}

function normalizeContentType(value: string | null): string {
  return value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

async function readBoundedGravatarBody(
  body: ReadableStream<Uint8Array> | null,
): Promise<Uint8Array | undefined> {
  if (!body) {
    return undefined;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      totalBytes += next.value.byteLength;
      if (totalBytes > MAX_GRAVATAR_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (totalBytes === 0) {
    return undefined;
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function cancelGravatarBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  try {
    await body?.cancel();
  } catch {
    // The response is already unusable; cancellation is only best-effort cleanup.
  }
}

async function fetchGravatar(
  hash: string,
  fetchImpl: typeof globalThis.fetch,
  deadline?: AbortSignal,
): Promise<GravatarResult> {
  try {
    const perCall = AbortSignal.timeout(GRAVATAR_FETCH_TIMEOUT_MS);
    const response = await fetchImpl(`${GRAVATAR_BASE_URL}/${hash}?s=256&d=404`, {
      headers: { Accept: "image/webp,image/png,image/jpeg,image/gif" },
      signal: deadline ? AbortSignal.any([deadline, perCall]) : perCall,
    });
    if (response.status === 404) {
      await cancelGravatarBody(response.body);
      return { kind: "miss" };
    }
    if (!response.ok) {
      await cancelGravatarBody(response.body);
      return { kind: "error" };
    }
    const mime = normalizeContentType(response.headers.get("content-type"));
    const declaredLength = Number(response.headers.get("content-length"));
    if (
      !GRAVATAR_MIME_TYPES.has(mime) ||
      (Number.isFinite(declaredLength) && declaredLength > MAX_GRAVATAR_BYTES)
    ) {
      await cancelGravatarBody(response.body);
      return { kind: "error" };
    }
    const bytes = await readBoundedGravatarBody(response.body);
    if (!bytes) {
      return { kind: "error" };
    }
    const etag = `"gravatar-${createHash("sha256").update(bytes).digest("hex")}"`;
    return { kind: "hit", bytes, mime, etag };
  } catch {
    return { kind: "error" };
  }
}

async function resolveGravatar(
  hash: string,
  options: { fetchImpl: typeof globalThis.fetch; nowMs: () => number; deadline?: AbortSignal },
): Promise<GravatarResult> {
  const cached = getCachedGravatar(hash, options.nowMs());
  if (cached) {
    return cached;
  }
  const inFlight = gravatarRequests.get(hash);
  if (inFlight) {
    return await inFlight;
  }
  const request = fetchGravatar(hash, options.fetchImpl, options.deadline).then((result) => {
    if (result.kind !== "error") {
      cacheGravatar(hash, result, options.nowMs());
    }
    return result;
  });
  gravatarRequests.set(hash, request);
  try {
    return await request;
  } finally {
    gravatarRequests.delete(hash);
  }
}

function sendAvatar(
  req: IncomingMessage,
  res: ServerResponse,
  avatar: { bytes: Uint8Array; mime: string; etag: string },
  cacheControl: string,
): void {
  if (ifNoneMatchMatches(req.headers["if-none-match"], avatar.etag)) {
    // Carry the success cache policy so a 304 does not inherit the miss-path
    // no-store and force the client to re-download an unchanged avatar.
    res.writeHead(304, { ETag: avatar.etag, "Cache-Control": cacheControl });
    res.end();
    return;
  }
  res.writeHead(200, {
    "Content-Type": avatar.mime,
    "Content-Length": avatar.bytes.byteLength,
    "Cache-Control": cacheControl,
    ETag: avatar.etag,
  });
  res.end(req.method === "HEAD" ? undefined : avatar.bytes);
}

/** Serves a profile avatar with the same HTTP operator auth as sibling gateway endpoints. */
export async function handleUserProfileAvatarHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  opts: {
    auth: ResolvedGatewayAuth;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
    fetchImpl?: typeof globalThis.fetch;
    nowMs?: () => number;
  },
): Promise<boolean> {
  const profileId = matchUserProfileAvatarPath(pathname);
  if (profileId === undefined) {
    return false;
  }
  const method = req.method;
  const cfg = getRuntimeConfig();
  const corsAllowed = setAvatarCorsHeaders(req, res, cfg);
  if (method === "OPTIONS") {
    if (!corsAllowed) {
      sendJson(res, 403, { ok: false, error: { type: "origin_not_allowed" } });
      return true;
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD");
    res.setHeader("Access-Control-Allow-Headers", "Authorization");
    res.setHeader("Access-Control-Max-Age", "600");
    res.writeHead(204);
    res.end();
    return true;
  }
  if (method !== "GET" && method !== "HEAD") {
    sendMethodNotAllowed(res, "GET, HEAD");
    return true;
  }
  const authResult = await authorizeScopedGatewayHttpRequestOrReply({
    req,
    res,
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
    operatorMethod: "users.list",
    resolveOperatorScopes: resolveSharedSecretHttpOperatorScopes,
  });
  if (!authResult) {
    return true;
  }
  // Avatars render as plain <img> against a stable, unversioned route, so a
  // heuristically-cached 404 miss would otherwise hide a later uploaded image.
  // Misses must never be cached; the 200 path overrides this with must-revalidate.
  res.setHeader("Cache-Control", "no-store");
  let uploadedAvatar: ReturnType<typeof getProfileAvatar>;
  try {
    uploadedAvatar = getProfileAvatar(profileId);
  } catch (error) {
    if (error instanceof UserProfileNotFoundError) {
      sendJson(res, 404, { ok: false, error: { type: "not_found" } });
      return true;
    }
    sendJson(res, 500, { ok: false, error: { type: "profile_lookup_failed" } });
    return true;
  }
  if (uploadedAvatar) {
    sendAvatar(
      req,
      res,
      {
        bytes: uploadedAvatar.bytes,
        mime: uploadedAvatar.mime,
        etag: formatUserProfileAvatarEtag(uploadedAvatar.sha256, uploadedAvatar.mime),
      },
      "private, max-age=0, must-revalidate",
    );
    return true;
  }

  let hashes: string[];
  try {
    hashes = getUserProfileListItem(profileId)
      .emails.slice(0, MAX_GRAVATAR_EMAIL_LOOKUPS)
      .map(hashEmail);
  } catch (error) {
    if (error instanceof UserProfileNotFoundError) {
      sendJson(res, 404, { ok: false, error: { type: "not_found" } });
      return true;
    }
    sendJson(res, 500, { ok: false, error: { type: "profile_lookup_failed" } });
    return true;
  }

  // Resolve linked emails sequentially and stop at the first hit: the primary
  // email keeps precedence, and a secondary email's hash is disclosed to
  // Gravatar only once the earlier one is a definite miss. A single shared
  // deadline bounds the total wait, so an unreachable Gravatar cannot stall the
  // held connection by one timeout per linked email.
  const deadline = AbortSignal.timeout(GRAVATAR_TOTAL_TIMEOUT_MS);
  let transientFailure = false;
  for (const hash of hashes) {
    const result = await resolveGravatar(hash, {
      fetchImpl: opts.fetchImpl ?? globalThis.fetch,
      nowMs: opts.nowMs ?? Date.now,
      deadline,
    });
    if (result.kind === "hit") {
      sendAvatar(req, res, result, "private, max-age=0, must-revalidate");
      return true;
    }
    transientFailure ||= result.kind === "error";
    if (deadline.aborted) {
      break;
    }
  }
  sendJson(res, transientFailure ? 502 : 404, {
    ok: false,
    error: { type: transientFailure ? "avatar_upstream_unavailable" : "not_found" },
  });
  return true;
}

// RFC 9110 §13.1.2 weak comparison: wildcard, comma-separated lists, and W/ prefixes
// all revalidate; exact-string matching alone would miss proxy-normalized headers.
function ifNoneMatchMatches(header: string | string[] | undefined, etag: string): boolean {
  const value = Array.isArray(header) ? header.join(",") : header;
  if (!value) {
    return false;
  }
  return value.split(",").some((candidate) => {
    const tag = candidate.trim();
    return tag === "*" || tag === etag || (tag.startsWith("W/") && tag.slice(2) === etag);
  });
}
