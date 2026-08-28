/**
 * Response-body retrieval for Playwright-backed browser tools.
 */
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { Response } from "playwright-core";
import { toErrorObject } from "../infra/errors.js";
import { redactBrowserNavigationUrl } from "./navigation-guard.js";
import { ensurePageState, getPageForTargetId } from "./pw-session.js";
import { normalizeTimeoutMs } from "./pw-tools-core.shared.js";
import { matchBrowserUrlPattern } from "./url-pattern.js";

const URL_RESPONSE_HEADER_NAMES = new Set(["content-location", "link", "location", "refresh"]);
const CREDENTIAL_RESPONSE_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
]);
const CREDENTIAL_RESPONSE_HEADER_NAME_RE =
  /(?:^|[-_])(?:access[-_]?token|api[-_]?key|auth(?:orization)?|cookie|credential|csrf[-_]?token|id[-_]?token|password|refresh[-_]?token|secret|token)(?:$|[-_])/iu;

function redactResponseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }
  const direct = redactBrowserNavigationUrl(trimmed);
  if (direct !== "[redacted invalid browser URL]") {
    return direct;
  }
  if (/^[a-z][a-z\d+.-]*:/iu.test(trimmed)) {
    return direct;
  }
  try {
    const parsed = new URL(trimmed, "https://openclaw.invalid");
    const redacted = redactBrowserNavigationUrl(parsed.toString());
    if (redacted === "[redacted invalid browser URL]" || redacted === parsed.toString()) {
      return value;
    }
    const redactedUrl = new URL(redacted);
    if (trimmed.startsWith("#")) {
      return redactedUrl.hash;
    }
    if (trimmed.startsWith("?")) {
      return `${redactedUrl.search}${redactedUrl.hash}`;
    }
    if (trimmed.startsWith("//")) {
      return `//${redactedUrl.host}${redactedUrl.pathname}${redactedUrl.search}${redactedUrl.hash}`;
    }
    const pathname = trimmed.startsWith("/")
      ? redactedUrl.pathname
      : redactedUrl.pathname.replace(/^\//u, "");
    return `${pathname}${redactedUrl.search}${redactedUrl.hash}`;
  } catch {
    return value;
  }
}

function redactResponseHeaderValue(name: string, value: string): string {
  const normalizedName = name.trim().toLowerCase();
  if (
    CREDENTIAL_RESPONSE_HEADER_NAMES.has(normalizedName) ||
    CREDENTIAL_RESPONSE_HEADER_NAME_RE.test(normalizedName)
  ) {
    return "REDACTED";
  }
  switch (normalizedName) {
    case "location":
    case "content-location":
      return redactResponseUrl(value);
    case "refresh":
      return value.replace(
        /(\burl\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^;,]*))/giu,
        (
          _match,
          prefix: string,
          doubleQuotedUrl: string | undefined,
          singleQuotedUrl: string | undefined,
          unquotedUrl: string | undefined,
        ) => {
          const quote =
            doubleQuotedUrl !== undefined ? '"' : singleQuotedUrl !== undefined ? "'" : "";
          const url = doubleQuotedUrl ?? singleQuotedUrl ?? unquotedUrl ?? "";
          return `${prefix}${quote}${redactResponseUrl(url)}${quote}`;
        },
      );
    case "link":
      return value.replace(/<([^>]+)>/gu, (_match, url: string) => `<${redactResponseUrl(url)}>`);
    default:
      return value;
  }
}

function redactResponseHeaders(
  headers?: Record<string, string>,
): Record<string, string> | undefined {
  if (!headers) {
    return headers;
  }
  let changed = false;
  const redacted = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => {
      const normalizedName = name.trim().toLowerCase();
      if (
        !URL_RESPONSE_HEADER_NAMES.has(normalizedName) &&
        !CREDENTIAL_RESPONSE_HEADER_NAMES.has(normalizedName) &&
        !CREDENTIAL_RESPONSE_HEADER_NAME_RE.test(normalizedName)
      ) {
        return [name, value];
      }
      const redactedValue = redactResponseHeaderValue(name, value);
      changed ||= redactedValue !== value;
      return [name, redactedValue];
    }),
  );
  return changed ? redacted : headers;
}

/** Waits for a response URL pattern and returns a bounded text body. */
export async function responseBodyViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  url: string;
  timeoutMs?: number;
  maxChars?: number;
  signal?: AbortSignal;
}): Promise<{
  url: string;
  status?: number;
  headers?: Record<string, string>;
  body: string;
  truncated?: boolean;
}> {
  const pattern = normalizeOptionalString(opts.url) ?? "";
  if (!pattern) {
    throw new Error("url is required");
  }
  const maxChars =
    typeof opts.maxChars === "number" && Number.isFinite(opts.maxChars)
      ? Math.max(1, Math.min(5_000_000, Math.floor(opts.maxChars)))
      : 200_000;
  const timeout = normalizeTimeoutMs(opts.timeoutMs, 20_000);
  const maxBytes = maxChars * 4;

  opts.signal?.throwIfAborted();
  const page = await getPageForTargetId(opts);
  opts.signal?.throwIfAborted();
  ensurePageState(page);

  let cleanup!: () => void;
  const promise = new Promise<{ response: Response; buffer: Buffer }>((resolve, reject) => {
    let matched = false;
    const handler = (response: Response) => {
      if (matched || !matchBrowserUrlPattern(pattern, response.url())) {
        return;
      }
      matched = true;
      page.off("response", handler);
      // Response headers arrive before the body completes. Keep the same
      // deadline and cancellation owner until those bytes are available.
      void response.body().then(
        (buffer) => resolve({ response, buffer }),
        (error: unknown) =>
          reject(
            new Error(
              `Failed to read response body for "${redactResponseUrl(response.url())}": ${String(error)}`,
              { cause: error },
            ),
          ),
      );
    };
    const onAbort = () => reject(toErrorObject(opts.signal?.reason, "Response request aborted."));
    const onClose = () => reject(new Error("Page closed before response body was available."));
    const timer = setTimeout(() => {
      reject(
        new Error(
          matched
            ? `Response body timed out after ${timeout}ms for url pattern "${pattern}".`
            : `Response not found for url pattern "${pattern}". Run 'openclaw browser requests' to inspect recent network activity.`,
        ),
      );
    }, timeout);
    cleanup = () => {
      clearTimeout(timer);
      page.off("response", handler);
      page.off("close", onClose);
      opts.signal?.removeEventListener("abort", onAbort);
    };
    page.on("response", handler);
    page.on("close", onClose);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
  });

  try {
    const { response, buffer } = await promise;
    // Playwright exposes only a full-body Buffer. Bound the second allocation
    // while preserving the existing response-prefix contract.
    const bodyText = new TextDecoder("utf-8").decode(buffer.subarray(0, maxBytes));
    const body = bodyText.length > maxChars ? truncateUtf16Safe(bodyText, maxChars) : bodyText;
    return {
      url: redactBrowserNavigationUrl(response.url()),
      status: response.status(),
      headers: redactResponseHeaders(response.headers()),
      body,
      truncated: buffer.byteLength > maxBytes || bodyText.length > maxChars ? true : undefined,
    };
  } finally {
    cleanup();
  }
}
