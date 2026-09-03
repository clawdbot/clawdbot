// Shared validation and response policy for authenticated Gateway image routes.
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { normalizeMimeType } from "@openclaw/media-core/mime";
import { fileTypeFromBuffer } from "file-type";
import { matchesHttpIfNoneMatch } from "./http-conditional.js";

/** Authenticated UI images are deliberately small, bounded presentation assets. */
export const HTTP_IMAGE_MAX_BYTES = 512 * 1024;
/** Vector images are markup the renderer must parse, so they get a tighter cap. */
export const HTTP_SVG_MAX_BYTES = 64 * 1024;
const SVG_MIME_TYPE = "image/svg+xml";
const ICO_MIME_TYPE = "image/x-icon";

/** Image types accepted by the authenticated Control UI image routes. */
const ALLOWED_HTTP_IMAGE_MIME_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  SVG_MIME_TYPE,
  "image/webp",
  ICO_MIME_TYPE,
]);

export type HttpImageRepresentation = {
  body: Buffer;
  contentType: string;
  etag: string;
};

export function resolveHttpImageMimeType(value: string | undefined): string | undefined {
  const normalized = normalizeMimeType(value);
  const contentType = normalized === "image/vnd.microsoft.icon" ? ICO_MIME_TYPE : normalized;
  return contentType && ALLOWED_HTTP_IMAGE_MIME_TYPES.has(contentType) ? contentType : undefined;
}

/** Hash final, validated response bytes once when their cached representation is created. */
export function createHttpImageRepresentation(
  body: Buffer,
  contentType: string,
): HttpImageRepresentation {
  return {
    body,
    contentType,
    etag: `"${createHash("sha256").update(body).digest("base64url")}"`,
  };
}

/**
 * SVG images stay self-contained: no script, document expansion, embedded
 * documents, or outbound fetches can reach the browser through an image route.
 */
function isRenderableHttpSvg(body: Buffer): boolean {
  if (body.byteLength > HTTP_SVG_MAX_BYTES) {
    return false;
  }
  const text = body.toString("utf8");
  return (
    !text.includes("\0") &&
    !/<!doctype|<!entity/iu.test(text) &&
    !/<\s*(?:script|foreignObject|image|use|iframe)\b/iu.test(text) &&
    !/\b(?:href|xlink:href|src)\s*=/iu.test(text) &&
    /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/iu.test(text)
  );
}

/** Sniffs and validates bytes before they become a browser image response. */
export async function resolveHttpImageRepresentation(
  sourceName: string,
  body: Buffer,
): Promise<HttpImageRepresentation | undefined> {
  if (body.byteLength === 0 || body.byteLength > HTTP_IMAGE_MAX_BYTES) {
    return undefined;
  }
  let contentType: string | undefined;
  if (path.extname(sourceName).toLowerCase() === ".svg") {
    contentType = isRenderableHttpSvg(body) ? SVG_MIME_TYPE : undefined;
  } else {
    contentType = resolveHttpImageMimeType((await fileTypeFromBuffer(body))?.mime);
  }
  if (!contentType) {
    return undefined;
  }
  return createHttpImageRepresentation(body, contentType);
}

/** Writes the shared private-cache and document-sandbox policy for image bytes. */
export function sendHttpImageResponse(params: {
  req: IncomingMessage;
  res: ServerResponse;
  image: HttpImageRepresentation;
  filename: string;
  cacheControl?: string;
}): void {
  const { req, res, image } = params;
  res.setHeader("etag", image.etag);
  res.setHeader("cache-control", params.cacheControl ?? "private, max-age=3600");
  res.setHeader("cross-origin-resource-policy", "same-origin");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader(
    "content-security-policy",
    "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; sandbox",
  );
  res.setHeader("content-disposition", `attachment; filename="${params.filename}"`);
  if (matchesHttpIfNoneMatch(req.headers["if-none-match"], image.etag)) {
    res.statusCode = 304;
    res.end();
    return;
  }
  res.statusCode = 200;
  res.setHeader("content-type", image.contentType);
  res.setHeader("content-length", String(image.body.byteLength));
  res.end(req.method === "HEAD" ? undefined : image.body);
}
