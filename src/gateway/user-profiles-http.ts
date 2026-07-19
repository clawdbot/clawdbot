// Authenticated HTTP avatar serving for durable user profiles.
import type { IncomingMessage, ServerResponse } from "node:http";
import { formatUserProfileAvatarEtag, getProfileAvatar } from "../state/user-profiles.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { sendJson, sendMethodNotAllowed } from "./http-common.js";
import {
  authorizeScopedGatewayHttpRequestOrReply,
  resolveSharedSecretHttpOperatorScopes,
} from "./http-utils.js";
import { matchUserProfileAvatarPath } from "./user-profiles-http-path.js";

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
  },
): Promise<boolean> {
  const profileId = matchUserProfileAvatarPath(pathname);
  if (profileId === undefined) {
    return false;
  }
  const method = req.method;
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
  const avatar = getProfileAvatar(profileId);
  if (!avatar) {
    sendJson(res, 404, { ok: false, error: { type: "not_found" } });
    return true;
  }
  const etag = formatUserProfileAvatarEtag(avatar.sha256, avatar.mime);
  if (ifNoneMatchMatches(req.headers["if-none-match"], etag)) {
    res.writeHead(304, { ETag: etag });
    res.end();
    return true;
  }
  res.writeHead(200, {
    "Content-Type": avatar.mime,
    "Content-Length": avatar.bytes.byteLength,
    "Cache-Control": "private, max-age=0, must-revalidate",
    ETag: etag,
  });
  res.end(method === "HEAD" ? undefined : avatar.bytes);
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
