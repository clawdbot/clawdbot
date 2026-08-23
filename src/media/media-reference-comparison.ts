import path from "node:path";
import { fileURLToPath } from "node:url";
import { hasEncodedFileUrlSeparator } from "../infra/local-file-access.js";

const PATH_PARENT_SEGMENT_RE = /(?:^|[\\/])\.\.(?:[\\/]|$)/u;
const FORWARD_NETWORK_PATH_PREFIX_RE = /^\/\//u;
const FILE_URL_PREFIX_RE = /^file:(?:\/\/)?/iu;
const FILE_URL_LOCAL_NETWORK_KEY_PREFIX = "\0file-url-local-network:";

function normalizeAbsoluteLocalPath(value: string): string {
  if (
    !path.isAbsolute(value) ||
    PATH_PARENT_SEGMENT_RE.test(value) ||
    FORWARD_NETWORK_PATH_PREFIX_RE.test(value)
  ) {
    return value;
  }
  return path.normalize(value);
}

function normalizeFileUrlLocalPath(value: string): string {
  if (!value.startsWith("//")) {
    return normalizeAbsoluteLocalPath(value);
  }
  const normalized = PATH_PARENT_SEGMENT_RE.test(value)
    ? value
    : `//${path.normalize(value.slice(2))}`;
  return `${FILE_URL_LOCAL_NETWORK_KEY_PREFIX}${normalized}`;
}

function normalizeMalformedLocalFileUrl(value: string): string | undefined {
  const remainder = value.replace(FILE_URL_PREFIX_RE, "");
  let localPath: string;
  if (remainder.startsWith("/")) {
    localPath = remainder;
  } else if (/^localhost(?:\/|$)/iu.test(remainder)) {
    localPath = remainder.slice("localhost".length);
  } else {
    return undefined;
  }
  if (process.platform === "win32" && /^\/[a-z]:[\\/]/iu.test(localPath)) {
    localPath = localPath.slice(1);
  }
  return normalizeFileUrlLocalPath(localPath);
}

/** Canonicalizes equivalent local media references without resolving the filesystem. */
export function normalizeMediaReferenceForComparison(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (!FILE_URL_PREFIX_RE.test(trimmed)) {
    return normalizeAbsoluteLocalPath(trimmed);
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "file:") {
      // Unsafe encoded separators must retain their original key instead of colliding with a path.
      if (hasEncodedFileUrlSeparator(parsed.pathname)) {
        return trimmed;
      }
      const windows =
        process.platform === "win32" &&
        (parsed.hostname !== "" || /^\/[a-z]:[\\/]/iu.test(parsed.pathname));
      return normalizeFileUrlLocalPath(fileURLToPath(parsed, { windows }));
    }
  } catch {
    // Preserve the historical fallback for malformed local URLs without conflating remote hosts.
  }
  return normalizeMalformedLocalFileUrl(trimmed) ?? trimmed;
}
