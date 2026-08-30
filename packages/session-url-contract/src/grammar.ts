import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";

export const DEFAULT_MAIN_KEY = "main";

const SHORT_SESSION_REF_RE = /^(?:.*-)?([0-9a-f]{8,32})$/iu;
const FIXED_RESERVED_SESSION_RESTS = new Set(["main", "global", "boot", "sessions"]);
const SESSION_SLUG_MAX_LENGTH = 48;

export function controlUiSessionSlug(displayName: string | undefined | null): string {
  const tokens = (displayName ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .split("-")
    .filter(Boolean);
  while (tokens.length > 0 && /^[0-9a-f]+$/u.test(tokens.at(-1) ?? "")) {
    tokens.pop();
  }
  return tokens.join("-").slice(0, SESSION_SLUG_MAX_LENGTH).replace(/-+$/gu, "");
}

export function normalizeControlUiBasePath(basePath?: string): string {
  const trimmed = basePath?.trim().replace(/^\/+|\/+$/gu, "") ?? "";
  return trimmed ? `/${trimmed}` : "";
}

export function isReservedSessionRest(rest: string, mainKey?: string): boolean {
  const normalized = rest.toLowerCase();
  const configuredMainKey = normalizeNullableString(mainKey)?.toLowerCase() ?? DEFAULT_MAIN_KEY;
  return FIXED_RESERVED_SESSION_RESTS.has(normalized) || normalized === configuredMainKey;
}

export function parseShortSessionRef(
  sessionRef: string,
): { shortId: string; slugHint?: string } | null {
  const shortId = sessionRef.match(SHORT_SESSION_REF_RE)?.[1]?.toLowerCase();
  if (!shortId) {
    return null;
  }
  const slugHint = sessionRef.slice(0, sessionRef.length - shortId.length).replace(/-+$/u, "");
  return slugHint ? { shortId, slugHint } : { shortId };
}
