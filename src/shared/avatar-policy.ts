import path from "node:path";
import { isPathInside } from "../infra/path-guards.js";
import { normalizeLowercaseStringOrEmpty } from "./string-coerce.js";

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

const LOCAL_AVATAR_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);

const AVATAR_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
};

export const AVATAR_DATA_RE = /^data:/i;
export const AVATAR_IMAGE_DATA_RE = /^data:image\//i;
export const AVATAR_HTTP_RE = /^https?:\/\//i;
export const AVATAR_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
export const WINDOWS_ABS_RE = /^[a-zA-Z]:[\\/]/;

const AVATAR_PATH_EXT_RE = /\.(png|jpe?g|gif|webp|svg|ico)$/i;

export function resolveAvatarMime(filePath: string): string {
  const ext = normalizeLowercaseStringOrEmpty(path.extname(filePath));
  return AVATAR_MIME_BY_EXT[ext] ?? "application/octet-stream";
}

export function isAvatarDataUrl(value: string): boolean {
  return AVATAR_DATA_RE.test(value);
}

export function isAvatarImageDataUrl(value: string): boolean {
  return AVATAR_IMAGE_DATA_RE.test(value);
}

export function isAvatarHttpUrl(value: string): boolean {
  return AVATAR_HTTP_RE.test(value);
}

export function hasAvatarUriScheme(value: string): boolean {
  return AVATAR_SCHEME_RE.test(value);
}

export function isWindowsAbsolutePath(value: string): boolean {
  return WINDOWS_ABS_RE.test(value);
}

export function isWorkspaceRelativeAvatarPath(value: string): boolean {
  if (!value) {
    return false;
  }
  if (value.startsWith("~")) {
    return false;
  }
  if (hasAvatarUriScheme(value) && !isWindowsAbsolutePath(value)) {
    return false;
  }
  return true;
}

export function isPathWithinRoot(rootDir: string, targetPath: string): boolean {
  return isPathInside(rootDir, targetPath);
}

export function looksLikeAvatarPath(value: string): boolean {
  if (/[\\/]/.test(value)) {
    return true;
  }
  return AVATAR_PATH_EXT_RE.test(value);
}

export function isSupportedLocalAvatarExtension(filePath: string): boolean {
  const ext = normalizeLowercaseStringOrEmpty(path.extname(filePath));
  return LOCAL_AVATAR_EXTENSIONS.has(ext);
}
