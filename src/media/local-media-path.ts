import path from "node:path";
import { isPassThroughRemoteMediaSource } from "@openclaw/media-core/media-source-url";
import { safeFileURLToPath } from "../infra/local-file-access.js";
import { resolveUserPath } from "../utils.js";

const DATA_URL_RE = /^data:/i;
const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/;

/** Resolves a media source to a local path when it is not a remote or data URL. */
export function resolveLocalMediaPath(source: string): string | undefined {
  const trimmed = source.trim();
  if (!trimmed || isPassThroughRemoteMediaSource(trimmed) || DATA_URL_RE.test(trimmed)) {
    return undefined;
  }
  if (trimmed.startsWith("file://")) {
    try {
      return safeFileURLToPath(trimmed);
    } catch {
      return undefined;
    }
  }
  if (trimmed.startsWith("~")) {
    return resolveUserPath(trimmed);
  }
  if (path.isAbsolute(trimmed) || WINDOWS_DRIVE_RE.test(trimmed)) {
    return path.resolve(trimmed);
  }
  return undefined;
}
