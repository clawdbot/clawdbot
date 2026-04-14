import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

const ENCODED_FILE_URL_SEPARATOR_RE = /%(?:2f|5c)/i;

function isLocalFileUrlHost(hostname: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(hostname);
  return normalized === "" || normalized === "localhost";
}

export function hasEncodedFileUrlSeparator(pathname: string): boolean {
  return ENCODED_FILE_URL_SEPARATOR_RE.test(pathname);
}

export function isWindowsNetworkPath(filePath: string): boolean {
  if (process.platform !== "win32") {
    return false;
  }
  const normalized = filePath.replace(/\//g, "\\");
  return normalized.startsWith("\\\\?\\UNC\\") || normalized.startsWith("\\\\");
}

export function assertNoWindowsNetworkPath(filePath: string, label = "Path"): void {
  if (isWindowsNetworkPath(filePath)) {
    throw new Error(`${label} cannot use Windows network paths: ${filePath}`);
  }
}

export function safeFileURLToPath(fileUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(fileUrl);
  } catch {
    throw new Error(`Invalid file:// URL: ${fileUrl}`);
  }
  if (parsed.protocol !== "file:") {
    throw new Error(`Invalid file:// URL: ${fileUrl}`);
  }
  if (!isLocalFileUrlHost(parsed.hostname)) {
    throw new Error(`file:// URLs with remote hosts are not allowed: ${fileUrl}`);
  }
  if (hasEncodedFileUrlSeparator(parsed.pathname)) {
    throw new Error(`file:// URLs cannot encode path separators: ${fileUrl}`);
  }
  const filePath = fileURLToPath(parsed);
  assertNoWindowsNetworkPath(filePath, "Local file URL");
  return filePath;
}

export function trySafeFileURLToPath(fileUrl: string): string | undefined {
  try {
    return safeFileURLToPath(fileUrl);
  } catch {
    return undefined;
  }
}

export function basenameFromMediaSource(source?: string): string | undefined {
  if (!source) {
    return undefined;
  }
  if (source.startsWith("file://")) {
    const filePath = trySafeFileURLToPath(source);
    return filePath ? path.basename(filePath) || undefined : undefined;
  }
  if (/^https?:\/\//i.test(source)) {
    try {
      return path.basename(new URL(source).pathname) || undefined;
    } catch {
      return undefined;
    }
  }
  return path.basename(source) || undefined;
}
