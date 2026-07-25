/**
 * Response-body retrieval for Playwright-backed browser tools.
 */
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
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

  const page = await getPageForTargetId(opts);
  ensurePageState(page);

  const promise = new Promise<unknown>((resolve, reject) => {
    let done = false;
    let timer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
      }
      timer = undefined;
      if (handler) {
        page.off("response", handler as never);
      }
    };

    const handler: ((resp: unknown) => void) | undefined = (resp: unknown) => {
      if (done) {
        return;
      }
      const r = resp as { url?: () => string };
      const u = r.url?.() || "";
      if (!matchBrowserUrlPattern(pattern, u)) {
        return;
      }
      done = true;
      cleanup();
      resolve(resp);
    };

    page.on("response", handler as never);
    timer = setTimeout(() => {
      if (done) {
        return;
      }
      done = true;
      cleanup();
      reject(
        new Error(
          `Response not found for url pattern "${pattern}". Run 'openclaw browser requests' to inspect recent network activity.`,
        ),
      );
    }, timeout);
  });

  const resp = (await promise) as {
    url?: () => string;
    status?: () => number;
    headers?: () => Record<string, string>;
    body?: () => Promise<Buffer>;
    text?: () => Promise<string>;
  };

  const url = resp.url?.() || "";
  const status = resp.status?.();
  const headers = resp.headers?.();

  let bodyText = "";
  let bodyByteLength = 0;
  try {
    if (typeof resp.body === "function") {
      const buf = await resp.body();
      bodyByteLength = buf.byteLength;
      // Playwright exposes only a full-body Buffer. Bound the second allocation
      // while preserving the existing response-prefix contract.
      bodyText = new TextDecoder("utf-8").decode(buf.subarray(0, maxBytes));
    }
  } catch (err) {
    throw new Error(`Failed to read response body for "${url}": ${String(err)}`, { cause: err });
  }

  const trimmed = bodyText.length > maxChars ? truncateUtf16Safe(bodyText, maxChars) : bodyText;
  return {
    url,
    status,
    headers,
    body: trimmed,
    truncated: bodyByteLength > maxBytes || bodyText.length > maxChars ? true : undefined,
  };
}
