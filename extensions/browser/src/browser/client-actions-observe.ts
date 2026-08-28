/**
 * Browser client observation helpers.
 *
 * Wraps browser-control endpoints that read console/debug data or save page
 * output without directly mutating page state.
 */
import type { BrowserActionPathResult } from "./client-actions-types.js";
import { buildProfileQuery, withBaseUrl } from "./client-actions-url.js";
import { fetchBrowserJson } from "./client-fetch.js";
import type {
  BrowserConsoleMessage,
  BrowserNetworkRequest,
  BrowserPageError,
} from "./pw-session.js";

function buildQuerySuffix(params: Array<[string, string | boolean | undefined]>): string {
  const query = new URLSearchParams();
  for (const [key, value] of params) {
    if (typeof value === "boolean") {
      query.set(key, String(value));
      continue;
    }
    if (typeof value === "string" && value.length > 0) {
      query.set(key, value);
    }
  }
  const encoded = query.toString();
  return encoded.length > 0 ? `?${encoded}` : "";
}

/** Read browser console messages for a tab. */
export async function browserConsoleMessages(
  baseUrl: string | undefined,
  opts: { level?: string; targetId?: string; profile?: string; signal?: AbortSignal } = {},
): Promise<{ ok: true; messages: BrowserConsoleMessage[]; targetId: string; url?: string }> {
  const suffix = buildQuerySuffix([
    ["level", opts.level],
    ["targetId", opts.targetId],
    ["profile", opts.profile],
  ]);
  return await fetchBrowserJson<{
    ok: true;
    messages: BrowserConsoleMessage[];
    targetId: string;
    url?: string;
  }>(withBaseUrl(baseUrl, `/console${suffix}`), { timeoutMs: 20000, signal: opts.signal });
}

/** Read the collected network request log for a tab. */
export async function browserRequests(
  baseUrl: string | undefined,
  opts: {
    filter?: string;
    clear?: boolean;
    targetId?: string;
    profile?: string;
    signal?: AbortSignal;
  } = {},
): Promise<{ ok: true; requests: BrowserNetworkRequest[]; targetId: string; url?: string }> {
  const suffix = buildQuerySuffix([
    ["filter", opts.filter],
    ["clear", opts.clear],
    ["targetId", opts.targetId],
    ["profile", opts.profile],
  ]);
  return await fetchBrowserJson(withBaseUrl(baseUrl, `/requests${suffix}`), {
    timeoutMs: 20000,
    signal: opts.signal,
  });
}

/** Read the collected page error log for a tab. */
export async function browserErrors(
  baseUrl: string | undefined,
  opts: {
    clear?: boolean;
    targetId?: string;
    profile?: string;
    signal?: AbortSignal;
  } = {},
): Promise<{ ok: true; errors: BrowserPageError[]; targetId: string; url?: string }> {
  const suffix = buildQuerySuffix([
    ["clear", opts.clear],
    ["targetId", opts.targetId],
    ["profile", opts.profile],
  ]);
  return await fetchBrowserJson(withBaseUrl(baseUrl, `/errors${suffix}`), {
    timeoutMs: 20000,
    signal: opts.signal,
  });
}

/** Read bounded visible text without executing page-supplied code. */
export async function browserPageText(
  baseUrl: string | undefined,
  opts: {
    targetId?: string;
    selector?: string;
    maxChars: number;
    profile?: string;
    signal?: AbortSignal;
  },
): Promise<{ ok: true; targetId: string; url?: string; text: string; truncated: boolean }> {
  const suffix = buildQuerySuffix([
    ["targetId", opts.targetId],
    ["selector", opts.selector],
    ["maxChars", String(opts.maxChars)],
    ["profile", opts.profile],
  ]);
  return await fetchBrowserJson(withBaseUrl(baseUrl, `/text${suffix}`), {
    timeoutMs: 20000,
    signal: opts.signal,
  });
}

/** Apply one of the browser control service's existing emulation settings. */
export async function browserEmulateSetting(
  baseUrl: string | undefined,
  opts: {
    setting: "device" | "media" | "timezone" | "locale";
    body: Record<string, string | undefined>;
    profile?: string;
    signal?: AbortSignal;
  },
): Promise<{ ok: true; targetId: string }> {
  return await fetchBrowserJson(
    withBaseUrl(baseUrl, `/set/${opts.setting}${buildProfileQuery(opts.profile)}`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts.body),
      timeoutMs: 20000,
      signal: opts.signal,
    },
  );
}

/** Save the current page as PDF through browser control. */
export async function browserPdfSave(
  baseUrl: string | undefined,
  opts: { targetId?: string; profile?: string; signal?: AbortSignal } = {},
): Promise<BrowserActionPathResult> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionPathResult>(withBaseUrl(baseUrl, `/pdf${q}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetId: opts.targetId }),
    timeoutMs: 20000,
    signal: opts.signal,
  });
}
