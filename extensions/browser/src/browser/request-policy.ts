/**
 * Request policy helpers for profile-aware Browser control server routes.
 */
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

type BrowserRequestProfileParams = {
  query?: Record<string, unknown>;
  body?: unknown;
  profile?: string | null;
};

/** Normalizes route paths so mutation-policy checks compare stable slash forms. */
export function normalizeBrowserRequestPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (withLeadingSlash.length <= 1) {
    return withLeadingSlash;
  }
  return withLeadingSlash.replace(/\/+$/, "");
}

/** Returns true when a control request mutates persistent browser profile state. */
export function isPersistentBrowserProfileMutation(method: string, path: string): boolean {
  const normalizedPath = normalizeBrowserRequestPath(path);
  if (
    method === "POST" &&
    (normalizedPath === "/profiles/create" ||
      normalizedPath === "/profiles/import" ||
      normalizedPath === "/reset-profile")
  ) {
    return true;
  }
  return method === "DELETE" && /^\/profiles\/[^/]+$/.test(normalizedPath);
}

/**
 * Returns true for the system-profile cookie import route. Import must run where
 * the user's Keychain lives, so it is exempt from the host-local persistent
 * mutation block while remaining blocked over a node proxy.
 */
export function isBrowserSystemProfileImport(method: string, path: string): boolean {
  return method === "POST" && normalizeBrowserRequestPath(path) === "/profiles/import";
}

/**
 * Returns true for routes that only make sense on the host that owns the local
 * Keychain and Chrome-family profiles: system-profile listing and import. These
 * must be dispatched host-local and never proxied to a browser node.
 */
export function isBrowserHostLocalRoute(method: string, path: string): boolean {
  if (isBrowserSystemProfileImport(method, path)) {
    return true;
  }
  return method === "GET" && normalizeBrowserRequestPath(path) === "/system-profiles";
}

/** Resolves the requested profile from query, body, or route defaults. */
export function resolveRequestedBrowserProfile(
  params: BrowserRequestProfileParams,
): string | undefined {
  const queryProfile = normalizeOptionalString(params.query?.profile);
  if (queryProfile) {
    return queryProfile;
  }
  if (params.body && typeof params.body === "object") {
    const bodyProfile =
      "profile" in params.body ? normalizeOptionalString(params.body.profile) : undefined;
    if (bodyProfile) {
      return bodyProfile;
    }
  }
  return normalizeOptionalString(params.profile);
}
