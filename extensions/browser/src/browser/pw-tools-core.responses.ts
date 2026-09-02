/**
 * Response-body retrieval for Playwright-backed browser tools.
 */
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { Response } from "playwright-core";
import { toErrorObject } from "../infra/errors.js";
import { ensurePageState, getPageForTargetId } from "./pw-session.js";
import { normalizeTimeoutMs } from "./pw-tools-core.shared.js";
import { matchBrowserUrlPattern } from "./url-pattern.js";

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
            new Error(`Failed to read response body for "${response.url()}": ${String(error)}`, {
              cause: error,
            }),
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
      url: response.url(),
      status: response.status(),
      headers: response.headers(),
      body,
      truncated: buffer.byteLength > maxBytes || bodyText.length > maxChars ? true : undefined,
    };
  } finally {
    cleanup();
  }
}
