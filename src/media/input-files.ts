// Input file helpers normalize inline, fetched, and local media inputs.
import { MIMEType } from "node:util";
import {
  classifyAttachmentBytes,
  type AttachmentClassification,
} from "@openclaw/media-core/attachment-classify";
import { canonicalizeBase64, estimateBase64DecodedBytes } from "@openclaw/media-core/base64";
import { parseMediaContentLength } from "@openclaw/media-core/content-length";
import { detectMime, normalizeMimeType } from "@openclaw/media-core/mime";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { cancelUnreadResponseBody, readResponseWithLimit } from "../infra/http-body.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { logWarn } from "../logger.js";
import { convertHeicToJpeg } from "./media-services.js";
import { extractPdfContent, type PdfExtractedImage } from "./pdf-extract.js";

/** Image payload shape reused for extracted PDF images and normalized input images. */
type InputImageContent = PdfExtractedImage;

/** Text/images extracted from an input_file source after MIME-specific processing. */
type InputFileExtractResult = {
  filename: string;
  text?: string;
  images?: InputImageContent[];
};

/** PDF extraction limits applied before model-visible input_file content is produced. */
type InputPdfLimits = {
  maxPages: number;
  maxPixels: number;
  minTextChars: number;
};

/** Resolved input_file limits with normalized MIME allowlist and PDF sub-limits. */
export type InputFileLimits = {
  allowUrl: boolean;
  urlAllowlist?: string[];
  allowedMimes: Set<string>;
  maxBytes: number;
  maxChars: number;
  maxRedirects: number;
  timeoutMs: number;
  pdf: InputPdfLimits;
};

/** Optional config shape accepted by input_file limit resolution. */
export type InputFileLimitsConfig = {
  allowUrl?: boolean;
  allowedMimes?: string[];
  maxBytes?: number;
  maxChars?: number;
  maxRedirects?: number;
  timeoutMs?: number;
  pdf?: {
    maxPages?: number;
    maxPixels?: number;
    minTextChars?: number;
  };
};

/** Resolved input_image limits with normalized MIME allowlist and URL fetch controls. */
export type InputImageLimits = {
  allowUrl: boolean;
  urlAllowlist?: string[];
  allowedMimes: Set<string>;
  maxBytes: number;
  maxRedirects: number;
  timeoutMs: number;
};

/** Supported input_image source variants before base64 decoding or guarded URL fetch. */
export type InputImageSource =
  | {
      type: "base64";
      data: string;
      mediaType?: string;
    }
  | {
      type: "url";
      url: string;
      mediaType?: string;
    };

/** Supported input_file source variants before text/PDF extraction. */
type InputFileSource =
  | {
      type: "base64";
      data: string;
      mediaType?: string;
      filename?: string;
    }
  | {
      type: "url";
      url: string;
      mediaType?: string;
      filename?: string;
    };

/** Guarded URL fetch result before final MIME allowlist validation. */
type InputFetchResult = {
  buffer: Buffer;
  contentType?: string;
};

/** Default MIME allowlist for input_image sources. */
export const DEFAULT_INPUT_IMAGE_MIMES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
];
/** Default MIME allowlist for input_file text/PDF extraction. */
const DEFAULT_INPUT_FILE_MIMES = [
  "text/plain",
  "text/markdown",
  "text/html",
  "text/csv",
  "application/json",
  "application/pdf",
];
/** Default decoded-byte cap for input_image payloads. */
export const DEFAULT_INPUT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** Default decoded-byte cap for input_file payloads. */
const DEFAULT_INPUT_FILE_MAX_BYTES = 5 * 1024 * 1024;
/** Default maximum model-visible characters emitted from input_file text. */
const DEFAULT_INPUT_FILE_MAX_CHARS = 60_000;
/** Default redirect cap for guarded input source URL fetches. */
export const DEFAULT_INPUT_MAX_REDIRECTS = 3;
/** Default timeout for guarded input source URL fetches. */
export const DEFAULT_INPUT_TIMEOUT_MS = 10_000;
/** Default PDF page cap for input_file extraction. */
const DEFAULT_INPUT_PDF_MAX_PAGES = 4;
/** Default PDF raster pixel cap for extracted input_file images. */
const DEFAULT_INPUT_PDF_MAX_PIXELS = 4_000_000;
/** Default text threshold before PDF extraction keeps text-only output. */
const DEFAULT_INPUT_PDF_MIN_TEXT_CHARS = 200;
const NORMALIZED_INPUT_IMAGE_MIME = "image/jpeg";
const HEIC_INPUT_IMAGE_MIMES = new Set(["image/heic", "image/heif"]);

