import path from "node:path";

import * as ipaddr from "ipaddr.js";

import { detectMime, extensionForMime } from "./mime.js";

/**
 * SSRF protection: validates that a URL is safe to fetch (not localhost, private IPs, etc.)
 */
function isUrlAllowed(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  // Only allow http/https
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return false;
  }

  const hostname = parsed.hostname;

  // Block localhost variations
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return false;
  }

  // Check if hostname is an IP address
  try {
    // Handle IPv6 brackets [::1] -> ::1
    const cleanHostname = hostname.replace(/^\[|\]$/g, "");
    const addr = ipaddr.parse(cleanHostname);
    const range = addr.range();

    // Block all private/special ranges
    const blockedRanges = [
      "loopback", // 127.0.0.0/8, ::1
      "private", // 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, fc00::/7
      "linkLocal", // 169.254.0.0/16, fe80::/10
      "uniqueLocal", // fc00::/7
      "unspecified", // 0.0.0.0, ::
    ];

    if (blockedRanges.includes(range)) {
      return false;
    }
  } catch {
    // Not a valid IP - it's a hostname, allow DNS resolution
    // Note: DNS rebinding is still possible but harder to exploit
  }

  return true;
}

type FetchMediaResult = {
  buffer: Buffer;
  contentType?: string;
  fileName?: string;
};

export type MediaFetchErrorCode = "max_bytes" | "http_error" | "fetch_failed";

export class MediaFetchError extends Error {
  readonly code: MediaFetchErrorCode;

  constructor(code: MediaFetchErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "MediaFetchError";
  }
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type FetchMediaOptions = {
  url: string;
  fetchImpl?: FetchLike;
  filePathHint?: string;
  maxBytes?: number;
};

function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}

function parseContentDispositionFileName(header?: string | null): string | undefined {
  if (!header) return undefined;
  const starMatch = /filename\*\s*=\s*([^;]+)/i.exec(header);
  if (starMatch?.[1]) {
    const cleaned = stripQuotes(starMatch[1].trim());
    const encoded = cleaned.split("''").slice(1).join("''") || cleaned;
    try {
      return path.basename(decodeURIComponent(encoded));
    } catch {
      return path.basename(encoded);
    }
  }
  const match = /filename\s*=\s*([^;]+)/i.exec(header);
  if (match?.[1]) return path.basename(stripQuotes(match[1].trim()));
  return undefined;
}

async function readErrorBodySnippet(res: Response, maxChars = 200): Promise<string | undefined> {
  try {
    const text = await res.text();
    if (!text) return undefined;
    const collapsed = text.replace(/\s+/g, " ").trim();
    if (!collapsed) return undefined;
    if (collapsed.length <= maxChars) return collapsed;
    return `${collapsed.slice(0, maxChars)}…`;
  } catch {
    return undefined;
  }
}

const MAX_REDIRECTS = 5;

