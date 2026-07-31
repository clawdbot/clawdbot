import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

function normalizeBrowserProxyPath(value: string): string {
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

function isPersistentBrowserProxyMutation(method: string, path: string): boolean {
  const normalizedPath = normalizeBrowserProxyPath(path);
  if (
    method === "POST" &&
    (normalizedPath === "/profiles/create" || normalizedPath === "/reset-profile")
  ) {
    return true;
  }
  return method === "DELETE" && /^\/profiles\/[^/]+$/.test(normalizedPath);
}

export function isForbiddenBrowserProxyMutation(params: unknown): boolean {
  if (!params || typeof params !== "object") {
    return false;
  }
  const candidate = params as { method?: unknown; path?: unknown };
  const method = (normalizeOptionalString(candidate.method) ?? "").toUpperCase();
  const path = normalizeOptionalString(candidate.path) ?? "";
  return Boolean(method && path && isPersistentBrowserProxyMutation(method, path));
}
