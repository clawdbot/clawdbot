import net from "node:net";
import { isPrivateOrLoopbackIpAddress } from "../shared/net/ip.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../shared/string-coerce.js";
import { isLoopbackHost, normalizeHostHeader, resolveHostName } from "./net.js";

type OriginCheckResult =
  | {
      ok: true;
      matchedBy: "allowlist" | "host-header-fallback" | "private-same-origin" | "local-loopback";
    }
  | { ok: false; reason: string };

function parseOrigin(
  originRaw?: string,
): { origin: string; host: string; hostname: string } | null {
  const trimmed = (originRaw ?? "").trim();
  if (!trimmed || trimmed === "null") {
    return null;
  }
  try {
    const url = new URL(trimmed);
    return {
      origin: normalizeLowercaseStringOrEmpty(url.origin),
      host: normalizeLowercaseStringOrEmpty(url.host),
      hostname: normalizeLowercaseStringOrEmpty(url.hostname),
    };
  } catch {
    return null;
  }
}

export function checkBrowserOrigin(params: {
  requestHost?: string;
  origin?: string;
  allowedOrigins?: string[];
  allowHostHeaderOriginFallback?: boolean;
  isLocalClient?: boolean;
}): OriginCheckResult {
  const parsedOrigin = parseOrigin(params.origin);
  if (!parsedOrigin) {
    return { ok: false, reason: "origin missing or invalid" };
  }

  const allowlist = new Set(
    (params.allowedOrigins ?? [])
      .map((value) => normalizeOptionalLowercaseString(value))
      .filter(Boolean),
  );
  if (allowlist.has("*") || allowlist.has(parsedOrigin.origin)) {
    return { ok: true, matchedBy: "allowlist" };
  }

  const requestHost = normalizeHostHeader(params.requestHost);
  if (
    params.allowHostHeaderOriginFallback === true &&
    requestHost &&
    parsedOrigin.host === requestHost
  ) {
    return { ok: true, matchedBy: "host-header-fallback" };
  }
  if (
    requestHost &&
    parsedOrigin.host === requestHost &&
    isTrustedSameOriginHost(requestHost, params.isLocalClient)
  ) {
    return { ok: true, matchedBy: "private-same-origin" };
  }

  // Dev fallback only for genuinely local socket clients, not Host-header claims.
  if (params.isLocalClient && isLoopbackHost(parsedOrigin.hostname)) {
    return { ok: true, matchedBy: "local-loopback" };
  }

  return { ok: false, reason: "origin not allowed" };
}

function isTrustedSameOriginHost(hostHeader: string, isLocalClient?: boolean): boolean {
  const hostname = resolveHostName(hostHeader);
  if (!hostname) {
    return false;
  }
  if (isLoopbackHost(hostname)) {
    return isLocalClient !== false;
  }
  if (net.isIP(hostname) !== 0) {
    return isPrivateOrLoopbackIpAddress(hostname);
  }
  return hostname.endsWith(".local") || hostname.endsWith(".ts.net");
}
