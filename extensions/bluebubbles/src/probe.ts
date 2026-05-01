import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { createBlueBubblesClientFromParts } from "./client.js";
import type { BaseProbeResult } from "./runtime-api.js";
import { normalizeSecretInputString } from "./secret-input.js";

export type BlueBubblesProbe = BaseProbeResult & {
  status?: number | null;
};

type BlueBubblesServerInfo = {
  os_version?: string;
  server_version?: string;
  private_api?: boolean;
  helper_connected?: boolean;
  proxy_service?: string;
  detected_icloud?: string;
  computer_id?: string;
};

/** Cache server info by account ID to avoid repeated API calls.
 * Size-capped to prevent unbounded growth (#4948). */
const MAX_SERVER_INFO_CACHE_SIZE = 64;
const serverInfoCache = new Map<string, { info: BlueBubblesServerInfo; expires: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Fetch server info from BlueBubbles API and cache it.
 * Returns cached result if available and not expired.
 */
export async function fetchBlueBubblesServerInfo(params: {
  baseUrl?: string | null;
  password?: string | null;
  accountId?: string;
  timeoutMs?: number;
  allowPrivateNetwork?: boolean;
}): Promise<BlueBubblesServerInfo | null> {
  const baseUrl = normalizeSecretInputString(params.baseUrl);
  const password = normalizeSecretInputString(params.password);
  if (!baseUrl || !password) {
    return null;
  }

  const cacheKey = normalizeOptionalString(params.accountId) || "default";
  const cached = serverInfoCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return cached.info;
  }

  const client = createBlueBubblesClientFromParts({
    baseUrl,
    password,
    allowPrivateNetwork: params.allowPrivateNetwork === true,
    timeoutMs: params.timeoutMs ?? 5000,
  });
  try {
    const res = await client.getServerInfo({ timeoutMs: params.timeoutMs ?? 5000 });
    if (!res.ok) {
      return null;
    }
    const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const data = payload?.data as BlueBubblesServerInfo | undefined;
    if (data) {
      serverInfoCache.set(cacheKey, { info: data, expires: Date.now() + CACHE_TTL_MS });
      // Evict oldest entries if cache exceeds max size
      if (serverInfoCache.size > MAX_SERVER_INFO_CACHE_SIZE) {
        const oldest = serverInfoCache.keys().next().value;
        if (oldest !== undefined) {
          serverInfoCache.delete(oldest);
        }
      }
    }
    return data ?? null;
  } catch {
    return null;
  }
}

/**
 * Get cached server info synchronously (for use in describeMessageTool).
 * Returns null if not cached or expired.
 */
function getCachedBlueBubblesServerInfo(accountId?: string): BlueBubblesServerInfo | null {
  const cacheKey = normalizeOptionalString(accountId) || "default";
  const cached = serverInfoCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return cached.info;
  }
  return null;
}

/**
 * Read cached private API capability for a BlueBubbles account.
 * Returns null when capability is unknown (for example, before first probe).
 */
export function getCachedBlueBubblesPrivateApiStatus(accountId?: string): boolean | null {
  const info = getCachedBlueBubblesServerInfo(accountId);
  if (!info || typeof info.private_api !== "boolean") {
    return null;
  }
  return info.private_api;
}

export function isBlueBubblesPrivateApiStatusEnabled(status: boolean | null): boolean {
  return status === true;
}

export function isBlueBubblesPrivateApiEnabled(accountId?: string): boolean {
  return isBlueBubblesPrivateApiStatusEnabled(getCachedBlueBubblesPrivateApiStatus(accountId));
}

/**
 * Parse macOS version string (e.g., "15.0.1" or "26.0") into major version number.
 */
function parseMacOSMajorVersion(version?: string | null): number | null {
  if (!version) {
    return null;
  }
  const match = /^(\d+)/.exec(version.trim());
  return match ? Number.parseInt(match[1], 10) : null;
}

/**
 * Check if the cached server info indicates macOS 26 or higher.
 * Returns false if no cached info is available (fail open for action listing).
 */
export function isMacOS26OrHigher(accountId?: string): boolean {
  const info = getCachedBlueBubblesServerInfo(accountId);
  if (!info?.os_version) {
    return false;
  }
  const major = parseMacOSMajorVersion(info.os_version);
  return major !== null && major >= 26;
}

export async function probeBlueBubbles(params: {
  baseUrl?: string | null;
  password?: string | null;
  timeoutMs?: number;
  allowPrivateNetwork?: boolean;
}): Promise<BlueBubblesProbe> {
  const baseUrl = normalizeSecretInputString(params.baseUrl);
  const password = normalizeSecretInputString(params.password);
  if (!baseUrl) {
    return { ok: false, error: "serverUrl not configured" };
  }
  if (!password) {
    return { ok: false, error: "password not configured" };
  }
  const client = createBlueBubblesClientFromParts({
    baseUrl,
    password,
    allowPrivateNetwork: params.allowPrivateNetwork === true,
    timeoutMs: params.timeoutMs,
  });
  try {
    const res = await client.ping({ timeoutMs: params.timeoutMs });
    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return {
      ok: false,
      status: null,
      error: formatErrorMessage(err),
    };
  }
}
