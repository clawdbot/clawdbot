// Control UI static-response policy: MIME types, caching, encoding, and pinned-file reads.
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { getOrCreatePromise } from "../shared/lazy-promise.js";
import { respondPlainText } from "./control-ui-http-utils.js";

const CONTROL_UI_IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const CONTROL_UI_HTML_COMPRESSION_CACHE_MAX_ENTRIES = 4;
const CONTROL_UI_COMPRESSIBLE_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".svg",
  ".txt",
  ".wasm",
  ".webmanifest",
]);
const CONTROL_UI_PRECOMPRESSED_ASSET_EXTENSIONS = new Set([".br", ".gz"]);

/**
 * Missing files with these extensions return 404 instead of the SPA index.
 * `.html` stays excluded because client-side routes may use that suffix.
 */
const CONTROL_UI_STATIC_ASSET_EXTENSIONS = new Set([
  ".js",
  ".css",
  ".json",
  ".map",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".txt",
  ".wasm",
  ".webmanifest",
  ".woff2",
]);

export function isControlUiStaticAssetExtension(extension: string): boolean {
  return CONTROL_UI_STATIC_ASSET_EXTENSIONS.has(extension);
}

function isControlUiCompressibleExtension(extension: string): boolean {
  return CONTROL_UI_COMPRESSIBLE_EXTENSIONS.has(extension);
}

export function isControlUiPrecompressedAssetExtension(extension: string): boolean {
  return CONTROL_UI_PRECOMPRESSED_ASSET_EXTENSIONS.has(extension);
}

type ControlUiContentEncoding = "br" | "gzip";
type ControlUiRepresentationEncoding = ControlUiContentEncoding | "identity";
type ControlUiEncodingSelection = ControlUiRepresentationEncoding | "not-acceptable";

const CONTROL_UI_QVALUE_PATTERN = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;
const controlUiHtmlCompressionCache = new Map<string, Promise<Buffer>>();

