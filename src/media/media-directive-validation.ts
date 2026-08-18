// Shared MEDIA path/URL validation helpers (split from parse.ts for max-lines).
import {
  extractEmbeddedIpv4FromIpv6,
  isBlockedSpecialUseIpv4Address,
  isBlockedSpecialUseIpv6Address,
  isCanonicalDottedDecimalIPv4,
  isIpv4Address,
  isLegacyIpv4Literal,
  parseCanonicalIpAddress,
  parseLooseIpAddress,
} from "@openclaw/net-policy/ip";
import { hasHttpUrlPrefix } from "@openclaw/net-policy/url-protocol";

/** Captures legacy MEDIA: attachment directives from model/tool output. */
export const MEDIA_TOKEN_RE = /\bMEDIA:\s*`?([^\n]+)`?/gi;

export const FILE_URL_PREFIX_RE = /^file:(?:\/\/)?/i;

/** Converts file URLs into plain local paths before downstream media validation. */
export function normalizeMediaSource(src: string): string {
  return src.replace(FILE_URL_PREFIX_RE, "");
}

const TRAILING_SERIALIZED_JSON_AFTER_EXT_RE = /^(.*\.\w{1,10})\\?"(?=[\]},:]|$).*/s;

export function cleanCandidate(raw: string) {
  const stripped = raw.replace(/^[`"'[{(]+/, "").replace(/[`"'\\})\],]+$/, "");
  const jsonSuffixMatch = TRAILING_SERIALIZED_JSON_AFTER_EXT_RE.exec(stripped);
  return jsonSuffixMatch?.[1] ?? stripped;
}

const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/;
const MEDIA_SOURCE_ROOT_RE = /^(?:[a-z]:[\\/]|[/~]|\.{1,2}[\\/]|\\\\)/i;
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const HAS_FILE_EXT = /\.\w{1,10}$/;

// Matches ".." as a standalone path segment (start, middle, or end).
const TRAVERSAL_SEGMENT_RE = /(?:^|[/\\])\.\.(?:[/\\]|$)/;

function isSupportedHomeRelativePath(candidate: string): boolean {
  return candidate.startsWith("~/") || candidate.startsWith("~\\");
}

function hasTraversalOrUnsupportedHomeDirPrefix(candidate: string): boolean {
  return (
    candidate.startsWith("../") ||
    candidate === ".." ||
    (candidate.startsWith("~") && !isSupportedHomeRelativePath(candidate)) ||
    TRAVERSAL_SEGMENT_RE.test(candidate)
  );
}

// Broad structural check: does this look like a local file path? Used only for
// stripping MEDIA: lines from output text — never for media approval.
export function looksLikeLocalFilePath(candidate: string): boolean {
  return (
    candidate.startsWith("/") ||
    candidate.startsWith("./") ||
    candidate.startsWith("../") ||
    candidate.startsWith("~") ||
    WINDOWS_DRIVE_RE.test(candidate) ||
    candidate.startsWith("\\\\") ||
    (!SCHEME_RE.test(candidate) && (candidate.includes("/") || candidate.includes("\\")))
  );
}

// Recognize safe local file path patterns for media approval, rejecting
// traversal and unsupported home-dir paths so they never reach downstream load/send logic.
function isLikelyLocalPath(candidate: string): boolean {
  if (hasTraversalOrUnsupportedHomeDirPrefix(candidate)) {
    return false;
  }
  return (
    candidate.startsWith("/") ||
    candidate.startsWith("./") ||
    isSupportedHomeRelativePath(candidate) ||
    WINDOWS_DRIVE_RE.test(candidate) ||
    candidate.startsWith("\\\\") ||
    (!SCHEME_RE.test(candidate) && (candidate.includes("/") || candidate.includes("\\")))
  );
}

function normalizeRemoteMediaHostname(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
  if (normalized.split(".").some((label) => label.length === 0)) {
    return "";
  }
  return normalized;
}

function isBlockedRemoteMediaHostname(hostname: string): boolean {
  const normalized = normalizeRemoteMediaHostname(hostname);
  if (!normalized) {
    return true;
  }
  if (!normalized.includes(".")) {
    return true;
  }
  if (
    normalized === "localhost" ||
    normalized === "localhost.localdomain" ||
    normalized === "metadata.google.internal" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal")
  ) {
    return true;
  }

  const strictIp = parseCanonicalIpAddress(normalized);
  if (strictIp) {
    if (isIpv4Address(strictIp)) {
      return isBlockedSpecialUseIpv4Address(strictIp);
    }
    if (isBlockedSpecialUseIpv6Address(strictIp)) {
      return true;
    }
    const embeddedIpv4 = extractEmbeddedIpv4FromIpv6(strictIp);
    return embeddedIpv4 ? isBlockedSpecialUseIpv4Address(embeddedIpv4) : false;
  }

  if (normalized.includes(":") && !parseLooseIpAddress(normalized)) {
    return true;
  }
  return !isCanonicalDottedDecimalIPv4(normalized) && isLegacyIpv4Literal(normalized);
}

function isAllowedRemoteMediaUrl(candidate: string): boolean {
  try {
    const parsed = new URL(candidate);
    return (
      parsed.protocol === "https:" &&
      !parsed.username &&
      !parsed.password &&
      !isBlockedRemoteMediaHostname(parsed.hostname)
    );
  } catch {
    return false;
  }
}

export function isValidMedia(
  candidate: string,
  opts?: { allowSpaces?: boolean; allowBareFilename?: boolean },
) {
  if (!candidate) {
    return false;
  }
  if (candidate.length > 4096) {
    return false;
  }
  if (!opts?.allowSpaces && /\s/.test(candidate)) {
    return false;
  }
  if (hasHttpUrlPrefix(candidate)) {
    return isAllowedRemoteMediaUrl(candidate);
  }

  if (isLikelyLocalPath(candidate)) {
    return true;
  }

  // Hard reject traversal/unsupported home-dir patterns before the bare-filename fallback
  // to prevent path traversal bypasses (e.g. "../../.env" matching HAS_FILE_EXT).
  if (hasTraversalOrUnsupportedHomeDirPrefix(candidate)) {
    return false;
  }

  // Accept bare filenames (e.g. "image.png") only when the caller opts in.
  // This avoids treating space-split path fragments as separate media items.
  if (opts?.allowBareFilename && !SCHEME_RE.test(candidate) && HAS_FILE_EXT.test(candidate)) {
    return true;
  }

  return false;
}

function beginsIndependentMediaSource(raw: string): boolean {
  const candidate = normalizeMediaSource(cleanCandidate(raw));
  return MEDIA_SOURCE_ROOT_RE.test(candidate) || SCHEME_RE.test(candidate);
}

function splitUnquotedMediaDirectiveParts(payload: string): string[] {
  const parts: string[] = [];
  let previousEnd = 0;
  for (const match of payload.matchAll(/\S+/g)) {
    const candidate = normalizeMediaSource(cleanCandidate(match[0]));
    const previous = parts.at(-1);
    const previousCandidate = previous ? normalizeMediaSource(cleanCandidate(previous)) : "";
    if (
      MEDIA_SOURCE_ROOT_RE.test(previousCandidate) &&
      !beginsIndependentMediaSource(candidate) &&
      (!HAS_FILE_EXT.test(previousCandidate) || !isValidMedia(candidate))
    ) {
      // Preserve real filename whitespace while keeping independently valid attachments separate.
      parts[parts.length - 1] = `${previous}${payload.slice(previousEnd, match.index)}${match[0]}`;
    } else {
      parts.push(match[0]);
    }
    previousEnd = match.index + match[0].length;
  }
  return parts;
}

export function unwrapQuoted(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return undefined;
  }
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (first !== last) {
    return undefined;
  }
  if (first !== `"` && first !== "'" && first !== "`") {
    return undefined;
  }
  return trimmed.slice(1, -1).trim();
}

/**
 * Resolve a single MEDIA: payload the same way the unfenced parser does.
 * Returns accepted local/remote media sources, or null when nothing is acceptable.
 * Shared by extraction and fenced-skip diagnostics (#41966) so policy cannot drift.
 */
export function resolveMediaDirectivePayload(payload: string): {
  media: string[];
  invalidParts: string[];
  looksLikeLocalPath: boolean;
} | null {
  const unwrapped = unwrapQuoted(payload);
  const payloadValue = unwrapped ?? payload;
  const parts = unwrapped ? [unwrapped] : splitUnquotedMediaDirectiveParts(payload);
  const media: string[] = [];
  let validCount = 0;
  const invalidParts: string[] = [];
  let hasValidMedia = false;

  for (const part of parts) {
    const candidate = normalizeMediaSource(cleanCandidate(part));
    if (isValidMedia(candidate, unwrapped || /\s/.test(part) ? { allowSpaces: true } : undefined)) {
      media.push(candidate);
      hasValidMedia = true;
      validCount += 1;
    } else if (!/\s/.test(part) || !hasTraversalOrUnsupportedHomeDirPrefix(candidate)) {
      invalidParts.push(part);
    }
  }

  const trimmedPayload = payloadValue.trim();
  const looksLikeLocalPath =
    looksLikeLocalFilePath(trimmedPayload) || FILE_URL_PREFIX_RE.test(trimmedPayload);

  if (
    !unwrapped &&
    validCount === 1 &&
    invalidParts.length > 0 &&
    !parts.slice(1).some(beginsIndependentMediaSource) &&
    /\s/.test(payloadValue) &&
    looksLikeLocalPath
  ) {
    const fallback = normalizeMediaSource(cleanCandidate(payloadValue));
    if (isValidMedia(fallback, { allowSpaces: true })) {
      media.splice(0, media.length, fallback);
      hasValidMedia = true;
      invalidParts.length = 0;
    }
  }

  if (!hasValidMedia && !unwrapped && /\s/.test(payloadValue)) {
    const spacedFallback = normalizeMediaSource(cleanCandidate(payloadValue));
    if (isValidMedia(spacedFallback, { allowSpaces: true, allowBareFilename: true })) {
      media.splice(0, media.length, spacedFallback);
      hasValidMedia = true;
      invalidParts.length = 0;
    }
  }

  if (!hasValidMedia) {
    const fallback = normalizeMediaSource(cleanCandidate(payloadValue));
    if (isValidMedia(fallback, { allowSpaces: true, allowBareFilename: true })) {
      media.push(fallback);
      hasValidMedia = true;
      invalidParts.length = 0;
    }
  }

  if (!hasValidMedia) {
    return null;
  }
  return { media, invalidParts, looksLikeLocalPath };
}

/** True when a line contains at least one MEDIA: directive the normal parser would accept. */
export function lineHasAcceptableMediaDirective(line: string): boolean {
  if (!line.trimStart().toUpperCase().startsWith("MEDIA:")) {
    return false;
  }
  for (const match of line.matchAll(MEDIA_TOKEN_RE)) {
    const payload = match[1];
    if (payload == null) {
      continue;
    }
    if (resolveMediaDirectivePayload(payload)) {
      return true;
    }
  }
  return false;
}
