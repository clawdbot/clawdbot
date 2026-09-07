/**
 * Browser proxy file helpers.
 *
 * Persists files returned by node-hosted browser proxy calls and rewrites
 * proxied result paths to local saved media paths.
 */
import { canonicalizeBase64, estimateBase64DecodedBytes } from "openclaw/plugin-sdk/media-runtime";
import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  assertBrowserProxyFileCountWithinLimit,
  assertBrowserProxyFileBytesWithinLimits,
  BROWSER_PROXY_MAX_FILE_BYTES,
  type BrowserProxyFile,
  visitBrowserProxyFilePaths,
} from "../browser-proxy-envelope.js";
import { saveMediaBuffer } from "../media/store.js";

const INVALID_BROWSER_PROXY_FILE_ENVELOPE = "browser proxy returned an invalid file envelope";

function invalidBrowserProxyFileEnvelope(): never {
  throw new Error(INVALID_BROWSER_PROXY_FILE_ENVELOPE);
}

function collectBrowserProxyResultPaths(result: unknown): Set<string> {
  const paths = new Set<string>();
  visitBrowserProxyFilePaths(result, (filePath) => {
    paths.add(filePath);
    assertBrowserProxyFileCountWithinLimit(paths.size);
  });
  return paths;
}

function validateBrowserProxyFiles(result: unknown, files: unknown): BrowserProxyFile[] {
  const referencedPaths = collectBrowserProxyResultPaths(result);
  const candidates = files === undefined ? [] : files;
  if (!Array.isArray(candidates)) {
    return invalidBrowserProxyFileEnvelope();
  }
  assertBrowserProxyFileCountWithinLimit(candidates.length);
  const validated: BrowserProxyFile[] = [];
  for (const value of candidates) {
    const file = asNullableRecord(value);
    if (
      !file ||
      typeof file.path !== "string" ||
      !file.path.trim() ||
      typeof file.base64 !== "string" ||
      (file.mimeType !== undefined && typeof file.mimeType !== "string") ||
      !referencedPaths.delete(file.path)
    ) {
      return invalidBrowserProxyFileEnvelope();
    }
    validated.push({
      path: file.path,
      base64: file.base64,
      ...(file.mimeType === undefined ? {} : { mimeType: file.mimeType }),
    });
  }
  if (referencedPaths.size > 0) {
    return invalidBrowserProxyFileEnvelope();
  }
  return validated;
}

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

/** Validate, persist, and rewrite every route-owned file in a node result. */
export async function persistBrowserProxyResultFiles(result: unknown, files: unknown) {
  const validatedFiles = validateBrowserProxyFiles(result, files);
  if (validatedFiles.length === 0) {
    return result;
  }
  const decoded: Array<{ file: BrowserProxyFile; buffer: Buffer }> = [];
  let totalBytes = 0;
  for (const file of validatedFiles) {
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
      file.path,
    );
    mapping.set(file.path, saved.path);
  }
  visitBrowserProxyFilePaths(result, (filePath) => mapping.get(filePath));
  return result;
}
