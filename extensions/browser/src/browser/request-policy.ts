import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

type BrowserRequestProfileParams = {
  query?: Record<string, unknown>;
  body?: unknown;
  profile?: string | null;
};

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

export function isPersistentBrowserProfileMutation(method: string, path: string): boolean {
  const normalizedPath = normalizeBrowserRequestPath(path);
  if (
    method === "POST" &&
    (normalizedPath === "/profiles/create" || normalizedPath === "/reset-profile")
  ) {
    return true;
  }
  return method === "DELETE" && /^\/profiles\/[^/]+$/.test(normalizedPath);
}

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