function rejectOversizedBase64Payload(params: {
  data: string;
  maxBytes: number;
  label: "Image" | "File";
}): void {
  const estimated = estimateBase64DecodedBytes(params.data);
  if (estimated > params.maxBytes) {
    throw new Error(
      `${params.label} too large: ${estimated} bytes (limit: ${params.maxBytes} bytes)`,
    );
  }
}

/** Parses a Content-Type header into normalized MIME and optional charset values. */
function parseContentType(value: string | undefined): {
  mimeType?: string;
  charset?: string;
} {
  if (!value) {
    return {};
  }
  const mimeType = normalizeMimeType(value);
  try {
    return { mimeType, charset: new MIMEType(value).params.get("charset") ?? undefined };
  } catch {
    // Invalid metadata still goes through byte classification and MIME allowlists.
    return { mimeType };
  }
}

/** Converts configured MIME lists into a normalized allowlist, using fallback defaults when empty. */
export function normalizeMimeList(values: string[] | undefined, fallback: string[]): Set<string> {
  const input = values && values.length > 0 ? values : fallback;
  return new Set(input.flatMap((value) => normalizeMimeType(value) ?? []));
}

/** Resolves input_file extraction limits from partial config and stable defaults. */
export function resolveInputFileLimits(config?: InputFileLimitsConfig): InputFileLimits {
  return {
    allowUrl: config?.allowUrl ?? true,
    allowedMimes: normalizeMimeList(config?.allowedMimes, DEFAULT_INPUT_FILE_MIMES),
    maxBytes: config?.maxBytes ?? DEFAULT_INPUT_FILE_MAX_BYTES,
    maxChars: config?.maxChars ?? DEFAULT_INPUT_FILE_MAX_CHARS,
    maxRedirects: config?.maxRedirects ?? DEFAULT_INPUT_MAX_REDIRECTS,
    timeoutMs: config?.timeoutMs ?? DEFAULT_INPUT_TIMEOUT_MS,
    pdf: {
      maxPages: config?.pdf?.maxPages ?? DEFAULT_INPUT_PDF_MAX_PAGES,
      maxPixels: config?.pdf?.maxPixels ?? DEFAULT_INPUT_PDF_MAX_PIXELS,
      minTextChars: config?.pdf?.minTextChars ?? DEFAULT_INPUT_PDF_MIN_TEXT_CHARS,
    },
  };
}

/** Fetches an input source URL through SSRF, redirect, timeout, and byte-limit guards. */
async function fetchWithGuard(params: {
  url: string;
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
  policy?: SsrFPolicy;
  auditContext?: string;
}): Promise<InputFetchResult> {
  const { response, release } = await fetchWithSsrFGuard({
    url: params.url,
    maxRedirects: params.maxRedirects,
    timeoutMs: params.timeoutMs,
    policy: params.policy,
    auditContext: params.auditContext,
    init: { headers: { "User-Agent": "OpenClaw-Gateway/1.0" } },
  });

  try {
    if (!response.ok) {
      await cancelUnreadResponseBody(response);
      throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
    }

    let contentLength: number | null;
    try {
      contentLength = parseMediaContentLength(response.headers.get("content-length"));
    } catch (err) {
      await cancelUnreadResponseBody(response);
      throw err;
    }
    if (contentLength !== null && contentLength > params.maxBytes) {
      await cancelUnreadResponseBody(response);
      throw new Error(
        `Content too large: ${contentLength} bytes (limit: ${params.maxBytes} bytes)`,
      );
    }

    const buffer = await readResponseWithLimit(response, params.maxBytes);

    const contentType = response.headers.get("content-type") ?? undefined;
    return { buffer, contentType };
  } finally {
    await release();
  }
}