function contentTypeForExtension(ext: string): string {
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
    case ".map":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".ico":
      return "image/x-icon";
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".wasm":
      return "application/wasm";
    case ".webmanifest":
      return "application/manifest+json; charset=utf-8";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

function normalizedAcceptEncoding(req: IncomingMessage): string {
  const value = req.headers?.["accept-encoding"];
  return Array.isArray(value) ? value.join(",") : (value ?? "");
}

function resolveControlUiContentEncodings(
  req: IncomingMessage,
  includeCompressed: boolean,
): ControlUiRepresentationEncoding[] {
  const acceptEncoding = normalizedAcceptEncoding(req);
  if (!acceptEncoding.trim()) {
    return ["identity"];
  }
  const qualities = new Map<string, number>();
  for (const entry of acceptEncoding.split(",")) {
    const [rawName, ...rawParams] = entry.split(";");
    const name = rawName?.trim().toLowerCase();
    if (!name) {
      continue;
    }
    const qualityParam = rawParams.find((param) => param.trim().toLowerCase().startsWith("q="));
    const qualityText = qualityParam?.trim().slice(2);
    const parsedQuality =
      qualityText === undefined
        ? 1
        : CONTROL_UI_QVALUE_PATTERN.test(qualityText)
          ? Number(qualityText)
          : Number.NaN;
    const quality =
      Number.isFinite(parsedQuality) && parsedQuality >= 0 && parsedQuality <= 1
        ? parsedQuality
        : 0;
    qualities.set(name, Math.max(qualities.get(name) ?? 0, quality));
  }

  const wildcardQuality = qualities.get("*");
  // RFC 9110 keeps identity acceptable unless identity or a rejecting wildcard
  // explicitly disables it. This distinction is required to return 406 rather
  // than silently violate identity;q=0.
  const identityQuality = qualities.get("identity") ?? (wildcardQuality === 0 ? 0 : 1);
  const qualityFor = (name: ControlUiRepresentationEncoding) =>
    name === "identity" ? identityQuality : (qualities.get(name) ?? wildcardQuality ?? 0);
  // Stable sorting preserves the server's br/gzip/identity preference for equal quality.
  const encodings: ControlUiRepresentationEncoding[] = includeCompressed
    ? ["br", "gzip", "identity"]
    : ["identity"];
  return encodings
    .filter((encoding) => qualityFor(encoding) > 0)
    .toSorted((left, right) => qualityFor(right) - qualityFor(left));
}

export function resolveControlUiHtmlEncoding(req: IncomingMessage): ControlUiEncodingSelection {
  return resolveControlUiContentEncodings(req, true)[0] ?? "not-acceptable";
}

type OpenedControlUiRepresentation = {
  bodyFile: { path: string; fd: number; size: number };
  contentPath: string;
  encoding?: ControlUiContentEncoding;
};

export function resolveOpenedControlUiRepresentation(params: {
  req: IncomingMessage;
  sourceFile: { path: string; fd: number; size: number };
  precompressed: boolean;
  openPrecompressedFile: (filePath: string) => { path: string; fd: number; size: number } | null;
}): OpenedControlUiRepresentation | null {
  const { req, sourceFile, precompressed, openPrecompressedFile } = params;
  const extension = path.extname(sourceFile.path).toLowerCase();
  const encodings = resolveControlUiContentEncodings(
    req,
    precompressed && isControlUiCompressibleExtension(extension),
  );
  // A missing sidecar changes availability, not this request's encoding preferences.
  for (const selected of encodings) {
    if (selected === "identity") {
      return { bodyFile: sourceFile, contentPath: sourceFile.path };
    }

    const suffix = selected === "br" ? ".br" : ".gz";
    let compressedFile: { path: string; fd: number; size: number } | null;
    try {
      compressedFile = openPrecompressedFile(`${sourceFile.path}${suffix}`);
    } catch (error) {
      fs.closeSync(sourceFile.fd);
      throw error;
    }
    if (compressedFile) {
      fs.closeSync(sourceFile.fd);
      return { bodyFile: compressedFile, contentPath: sourceFile.path, encoding: selected };
    }
  }
  fs.closeSync(sourceFile.fd);
  return null;
}

function setControlUiEncodingHeaders(
  res: ServerResponse,
  extension: string,
  encoding: ControlUiRepresentationEncoding,
) {
  res.setHeader("Vary", "Accept-Encoding");
  if (!CONTROL_UI_COMPRESSIBLE_EXTENSIONS.has(extension)) {
    return;
  }
  if (encoding !== "identity") {
    res.setHeader("Content-Encoding", encoding);
  }
}

function setControlUiFileHeaders(
  res: ServerResponse,
  filePath: string,
  options?: { immutable?: boolean; encoding?: ControlUiContentEncoding; lastModifiedMs?: number },
) {
  const extension = path.extname(filePath).toLowerCase();
  res.setHeader("Content-Type", contentTypeForExtension(extension));
  res.setHeader(
    "Cache-Control",
    options?.immutable ? CONTROL_UI_IMMUTABLE_CACHE_CONTROL : "no-cache",
  );
  if (options?.lastModifiedMs !== undefined) {
    res.setHeader("Last-Modified", new Date(options.lastModifiedMs).toUTCString());
  }
  setControlUiEncodingHeaders(res, extension, options?.encoding ?? "identity");
}

/**
 * `no-cache` responses without a validator force a full re-download on every
 * revisit; fonts and theme CSS are the heavy unhashed assets that hit this.
 * HTTP-dates carry whole-second precision, so compare on floored seconds.
 */
export function isControlUiFileUnmodified(req: IncomingMessage, lastModifiedMs: number): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return false;
  }
  const header = req.headers?.["if-modified-since"];
  const since = typeof header === "string" ? Date.parse(header) : Number.NaN;
  return Number.isFinite(since) && Math.floor(lastModifiedMs / 1000) * 1000 <= since;
}

export function respondControlUiNotModified(
  res: ServerResponse,
  options: { immutable?: boolean; lastModifiedMs: number },
) {
  res.statusCode = 304;
  // A 304 repeats the caching headers of the 200 it stands in for so caches
  // refresh their freshness metadata alongside the validator.
  res.setHeader(
    "Cache-Control",
    options.immutable ? CONTROL_UI_IMMUTABLE_CACHE_CONTROL : "no-cache",
  );
  res.setHeader("Last-Modified", new Date(options.lastModifiedMs).toUTCString());
  res.setHeader("Vary", "Accept-Encoding");
  res.end();
}

