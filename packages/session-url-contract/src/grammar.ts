import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import { DEFAULT_MAIN_KEY } from "./session-key.js";

export { DEFAULT_MAIN_KEY };

const SHORT_SESSION_REF_RE = /^(?:.*-)?([0-9a-f]{8,32})$/iu;
const FIXED_RESERVED_SESSION_RESTS = new Set(["main", "global", "boot", "sessions"]);
const SESSION_SLUG_MAX_LENGTH = 48;

export function controlUiSessionSlug(displayName: string | undefined | null): string {
  // Hex-only trailing tokens would look like the URL's id suffix. Keep through
  // the last token with a non-hex letter, before truncating the display slug.
  const slug =
    (displayName ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .match(/^.*[g-z][a-z0-9]*/u)?.[0] ?? "";
  return slug.slice(0, SESSION_SLUG_MAX_LENGTH).replace(/-+$/gu, "");
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
