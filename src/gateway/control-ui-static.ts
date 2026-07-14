// Control UI static-response policy: MIME types, caching, encoding, and pinned-file reads.
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";

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
type ControlUiEncodingSelection = ControlUiContentEncoding | "identity" | "not-acceptable";

const CONTROL_UI_DYNAMIC_ENCODINGS = new Set<ControlUiContentEncoding>(["br", "gzip"]);
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
    default:
      return "application/octet-stream";
  }
}

function normalizedAcceptEncoding(req: IncomingMessage): string {
  const value = req.headers?.["accept-encoding"];
  return Array.isArray(value) ? value.join(",") : (value ?? "");
}

function resolveControlUiContentEncoding(
  req: IncomingMessage,
  availableEncodings: ReadonlySet<ControlUiContentEncoding>,
): ControlUiEncodingSelection {
  const qualities = new Map<string, number>();
  for (const entry of normalizedAcceptEncoding(req).split(",")) {
    const [rawName, ...rawParams] = entry.split(";");
    const name = rawName?.trim().toLowerCase();
    if (!name) {
      continue;
    }
    const qualityParam = rawParams.find((param) => param.trim().toLowerCase().startsWith("q="));
    const parsedQuality = qualityParam ? Number.parseFloat(qualityParam.trim().slice(2)) : 1;
    const quality =
      Number.isFinite(parsedQuality) && parsedQuality >= 0 && parsedQuality <= 1
        ? parsedQuality
        : 0;
    qualities.set(name, Math.max(qualities.get(name) ?? 0, quality));
  }

  const hasAcceptEncoding = normalizedAcceptEncoding(req).trim().length > 0;
  if (!hasAcceptEncoding) {
    return "identity";
  }

  const wildcardQuality = qualities.get("*");
  const qualityFor = (name: ControlUiContentEncoding) =>
    qualities.has(name) ? (qualities.get(name) ?? 0) : (wildcardQuality ?? 0);
  // RFC 9110 keeps identity acceptable unless identity or a rejecting wildcard
  // explicitly disables it. This distinction is required to return 406 rather
  // than silently violate identity;q=0.
  const identityQuality = qualities.has("identity")
    ? (qualities.get("identity") ?? 0)
    : wildcardQuality === 0
      ? 0
      : 1;
  const candidates: Array<{ encoding: ControlUiEncodingSelection; quality: number; rank: number }> =
    [{ encoding: "identity", quality: identityQuality, rank: 0 }];
  if (availableEncodings.has("gzip")) {
    candidates.push({ encoding: "gzip", quality: qualityFor("gzip"), rank: 1 });
  }
  if (availableEncodings.has("br")) {
    candidates.push({ encoding: "br", quality: qualityFor("br"), rank: 2 });
  }
  const selected = candidates
    .filter((candidate) => candidate.quality > 0)
    .toSorted((left, right) => right.quality - left.quality || right.rank - left.rank)[0];
  return selected?.encoding ?? "not-acceptable";
}

export function resolveControlUiHtmlEncoding(req: IncomingMessage): ControlUiEncodingSelection {
  return resolveControlUiContentEncoding(req, CONTROL_UI_DYNAMIC_ENCODINGS);
}

type OpenedControlUiRepresentation = {
  bodyFile: { path: string; fd: number };
  contentPath: string;
  encoding?: ControlUiContentEncoding;
};

export function resolveOpenedControlUiRepresentation(params: {
  req: IncomingMessage;
  sourceFile: { path: string; fd: number };
  precompressed: boolean;
  openPrecompressedFile: (filePath: string) => { path: string; fd: number } | null;
}): OpenedControlUiRepresentation | null {
  const { req, sourceFile, precompressed, openPrecompressedFile } = params;
  const extension = path.extname(sourceFile.path).toLowerCase();
  const availableEncodings =
    precompressed && isControlUiCompressibleExtension(extension)
      ? new Set(CONTROL_UI_DYNAMIC_ENCODINGS)
      : new Set<ControlUiContentEncoding>();
  for (;;) {
    const selected = resolveControlUiContentEncoding(req, availableEncodings);
    if (selected === "not-acceptable") {
      fs.closeSync(sourceFile.fd);
      return null;
    }
    if (selected === "identity") {
      return { bodyFile: sourceFile, contentPath: sourceFile.path };
    }

    const suffix = selected === "br" ? ".br" : ".gz";
    let compressedFile: { path: string; fd: number } | null;
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

    // Generated builds have both variants, but a stale or partial local build
    // can miss one. Retry the remaining representation before identity/406.
    availableEncodings.delete(selected);
  }
}

function setControlUiEncodingHeaders(
  res: ServerResponse,
  extension: string,
  encoding: ControlUiContentEncoding | "identity",
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
  options?: { immutable?: boolean; encoding?: ControlUiContentEncoding },
) {
  const extension = path.extname(filePath).toLowerCase();
  res.setHeader("Content-Type", contentTypeForExtension(extension));
  res.setHeader(
    "Cache-Control",
    options?.immutable ? CONTROL_UI_IMMUTABLE_CACHE_CONTROL : "no-cache",
  );
  setControlUiEncodingHeaders(res, extension, options?.encoding ?? "identity");
}

export function respondHeadForControlUiFile(
  res: ServerResponse,
  filePath: string,
  options?: { immutable?: boolean; encoding?: ControlUiContentEncoding },
) {
  res.statusCode = 200;
  setControlUiFileHeaders(res, filePath, options);
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
  options?: { immutable?: boolean; encoding?: ControlUiContentEncoding },
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
  const compression = compressControlUiBody(Buffer.from(body), encoding);
  controlUiHtmlCompressionCache.set(key, compression);
  void compression.catch(() => {
    if (controlUiHtmlCompressionCache.get(key) === compression) {
      controlUiHtmlCompressionCache.delete(key);
    }
  });
  while (controlUiHtmlCompressionCache.size > CONTROL_UI_HTML_COMPRESSION_CACHE_MAX_ENTRIES) {
    const oldestKey = controlUiHtmlCompressionCache.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    controlUiHtmlCompressionCache.delete(oldestKey);
  }
  return compression;
}

export function respondControlUiNotAcceptable(res: ServerResponse) {
  res.statusCode = 406;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Vary", "Accept-Encoding");
  res.end("Not Acceptable");
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

function readOpenedFile(fd: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    fs.readFile(fd, (error, data) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(data);
    });
  });
}

// Compression can wait in zlib's worker queue, so release the pinned file as
// soon as its bytes are loaded instead of retaining descriptors per request.
export async function readAndCloseControlUiFile(fd: number): Promise<Buffer> {
  try {
    return await readOpenedFile(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export async function readAndCloseControlUiFileText(fd: number): Promise<string> {
  return (await readAndCloseControlUiFile(fd)).toString("utf8");
}
