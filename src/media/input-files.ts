import { logWarn } from "../logger.js";
import {
  closeDispatcher,
  createPinnedDispatcher,
  resolvePinnedHostname,
} from "../infra/net/ssrf.js";
import type { Dispatcher } from "undici";

type CanvasModule = typeof import("@napi-rs/canvas");
type PdfJsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

let canvasModulePromise: Promise<CanvasModule> | null = null;
let pdfJsModulePromise: Promise<PdfJsModule> | null = null;

// Lazy-load optional PDF/image deps so non-PDF paths don't require native installs.
async function loadCanvasModule(): Promise<CanvasModule> {
  if (!canvasModulePromise) {
    canvasModulePromise = import("@napi-rs/canvas").catch((err) => {
      canvasModulePromise = null;
      throw new Error(
        `Optional dependency @napi-rs/canvas is required for PDF image extraction: ${String(err)}`,
      );
    });
  }
  return canvasModulePromise;
}

async function loadPdfJsModule(): Promise<PdfJsModule> {
  if (!pdfJsModulePromise) {
    pdfJsModulePromise = import("pdfjs-dist/legacy/build/pdf.mjs").catch((err) => {
      pdfJsModulePromise = null;
      throw new Error(
        `Optional dependency pdfjs-dist is required for PDF extraction: ${String(err)}`,
      );
    });
  }
  return pdfJsModulePromise;
}

export type InputImageContent = {
  type: "image";
  data: string;
  mimeType: string;
};

export type InputFileExtractResult = {
  filename: string;
  text?: string;
  images?: InputImageContent[];
};

export type InputPdfLimits = {
  maxPages: number;
  maxPixels: number;
  minTextChars: number;
};

export type InputFileLimits = {
  allowUrl: boolean;
  allowedMimes: Set<string>;
  maxBytes: number;
  maxChars: number;
  maxRedirects: number;
  timeoutMs: number;
  pdf: InputPdfLimits;
};

export type InputImageLimits = {
  allowUrl: boolean;
  allowedMimes: Set<string>;
  maxBytes: number;
  maxRedirects: number;
  timeoutMs: number;
};

export type InputImageSource = {
  type: "base64" | "url";
  data?: string;
  url?: string;
  mediaType?: string;
};

export type InputFileSource = {
  type: "base64" | "url";
  data?: string;
  url?: string;
  mediaType?: string;
  filename?: string;
};

export type InputFetchResult = {
  buffer: Buffer;
  mimeType: string;
  contentType?: string;
};

export const DEFAULT_INPUT_IMAGE_MIMES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
export const DEFAULT_INPUT_FILE_MIMES = [
  "text/plain",
  "text/markdown",
  "text/html",
  "text/csv",
  "application/json",
  "application/pdf",
];
export const DEFAULT_INPUT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_INPUT_FILE_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_INPUT_FILE_MAX_CHARS = 200_000;
export const DEFAULT_INPUT_MAX_REDIRECTS = 3;
export const DEFAULT_INPUT_TIMEOUT_MS = 10_000;
export const DEFAULT_INPUT_PDF_MAX_PAGES = 4;
export const DEFAULT_INPUT_PDF_MAX_PIXELS = 4_000_000;
export const DEFAULT_INPUT_PDF_MIN_TEXT_CHARS = 200;

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

export function normalizeMimeType(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const [raw] = value.split(";");
  const normalized = raw?.trim().toLowerCase();
  return normalized || undefined;
}

export function parseContentType(value: string | undefined): {
  mimeType?: string;
  charset?: string;
} {
  if (!value) return {};
  const parts = value.split(";").map((part) => part.trim());
  const mimeType = normalizeMimeType(parts[0]);
  const charset = parts
    .map((part) => part.match(/^charset=(.+)$/i)?.[1]?.trim())
    .find((part) => part && part.length > 0);
  return { mimeType, charset };
}

