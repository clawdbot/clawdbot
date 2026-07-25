// Control UI module implements open external url behavior.
import { normalizeLowercaseStringOrEmpty } from "./string-coerce.ts";

const DATA_URL_PREFIX = "data:";
const ALLOWED_EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "blob:"]);
const BLOCKED_DATA_IMAGE_MIME_TYPES = new Set(["image/svg+xml"]);

function isAllowedDataImageUrl(url: string): boolean {
  if (!normalizeLowercaseStringOrEmpty(url).startsWith(DATA_URL_PREFIX)) {
    return false;
  }

  const commaIndex = url.indexOf(",");
  if (commaIndex < DATA_URL_PREFIX.length) {
    return false;
  }

  const metadata = url.slice(DATA_URL_PREFIX.length, commaIndex);
  const mimeType = normalizeLowercaseStringOrEmpty(metadata.split(";")[0]);
  if (!mimeType.startsWith("image/")) {
    return false;
  }

  return !BLOCKED_DATA_IMAGE_MIME_TYPES.has(mimeType);
}

type ResolveSafeExternalUrlOptions = {
  allowDataImage?: boolean;
};

export function resolveSafeExternalUrl(
  rawUrl: string,
  baseHref: string,
  opts: ResolveSafeExternalUrlOptions = {},
): string | null {
  const candidate = rawUrl.trim();
  if (!candidate) {
    return null;
  }

  if (opts.allowDataImage === true && isAllowedDataImageUrl(candidate)) {
    return candidate;
  }

  if (normalizeLowercaseStringOrEmpty(candidate).startsWith(DATA_URL_PREFIX)) {
    return null;
  }

  try {
    const parsed = new URL(candidate, baseHref);
    return ALLOWED_EXTERNAL_PROTOCOLS.has(normalizeLowercaseStringOrEmpty(parsed.protocol))
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

type OpenExternalUrlSafeOptions = ResolveSafeExternalUrlOptions & {
  baseHref?: string;
};

export function reserveExternalWindowForDeferredNavigation(): WindowProxy | null {
  // Reserve while user activation is live, then detach the opener before any
  // caller-controlled URL can be loaded into the new browsing context.
  const opened = window.open("about:blank", "_blank");
  if (opened) {
    opened.opener = null;
  }
  return opened;
}

export function openExternalUrlSafe(
  rawUrl: string,
  opts: OpenExternalUrlSafeOptions = {},
): WindowProxy | null {
  const baseHref = opts.baseHref ?? window.location.href;
  const safeUrl = resolveSafeExternalUrl(rawUrl, baseHref, opts);
  if (!safeUrl) {
    return null;
  }

  const opened = window.open(safeUrl, "_blank", "noopener,noreferrer");
  if (opened) {
    opened.opener = null;
  }
  return opened;
}