export function respondHeadForControlUiFile(
  res: ServerResponse,
  filePath: string,
  options?: {
    immutable?: boolean;
    encoding?: ControlUiContentEncoding;
    contentLength?: number;
    lastModifiedMs?: number;
  },
) {
  res.statusCode = 200;
  setControlUiFileHeaders(res, filePath, options);
  if (options?.contentLength !== undefined) {
    res.setHeader("Content-Length", String(options.contentLength));
  }
  res.end();
}

function compressControlUiBody(body: Buffer, encoding: ControlUiContentEncoding): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const callback = (error: Error | null, compressed: Buffer) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(compressed);
    };
    if (encoding === "br") {
      brotliCompress(
        body,
        {
          params: {
            [zlibConstants.BROTLI_PARAM_QUALITY]: 4,
          },
        },
        callback,
      );
      return;
    }
    gzip(body, { level: 6 }, callback);
  });
}

export async function serveControlUiAsset(
  res: ServerResponse,
  filePath: string,
  body: Buffer,
  options?: { immutable?: boolean; encoding?: ControlUiContentEncoding; lastModifiedMs?: number },
) {
  setControlUiFileHeaders(res, filePath, options);
  res.end(body);
}

function cachedCompressedControlUiHtml(
  body: string,
  encoding: ControlUiContentEncoding,
): Promise<Buffer> {
  const key = `${encoding}\0${body}`;
  const cached = controlUiHtmlCompressionCache.get(key);
  if (cached) {
    controlUiHtmlCompressionCache.delete(key);
    controlUiHtmlCompressionCache.set(key, cached);
    return cached;
  }

  // Index HTML is process-stable for a configured root. Keep its few rewritten
  // variants single-flight and bounded so unauthenticated requests cannot fan
  // out zlib work; large hashed assets use build-time sidecars instead.
  const compression = getOrCreatePromise(
    controlUiHtmlCompressionCache,
    key,
    () => compressControlUiBody(Buffer.from(body), encoding),
    { cacheRejections: false },
  );
  pruneMapToMaxSize(controlUiHtmlCompressionCache, CONTROL_UI_HTML_COMPRESSION_CACHE_MAX_ENTRIES);
  return compression;
}

export function respondControlUiNotAcceptable(res: ServerResponse) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Vary", "Accept-Encoding");
  respondPlainText(res, 406, "Not Acceptable");
}

export async function sendControlUiHtmlBody(
  req: IncomingMessage,
  res: ServerResponse,
  body: string,
) {
  const encoding = resolveControlUiHtmlEncoding(req);
  if (encoding === "not-acceptable") {
    respondControlUiNotAcceptable(res);
    return;
  }
  setControlUiEncodingHeaders(res, ".html", encoding);
  res.end(encoding === "identity" ? body : await cachedCompressedControlUiHtml(body, encoding));
}

// Reuse the stat captured by safe open: another queued fstat adds a full
// event-loop wait under load. Keep Node readFile's allocation and chunk limits;
// this read ends at the pinned size, even if the file subsequently grows.
export async function readAndCloseControlUiFile(file: {
  fd: number;
  size: number;
}): Promise<Buffer> {
  try {
    if (file.size > 2 ** 31 - 1) {
      throw Object.assign(new RangeError("Control UI file exceeds the 2 GiB read limit"), {
        code: "ERR_FS_FILE_TOO_LARGE",
      });
    }
    const buffer = Buffer.allocUnsafe(file.size);
    let offset = 0;
    while (offset < buffer.length) {
      const length = Math.min(512 * 1024, buffer.length - offset);
      const bytesRead = await new Promise<number>((resolve, reject) => {
        fs.read(file.fd, buffer, offset, length, null, (error, count) => {
          if (error) {
            reject(error);
          } else {
            resolve(count);
          }
        });
      });
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    return buffer.subarray(0, offset);
  } finally {
    // Release before compression waits in zlib's worker queue.
    fs.closeSync(file.fd);
  }
}
