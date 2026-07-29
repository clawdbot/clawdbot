/**
 * Browser proxy file helpers.
 *
 * Persists files returned by node-hosted browser proxy calls and rewrites
 * proxied result paths to local saved media paths.
 */
import { canonicalizeBase64, estimateBase64DecodedBytes } from "openclaw/plugin-sdk/media-runtime";
import {
  assertBrowserProxyFileCountWithinLimit,
  assertBrowserProxyFileBytesWithinLimits,
  BROWSER_PROXY_MAX_FILE_BYTES,
  type BrowserProxyFile,
  visitBrowserProxyFilePaths,
} from "../browser-proxy-envelope.js";
import { saveMediaBuffer } from "../media/store.js";

function decodeBrowserProxyFileBase64(file: BrowserProxyFile, totalBytes: number): Buffer {
  const estimatedBytes = estimateBase64DecodedBytes(file.base64);
  assertBrowserProxyFileBytesWithinLimits(estimatedBytes, totalBytes + estimatedBytes);
  // The shared validator rejects empty input, but zero-byte downloads are valid files.
  const canonicalBase64 = file.base64 === "" ? "" : canonicalizeBase64(file.base64);
  if (canonicalBase64 === undefined) {
    throw new Error("browser proxy file contains malformed base64 data");
  }
  const buffer = Buffer.from(canonicalBase64, "base64");
  assertBrowserProxyFileBytesWithinLimits(buffer.byteLength, totalBytes + buffer.byteLength);
  return buffer;
}

/** Persist proxy-returned files and return a remote-path to local-path map. */
export async function persistBrowserProxyFiles(files: BrowserProxyFile[] | undefined) {
  if (!files || files.length === 0) {
    return new Map<string, string>();
  }
  assertBrowserProxyFileCountWithinLimit(files.length);
  const decoded: Array<{ file: BrowserProxyFile; buffer: Buffer }> = [];
  let totalBytes = 0;
  for (const file of files) {
    const buffer = decodeBrowserProxyFileBase64(file, totalBytes);
    totalBytes += buffer.byteLength;
    decoded.push({ file, buffer });
  }

  const mapping = new Map<string, string>();
  for (const { file, buffer } of decoded) {
    const saved = await saveMediaBuffer(
      buffer,
      file.mimeType,
      "browser",
      BROWSER_PROXY_MAX_FILE_BYTES,
    );
    mapping.set(file.path, saved.path);
  }
  return mapping;
}

/** Rewrite every supported result path that points at a persisted proxy file. */
export function applyBrowserProxyPaths(result: unknown, mapping: Map<string, string>) {
  visitBrowserProxyFilePaths(result, (filePath) => mapping.get(filePath));
}