function decodeTextContent(buffer: Buffer, charset: string | undefined): string {
  const encoding = normalizeOptionalLowercaseString(charset) || "utf-8";
  try {
    return new TextDecoder(encoding).decode(buffer);
  } catch {
    return new TextDecoder("utf-8").decode(buffer);
  }
}

function withInputFileTimeout<T>(params: {
  task: Promise<T>;
  timeoutMs: number;
  label: string;
}): Promise<T> {
  const timeoutMs = resolveTimerTimeoutMs(params.timeoutMs, 1);
  let timeout: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${params.label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([params.task, timedOut]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
}

async function normalizeInputImage(params: {
  buffer: Buffer;
  mimeType?: string;
  limits: InputImageLimits;
}): Promise<InputImageContent> {
  const declaredMime = normalizeMimeType(params.mimeType) ?? "application/octet-stream";
  const detectedMime = normalizeMimeType(
    await detectMime({ buffer: params.buffer, headerMime: params.mimeType }),
  );
  if (declaredMime.startsWith("image/") && detectedMime && !detectedMime.startsWith("image/")) {
    throw new Error(`Unsupported image MIME type: ${detectedMime}`);
  }
  const sourceMime = (detectedMime?.startsWith("image/") ? detectedMime : declaredMime).replace(
    /^(image\/hei[cf])-sequence$/,
    "$1",
  );
  if (!params.limits.allowedMimes.has(sourceMime)) {
    throw new Error(`Unsupported image MIME type: ${sourceMime}`);
  }

  if (!HEIC_INPUT_IMAGE_MIMES.has(sourceMime)) {
    return {
      type: "image",
      data: params.buffer.toString("base64"),
      mimeType: sourceMime,
    };
  }

  // Normalize HEIC/HEIF to JPEG because downstream model and channel surfaces expect common images.
  const normalizedBuffer = await convertHeicToJpeg(params.buffer);
  if (normalizedBuffer.byteLength > params.limits.maxBytes) {
    throw new Error(
      `Image too large after HEIC conversion: ${normalizedBuffer.byteLength} bytes (limit: ${params.limits.maxBytes} bytes)`,
    );
  }
  return {
    type: "image",
    data: normalizedBuffer.toString("base64"),
    mimeType: NORMALIZED_INPUT_IMAGE_MIME,
  };
}

/** Extracts and normalizes an input_image source from base64 or guarded URL input. */
export async function extractImageContentFromSource(
  source: InputImageSource,
  limits: InputImageLimits,
): Promise<InputImageContent> {
  if (source.type === "base64") {
    rejectOversizedBase64Payload({ data: source.data, maxBytes: limits.maxBytes, label: "Image" });
    const canonicalData = canonicalizeBase64(source.data);
    if (!canonicalData) {
      throw new Error("input_image base64 source has invalid 'data' field");
    }
    const buffer = Buffer.from(canonicalData, "base64");
    if (buffer.byteLength > limits.maxBytes) {
      throw new Error(
        `Image too large: ${buffer.byteLength} bytes (limit: ${limits.maxBytes} bytes)`,
      );
    }
    return await normalizeInputImage({
      buffer,
      mimeType: normalizeMimeType(source.mediaType) ?? "image/png",
      limits,
    });
  }

  if (source.type === "url") {
    if (!limits.allowUrl) {
      throw new Error("input_image URL sources are disabled by config");
    }
    const result = await fetchWithGuard({
      url: source.url,
      maxBytes: limits.maxBytes,
      timeoutMs: limits.timeoutMs,
      maxRedirects: limits.maxRedirects,
      policy: {
        allowPrivateNetwork: false,
        hostnameAllowlist: limits.urlAllowlist,
      },
      auditContext: "openresponses.input_image",
    });
    return await normalizeInputImage({
      buffer: result.buffer,
      mimeType: parseContentType(result.contentType).mimeType,
      limits,
    });
  }

  throw new Error(`Unsupported input_image source type: ${(source as { type: string }).type}`);
}

/** Extracts model-visible text and images from an input_file source after MIME validation. */
export async function extractFileContentFromSource(params: {
  source: InputFileSource;
  limits: InputFileLimits;
  config?: OpenClawConfig;
}): Promise<InputFileExtractResult> {
  const { source, limits } = params;
  const filename = source.filename || "file";

  let buffer: Buffer;
  let mimeType: string | undefined;
  let charset: string | undefined;

  if (source.type === "base64") {
    rejectOversizedBase64Payload({ data: source.data, maxBytes: limits.maxBytes, label: "File" });
    const canonicalData = canonicalizeBase64(source.data);
    if (!canonicalData) {
      throw new Error("input_file base64 source has invalid 'data' field");
    }
    const parsed = parseContentType(source.mediaType);
    mimeType = parsed.mimeType;
    charset = parsed.charset;
    buffer = Buffer.from(canonicalData, "base64");
  } else {
    if (!limits.allowUrl) {
      throw new Error("input_file URL sources are disabled by config");
    }
    const result = await fetchWithGuard({
      url: source.url,
      maxBytes: limits.maxBytes,
      timeoutMs: limits.timeoutMs,
      maxRedirects: limits.maxRedirects,
      policy: {
        allowPrivateNetwork: false,
        hostnameAllowlist: limits.urlAllowlist,
      },
      auditContext: "openresponses.input_file",
    });
    const parsed = parseContentType(result.contentType);
    mimeType = parsed.mimeType;
    charset = parsed.charset;
    buffer = result.buffer;
  }

  return await extractFileContentFromBuffer({
    buffer,
    filename,
    mimeType,
    charset,
    limits,
    config: params.config,
  });
}

/** Extracts owned bytes after shared size and MIME checks; no source encoding is required. */
export async function extractFileContentFromBuffer(params: {
  buffer: Buffer;
  filename?: string;
  mimeType?: string;
  charset?: string;
  limits: InputFileLimits;
  config?: OpenClawConfig;
  classification?: AttachmentClassification;
}): Promise<InputFileExtractResult> {
  const { buffer, limits } = params;
  const filename = params.filename || "file";
  if (buffer.byteLength > limits.maxBytes) {
    throw new Error(`File too large: ${buffer.byteLength} bytes (limit: ${limits.maxBytes} bytes)`);
  }

  // Direct input_file callers declare their content type; the filename is
  // display metadata and must not override an explicitly allowlisted MIME.
  const classification =
    params.classification ??
    (await classifyAttachmentBytes({ buffer, declaredMime: params.mimeType }));
  const mimeType = classification.mime;
  const charset = classification.charset ?? params.charset;

  if (!mimeType) {
    throw new Error("input_file missing media type");
  }
  if (!limits.allowedMimes.has(mimeType)) {
    throw new Error(`Unsupported file MIME type: ${mimeType}`);
  }

  if (mimeType === "application/pdf") {
    const extracted = await withInputFileTimeout({
      label: "PDF extraction",
      timeoutMs: limits.timeoutMs,
      task: extractPdfContent({
        buffer,
        maxPages: limits.pdf.maxPages,
        maxPixels: limits.pdf.maxPixels,
        minTextChars: limits.pdf.minTextChars,
        ...(params.config ? { config: params.config } : {}),
        onImageExtractionError: (err) => {
          logWarn(`media: PDF image extraction skipped, ${String(err)}`);
        },
      }),
    });
    const text = extracted.text ? truncateUtf16Safe(extracted.text, limits.maxChars) : "";
    return {
      filename,
      text,
      images: extracted.images.length > 0 ? extracted.images : undefined,
    };
  }

  const text = truncateUtf16Safe(decodeTextContent(buffer, charset), limits.maxChars);
  return { filename, text };
}