export function normalizeMimeList(values: string[] | undefined, fallback: string[]): Set<string> {
  const input = values && values.length > 0 ? values : fallback;
  return new Set(input.map((value) => normalizeMimeType(value)).filter(Boolean) as string[]);
}

export async function fetchWithGuard(params: {
  url: string;
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
}): Promise<InputFetchResult> {
  let currentUrl = params.url;
  let redirectCount = 0;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), params.timeoutMs);

  try {
    while (true) {
      const parsedUrl = new URL(currentUrl);
      if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        throw new Error(`Invalid URL protocol: ${parsedUrl.protocol}. Only HTTP/HTTPS allowed.`);
      }
      const pinned = await resolvePinnedHostname(parsedUrl.hostname);
      const dispatcher = createPinnedDispatcher(pinned);

      try {
        const response = await fetch(parsedUrl, {
          signal: controller.signal,
          headers: { "User-Agent": "Moltbot-Gateway/1.0" },
          redirect: "manual",
          dispatcher,
        } as RequestInit & { dispatcher: Dispatcher });

        if (isRedirectStatus(response.status)) {
          const location = response.headers.get("location");
          if (!location) {
            throw new Error(`Redirect missing location header (${response.status})`);
          }
          redirectCount += 1;
          if (redirectCount > params.maxRedirects) {
            throw new Error(`Too many redirects (limit: ${params.maxRedirects})`);
          }
          void response.body?.cancel();
          currentUrl = new URL(location, parsedUrl).toString();
          continue;
        }

        if (!response.ok) {
          throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
        }

        const contentLength = response.headers.get("content-length");
        if (contentLength) {
          const size = parseInt(contentLength, 10);
          if (size > params.maxBytes) {
            throw new Error(`Content too large: ${size} bytes (limit: ${params.maxBytes} bytes)`);
          }
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.byteLength > params.maxBytes) {
          throw new Error(
            `Content too large: ${buffer.byteLength} bytes (limit: ${params.maxBytes} bytes)`,
          );
        }

        const contentType = response.headers.get("content-type") || undefined;
        const parsed = parseContentType(contentType);
        const mimeType = parsed.mimeType ?? "application/octet-stream";
        return { buffer, mimeType, contentType };
      } finally {
        await closeDispatcher(dispatcher);
      }
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

function decodeTextContent(buffer: Buffer, charset: string | undefined): string {
  const encoding = charset?.trim().toLowerCase() || "utf-8";
  try {
    return new TextDecoder(encoding).decode(buffer);
  } catch {
    return new TextDecoder("utf-8").decode(buffer);
  }
}

function clampText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

async function extractPdfContent(params: {
  buffer: Buffer;
  limits: InputFileLimits;
}): Promise<{ text: string; images: InputImageContent[] }> {
  const { buffer, limits } = params;
  const { getDocument } = await loadPdfJsModule();
  const pdf = await getDocument({
    data: new Uint8Array(buffer),
    disableWorker: true,
  }).promise;
  const maxPages = Math.min(pdf.numPages, limits.pdf.maxPages);
  const textParts: string[] = [];

  for (let pageNum = 1; pageNum <= maxPages; pageNum += 1) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item) => ("str" in item ? String(item.str) : ""))
      .filter(Boolean)
      .join(" ");
    if (pageText) textParts.push(pageText);
  }

  const text = textParts.join("\n\n");
  if (text.trim().length >= limits.pdf.minTextChars) {
    return { text, images: [] };
  }

  let canvasModule: CanvasModule;
  try {
    canvasModule = await loadCanvasModule();
  } catch (err) {
    logWarn(`media: PDF image extraction skipped; ${String(err)}`);
    return { text, images: [] };
  }
  const { createCanvas } = canvasModule;
  const images: InputImageContent[] = [];
  for (let pageNum = 1; pageNum <= maxPages; pageNum += 1) {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const maxPixels = limits.pdf.maxPixels;
    const pixelBudget = Math.max(1, maxPixels);
    const pagePixels = viewport.width * viewport.height;
    const scale = Math.min(1, Math.sqrt(pixelBudget / pagePixels));
    const scaled = page.getViewport({ scale: Math.max(0.1, scale) });
    const canvas = createCanvas(Math.ceil(scaled.width), Math.ceil(scaled.height));
    await page.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      viewport: scaled,
    }).promise;
    const png = canvas.toBuffer("image/png");
    images.push({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
  }

  return { text, images };
}

