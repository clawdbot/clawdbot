import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";

export type CacheEntry<T> = {
  value: T;
  expiresAt: number;
  insertedAt: number;
};

export const DEFAULT_TIMEOUT_SECONDS = 30;
export const DEFAULT_CACHE_TTL_MINUTES = 15;
const DEFAULT_CACHE_MAX_ENTRIES = 100;

export function resolveTimeoutSeconds(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(1, Math.floor(parsed));
}

export function resolveCacheTtlMs(value: unknown, fallbackMinutes: number): number {
  const minutes =
    typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : fallbackMinutes;
  return Math.round(minutes * 60_000);
}

export function normalizeCacheKey(value: string): string {
  return normalizeLowercaseStringOrEmpty(value);
}

export function readCache<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
): { value: T; cached: boolean } | null {
  const entry = cache.get(key);
  if (!entry) {
    return null;
  }
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return { value: entry.value, cached: true };
}

export function writeCache<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  value: T,
  ttlMs: number,
) {
  if (ttlMs <= 0) {
    return;
  }
  if (cache.size >= DEFAULT_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) {
      cache.delete(oldest.value);
    }
  }
  cache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
    insertedAt: Date.now(),
  });
}

export function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  if (timeoutMs <= 0) {
    return signal ?? new AbortController().signal;
  }
  const controller = new AbortController();
  const timer = setTimeout(controller.abort.bind(controller), timeoutMs);
  if (signal) {
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        controller.abort();
      },
      { once: true },
    );
  }
  controller.signal.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
    },
    { once: true },
  );
  return controller.signal;
}

export type ReadResponseTextResult = {
  text: string;
  truncated: boolean;
  bytesRead: number;
};

const RESPONSE_CHARSET_SCAN_BYTES = 4096;
const latin1Decoder = new TextDecoder("latin1");
const utf8Decoder = new TextDecoder("utf-8");

function normalizeCharset(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/^["']|["']$/g, "") ?? "";
  return normalized && normalized.length <= 64 && /^[A-Za-z0-9._:-]+$/.test(normalized)
    ? normalized
    : undefined;
}

function readCharsetParam(value: string | null | undefined): string | undefined {
  const match = /(?:^|;)\s*charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/i.exec(value ?? "");
  return normalizeCharset(match?.[1] ?? match?.[2] ?? match?.[3]);
}

function readAttribute(tag: string, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const match of tag.matchAll(
    /([A-Za-z0-9:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g,
  )) {
    if (match[1]?.toLowerCase() === target) {
      return match[2] ?? match[3] ?? match[4] ?? "";
    }
  }
  return undefined;
}

function shouldSniffDocumentCharset(contentType: string | null): boolean {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (!mediaType) {
    return true;
  }
  return (
    mediaType === "text/html" ||
    mediaType === "application/xhtml+xml" ||
    mediaType === "text/xml" ||
    mediaType === "application/xml" ||
    mediaType.endsWith("+xml")
  );
}

function sniffCharset(contentType: string | null, bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return "utf-8";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return "utf-16le";
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return "utf-16be";
  }
  if (!shouldSniffDocumentCharset(contentType)) {
    return undefined;
  }

  const head = latin1Decoder.decode(
    bytes.subarray(0, Math.min(bytes.byteLength, RESPONSE_CHARSET_SCAN_BYTES)),
  );
  const xmlEncoding = /<\?xml\s+[^>]*\bencoding\s*=\s*(?:"([^"]+)"|'([^']+)')/i.exec(head);
  if (xmlEncoding) {
    return normalizeCharset(xmlEncoding[1] ?? xmlEncoding[2]);
  }

  for (const match of head.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const charset = normalizeCharset(readAttribute(tag, "charset"));
    if (charset) {
      return charset;
    }
    if (/^content-type$/i.test(readAttribute(tag, "http-equiv") ?? "")) {
      const contentCharset = readCharsetParam(readAttribute(tag, "content"));
      if (contentCharset) {
        return contentCharset;
      }
    }
  }
  return undefined;
}

function concatBytes(parts: Uint8Array[], totalBytes: number): Uint8Array {
  if (parts.length === 1 && parts[0]?.byteLength === totalBytes) {
    return parts[0];
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

function responseContentType(res: Response): string | null {
  const headers = (res as { headers?: { get?: (name: string) => string | null } }).headers;
  return typeof headers?.get === "function" ? headers.get("content-type") : null;
}

function decodeResponseBytes(res: Response, bytes: Uint8Array): string {
  const contentType = responseContentType(res);
  const charset = readCharsetParam(contentType) ?? sniffCharset(contentType, bytes);
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes);
  } catch {
    return utf8Decoder.decode(bytes);
  }
}

export async function readResponseText(
  res: Response,
  options?: { maxBytes?: number },
): Promise<ReadResponseTextResult> {
  const maxBytesRaw = options?.maxBytes;
  const maxBytes =
    typeof maxBytesRaw === "number" && Number.isFinite(maxBytesRaw) && maxBytesRaw > 0
      ? Math.floor(maxBytesRaw)
      : undefined;

  const body = (res as unknown as { body?: unknown }).body;
  if (
    maxBytes &&
    body &&
    typeof body === "object" &&
    "getReader" in body &&
    typeof (body as { getReader: () => unknown }).getReader === "function"
  ) {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    let bytesRead = 0;
    let truncated = false;
    const parts: Uint8Array[] = [];

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        if (!value || value.byteLength === 0) {
          continue;
        }

        let chunk = value;
        if (bytesRead + chunk.byteLength > maxBytes) {
          const remaining = Math.max(0, maxBytes - bytesRead);
          if (remaining <= 0) {
            truncated = true;
            break;
          }
          chunk = chunk.subarray(0, remaining);
          truncated = true;
        }

        bytesRead += chunk.byteLength;
        parts.push(chunk);

        if (truncated || bytesRead >= maxBytes) {
          truncated = true;
          break;
        }
      }
    } catch {
      // Best-effort: return whatever we read so far.
    } finally {
      if (truncated) {
        // Some mocked or non-compliant streams never settle cancel(); do not
        // let cleanup turn a bounded read into a hung fetch.
        void reader.cancel().catch(() => undefined);
      }
    }

    const bytes = concatBytes(parts, bytesRead);
    return { text: decodeResponseBytes(res, bytes), truncated, bytesRead };
  }

  const readBytes = (res as { arrayBuffer?: () => Promise<ArrayBuffer> }).arrayBuffer;
  if (typeof readBytes === "function") {
    try {
      const bytes = new Uint8Array(await readBytes.call(res));
      return {
        text: decodeResponseBytes(res, bytes),
        truncated: false,
        bytesRead: bytes.byteLength,
      };
    } catch {
      // Fall back to text() for lightweight Response-like mocks that do not expose bytes.
    }
  }

  try {
    const text = await res.text();
    return { text, truncated: false, bytesRead: text.length };
  } catch {
    return { text: "", truncated: false, bytesRead: 0 };
  }
}
