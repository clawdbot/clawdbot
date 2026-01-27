import type { BrowserActionPathResult, BrowserActionTargetOk } from "./client-actions-types.js";
import { fetchBrowserJson } from "./client-fetch.js";
import type {
  BrowserConsoleMessage,
  BrowserNetworkRequest,
  BrowserPageError,
} from "./pw-session.js";

function buildProfileQuery(profile?: string): string {
  return profile ? `?profile=${encodeURIComponent(profile)}` : "";
}

function withBaseUrl(baseUrl: string | undefined, path: string): string {
  const trimmed = baseUrl?.trim();
  if (!trimmed) return path;
  return `${trimmed.replace(/\/$/, "")}${path}`;
}

export async function browserConsoleMessages(
  baseUrl: string | undefined,
  opts: { level?: string; targetId?: string; profile?: string } = {},
): Promise<{ ok: true; messages: BrowserConsoleMessage[]; targetId: string }> {
  const q = new URLSearchParams();
  if (opts.level) q.set("level", opts.level);
  if (opts.targetId) q.set("targetId", opts.targetId);
  if (opts.profile) q.set("profile", opts.profile);
  const suffix = q.toString() ? `?${q.toString()}` : "";
  return await fetchBrowserJson<{
    ok: true;
    messages: BrowserConsoleMessage[];
    targetId: string;
  }>(withBaseUrl(baseUrl, `/console${suffix}`), { timeoutMs: 20000 });
}

export async function browserPdfSave(
  baseUrl: string | undefined,
  opts: { targetId?: string; profile?: string } = {},
): Promise<BrowserActionPathResult> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionPathResult>(withBaseUrl(baseUrl, `/pdf${q}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetId: opts.targetId }),
    timeoutMs: 20000,
  });
}

export async function browserPageErrors(
  baseUrl: string | undefined,
  opts: { targetId?: string; clear?: boolean; profile?: string } = {},
): Promise<{ ok: true; targetId: string; errors: BrowserPageError[] }> {
  const q = new URLSearchParams();
  if (opts.targetId) q.set("targetId", opts.targetId);
  if (typeof opts.clear === "boolean") q.set("clear", String(opts.clear));
  if (opts.profile) q.set("profile", opts.profile);
  const suffix = q.toString() ? `?${q.toString()}` : "";
  return await fetchBrowserJson<{
    ok: true;
    targetId: string;
    errors: BrowserPageError[];
  }>(withBaseUrl(baseUrl, `/errors${suffix}`), { timeoutMs: 20000 });
}

export async function browserRequests(
  baseUrl: string | undefined,
  opts: {
    targetId?: string;
    filter?: string;
    clear?: boolean;
    profile?: string;
  } = {},
): Promise<{ ok: true; targetId: string; requests: BrowserNetworkRequest[] }> {
  const q = new URLSearchParams();
  if (opts.targetId) q.set("targetId", opts.targetId);
  if (opts.filter) q.set("filter", opts.filter);
  if (typeof opts.clear === "boolean") q.set("clear", String(opts.clear));
  if (opts.profile) q.set("profile", opts.profile);
  const suffix = q.toString() ? `?${q.toString()}` : "";
  return await fetchBrowserJson<{
    ok: true;
    targetId: string;
    requests: BrowserNetworkRequest[];
  }>(withBaseUrl(baseUrl, `/requests${suffix}`), { timeoutMs: 20000 });
}

export async function browserTraceStart(
  baseUrl: string | undefined,
  opts: {
    targetId?: string;
    screenshots?: boolean;
    snapshots?: boolean;
    sources?: boolean;
    profile?: string;
  } = {},
): Promise<BrowserActionTargetOk> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionTargetOk>(withBaseUrl(baseUrl, `/trace/start${q}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      targetId: opts.targetId,
      screenshots: opts.screenshots,
      snapshots: opts.snapshots,
      sources: opts.sources,
    }),
    timeoutMs: 20000,
  });
}

export async function browserTraceStop(
  baseUrl: string | undefined,
  opts: { targetId?: string; path?: string; profile?: string } = {},
): Promise<BrowserActionPathResult> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionPathResult>(withBaseUrl(baseUrl, `/trace/stop${q}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetId: opts.targetId, path: opts.path }),
    timeoutMs: 20000,
  });
}

export async function browserHighlight(
  baseUrl: string | undefined,
  opts: { ref: string; targetId?: string; profile?: string },
): Promise<BrowserActionTargetOk> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionTargetOk>(withBaseUrl(baseUrl, `/highlight${q}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetId: opts.targetId, ref: opts.ref }),
    timeoutMs: 20000,
  });
}

export async function browserResponseBody(
  baseUrl: string | undefined,
  opts: {
    url: string;
    targetId?: string;
    timeoutMs?: number;
    maxChars?: number;
    profile?: string;
  },
): Promise<{
  ok: true;
  targetId: string;
  response: {
    url: string;
    status?: number;
    headers?: Record<string, string>;
    body: string;
    truncated?: boolean;
  };
}> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<{
    ok: true;
    targetId: string;
    response: {
      url: string;
      status?: number;
      headers?: Record<string, string>;
      body: string;
      truncated?: boolean;
    };
  }>(withBaseUrl(baseUrl, `/response/body${q}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      targetId: opts.targetId,
      url: opts.url,
      timeoutMs: opts.timeoutMs,
      maxChars: opts.maxChars,
    }),
    timeoutMs: 20000,
  });
}