export async function extractImageContentFromSource(
  source: InputImageSource,
  limits: InputImageLimits,
): Promise<InputImageContent> {
  if (source.type === "base64") {
    if (!source.data) {
      throw new Error("input_image base64 source missing 'data' field");
    }
    const mimeType = normalizeMimeType(source.mediaType) ?? "image/png";
    if (!limits.allowedMimes.has(mimeType)) {
      throw new Error(`Unsupported image MIME type: ${mimeType}`);
    }
    const buffer = Buffer.from(source.data, "base64");
    if (buffer.byteLength > limits.maxBytes) {
      throw new Error(
        `Image too large: ${buffer.byteLength} bytes (limit: ${limits.maxBytes} bytes)`,
      );
    }
    return { type: "image", data: source.data, mimeType };
  }

  if (source.type === "url" && source.url) {
    if (!limits.allowUrl) {
      throw new Error("input_image URL sources are disabled by config");
    }
    const result = await fetchWithGuard({
      url: source.url,
      maxBytes: limits.maxBytes,
      timeoutMs: limits.timeoutMs,
      maxRedirects: limits.maxRedirects,
    });
    if (!limits.allowedMimes.has(result.mimeType)) {
      throw new Error(`Unsupported image MIME type from URL: ${result.mimeType}`);
    }
    return { type: "image", data: result.buffer.toString("base64"), mimeType: result.mimeType };
  }

  throw new Error("input_image must have 'source.url' or 'source.data'");
}

export async function extractFileContentFromSource(params: {
  source: InputFileSource;
  limits: InputFileLimits;
}): Promise<InputFileExtractResult> {
  const { source, limits } = params;
  const filename = source.filename || "file";

  let buffer: Buffer;
  let mimeType: string | undefined;
  let charset: string | undefined;

  if (source.type === "base64") {
    if (!source.data) {
      throw new Error("input_file base64 source missing 'data' field");
    }
    const parsed = parseContentType(source.mediaType);
    mimeType = parsed.mimeType;
    charset = parsed.charset;
    buffer = Buffer.from(source.data, "base64");
  } else if (source.type === "url" && source.url) {
    if (!limits.allowUrl) {
      throw new Error("input_file URL sources are disabled by config");
    }
    const result = await fetchWithGuard({
      url: source.url,
      maxBytes: limits.maxBytes,
      timeoutMs: limits.timeoutMs,
      maxRedirects: limits.maxRedirects,
    });
    const parsed = parseContentType(result.contentType);
    mimeType = parsed.mimeType ?? normalizeMimeType(result.mimeType);
    charset = parsed.charset;
    buffer = result.buffer;
  } else {
    throw new Error("input_file must have 'source.url' or 'source.data'");
  }

  if (buffer.byteLength > limits.maxBytes) {
    throw new Error(`File too large: ${buffer.byteLength} bytes (limit: ${limits.maxBytes} bytes)`);
  }

  if (!mimeType) {
    throw new Error("input_file missing media type");
  }
  if (!limits.allowedMimes.has(mimeType)) {
    throw new Error(`Unsupported file MIME type: ${mimeType}`);
  }

  if (mimeType === "application/pdf") {
    const extracted = await extractPdfContent({ buffer, limits });
    const text = extracted.text ? clampText(extracted.text, limits.maxChars) : "";
    return {
      filename,
      text,
      images: extracted.images.length > 0 ? extracted.images : undefined,
    };
  }

  const text = clampText(decodeTextContent(buffer, charset), limits.maxChars);
  return { filename, text };
}