export async function fetchRemoteMedia(options: FetchMediaOptions): Promise<FetchMediaResult> {
  const { url, fetchImpl, filePathHint, maxBytes } = options;

  // SSRF protection: block private/local addresses
  if (!isUrlAllowed(url)) {
    throw new MediaFetchError("fetch_failed", `URL not allowed: blocked private/local address`);
  }

  const fetcher: FetchLike | undefined = fetchImpl ?? globalThis.fetch;
  if (!fetcher) {
    throw new Error("fetch is not available");
  }

  // Follow redirects manually to validate each redirect URL against SSRF rules
  let currentUrl = url;
  let res: Response;
  let redirectCount = 0;

  while (true) {
    try {
      res = await fetcher(currentUrl, { redirect: "manual" });
    } catch (err) {
      throw new MediaFetchError(
        "fetch_failed",
        `Failed to fetch media from ${currentUrl}: ${String(err)}`,
      );
    }

    // Handle redirects (3xx status codes)
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) {
        throw new MediaFetchError(
          "http_error",
          `Redirect from ${currentUrl} missing Location header`,
        );
      }

      // Resolve relative redirects
      let redirectUrl: string;
      try {
        redirectUrl = new URL(location, currentUrl).href;
      } catch {
        throw new MediaFetchError("http_error", `Invalid redirect URL: ${location}`);
      }

      // SSRF protection: validate redirect target
      if (!isUrlAllowed(redirectUrl)) {
        throw new MediaFetchError(
          "fetch_failed",
          `Redirect blocked: target URL not allowed (private/local address)`,
        );
      }

      redirectCount++;
      if (redirectCount > MAX_REDIRECTS) {
        throw new MediaFetchError("fetch_failed", `Too many redirects (max ${MAX_REDIRECTS})`);
      }

      currentUrl = redirectUrl;
      continue;
    }

    // Not a redirect, exit loop
    break;
  }

  if (!res.ok) {
    const statusText = res.statusText ? ` ${res.statusText}` : "";
    const redirected = currentUrl !== url ? ` (redirected to ${currentUrl})` : "";
    let detail = `HTTP ${res.status}${statusText}`;
    if (!res.body) {
      detail = `HTTP ${res.status}${statusText}; empty response body`;
    } else {
      const snippet = await readErrorBodySnippet(res);
      if (snippet) detail += `; body: ${snippet}`;
    }
    throw new MediaFetchError(
      "http_error",
      `Failed to fetch media from ${url}${redirected}: ${detail}`,
    );
  }

  const contentLength = res.headers.get("content-length");
  if (maxBytes && contentLength) {
    const length = Number(contentLength);
    if (Number.isFinite(length) && length > maxBytes) {
      throw new MediaFetchError(
        "max_bytes",
        `Failed to fetch media from ${url}: content length ${length} exceeds maxBytes ${maxBytes}`,
      );
    }
  }

  const buffer = maxBytes
    ? await readResponseWithLimit(res, maxBytes)
    : Buffer.from(await res.arrayBuffer());
  let fileNameFromUrl: string | undefined;
  try {
    const parsed = new URL(url);
    const base = path.basename(parsed.pathname);
    fileNameFromUrl = base || undefined;
  } catch {
    // ignore parse errors; leave undefined
  }

  const headerFileName = parseContentDispositionFileName(res.headers.get("content-disposition"));
  let fileName =
    headerFileName || fileNameFromUrl || (filePathHint ? path.basename(filePathHint) : undefined);

  const filePathForMime =
    headerFileName && path.extname(headerFileName) ? headerFileName : (filePathHint ?? url);
  const contentType = await detectMime({
    buffer,
    headerMime: res.headers.get("content-type"),
    filePath: filePathForMime,
  });
  if (fileName && !path.extname(fileName) && contentType) {
    const ext = extensionForMime(contentType);
    if (ext) fileName = `${fileName}${ext}`;
  }

  return {
    buffer,
    contentType: contentType ?? undefined,
    fileName,
  };
}

async function readResponseWithLimit(res: Response, maxBytes: number): Promise<Buffer> {
  const body = res.body;
  if (!body || typeof body.getReader !== "function") {
    const fallback = Buffer.from(await res.arrayBuffer());
    if (fallback.length > maxBytes) {
      throw new MediaFetchError(
        "max_bytes",
        `Failed to fetch media from ${res.url || "response"}: payload exceeds maxBytes ${maxBytes}`,
      );
    }
    return fallback;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.length) {
        total += value.length;
        if (total > maxBytes) {
          try {
            await reader.cancel();
          } catch {}
          throw new MediaFetchError(
            "max_bytes",
            `Failed to fetch media from ${res.url || "response"}: payload exceeds maxBytes ${maxBytes}`,
          );
        }
        chunks.push(value);
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }

  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total,
  );
}

// Export for testing
export { isUrlAllowed as _isUrlAllowed };
