import type {
  BrowserActionOk,
  BrowserActionPathResult,
  BrowserActionTabResult,
} from "./client-actions-types.js";
import { fetchBrowserJson } from "./client-fetch.js";

function buildProfileQuery(profile?: string): string {
  return profile ? `?profile=${encodeURIComponent(profile)}` : "";
}

function withBaseUrl(baseUrl: string | undefined, path: string): string {
  const trimmed = baseUrl?.trim();
  if (!trimmed) return path;
  return `${trimmed.replace(/\/$/, "")}${path}`;
}

export type BrowserFormField = {
  ref: string;
  type: string;
  value?: string | number | boolean;
};

export type BrowserActRequest =
  | {
      kind: "click";
      ref: string;
      targetId?: string;
      doubleClick?: boolean;
      button?: string;
      modifiers?: string[];
      timeoutMs?: number;
    }
  | {
      kind: "type";
      ref: string;
      text: string;
      targetId?: string;
      submit?: boolean;
      slowly?: boolean;
      timeoutMs?: number;
    }
  | { kind: "press"; key: string; targetId?: string; delayMs?: number }
  | { kind: "hover"; ref: string; targetId?: string; timeoutMs?: number }
  | {
      kind: "scrollIntoView";
      ref: string;
      targetId?: string;
      timeoutMs?: number;
    }
  | {
      kind: "drag";
      startRef: string;
      endRef: string;
      targetId?: string;
      timeoutMs?: number;
    }
  | {
      kind: "select";
      ref: string;
      values: string[];
      targetId?: string;
      timeoutMs?: number;
    }
  | {
      kind: "fill";
      fields: BrowserFormField[];
      targetId?: string;
      timeoutMs?: number;
    }
  | { kind: "resize"; width: number; height: number; targetId?: string }
  | {
      kind: "wait";
      timeMs?: number;
      text?: string;
      textGone?: string;
      selector?: string;
      url?: string;
      loadState?: "load" | "domcontentloaded" | "networkidle";
      fn?: string;
      targetId?: string;
      timeoutMs?: number;
    }
  | { kind: "evaluate"; fn: string; ref?: string; targetId?: string }
  | { kind: "close"; targetId?: string };

export type BrowserActResponse = {
  ok: true;
  targetId: string;
  url?: string;
  result?: unknown;
};

export type BrowserDownloadPayload = {
  url: string;
  suggestedFilename: string;
  path: string;
};

export async function browserNavigate(
  baseUrl: string | undefined,
  opts: {
    url: string;
    targetId?: string;
    profile?: string;
  },
): Promise<BrowserActionTabResult> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionTabResult>(withBaseUrl(baseUrl, `/navigate${q}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: opts.url, targetId: opts.targetId }),
    timeoutMs: 20000,
  });
}

export async function browserArmDialog(
  baseUrl: string | undefined,
  opts: {
    accept: boolean;
    promptText?: string;
    targetId?: string;
    timeoutMs?: number;
    profile?: string;
  },
): Promise<BrowserActionOk> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionOk>(withBaseUrl(baseUrl, `/hooks/dialog${q}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      accept: opts.accept,
      promptText: opts.promptText,
      targetId: opts.targetId,
      timeoutMs: opts.timeoutMs,
    }),
    timeoutMs: 20000,
  });
}

export async function browserArmFileChooser(
  baseUrl: string | undefined,
  opts: {
    paths: string[];
    ref?: string;
    inputRef?: string;
    element?: string;
    targetId?: string;
    timeoutMs?: number;
    profile?: string;
  },
): Promise<BrowserActionOk> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionOk>(withBaseUrl(baseUrl, `/hooks/file-chooser${q}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      paths: opts.paths,
      ref: opts.ref,
      inputRef: opts.inputRef,
      element: opts.element,
      targetId: opts.targetId,
      timeoutMs: opts.timeoutMs,
    }),
    timeoutMs: 20000,
  });
}

export async function browserWaitForDownload(
  baseUrl: string | undefined,
  opts: {
    path?: string;
    targetId?: string;
    timeoutMs?: number;
    profile?: string;
  },
): Promise<{ ok: true; targetId: string; download: BrowserDownloadPayload }> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<{
    ok: true;
    targetId: string;
    download: BrowserDownloadPayload;
  }>(withBaseUrl(baseUrl, `/wait/download${q}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      targetId: opts.targetId,
      path: opts.path,
      timeoutMs: opts.timeoutMs,
    }),
    timeoutMs: 20000,
  });
}

export async function browserDownload(
  baseUrl: string | undefined,
  opts: {
    ref: string;
    path: string;
    targetId?: string;
    timeoutMs?: number;
    profile?: string;
  },
): Promise<{ ok: true; targetId: string; download: BrowserDownloadPayload }> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<{
    ok: true;
    targetId: string;
    download: BrowserDownloadPayload;
  }>(withBaseUrl(baseUrl, `/download${q}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      targetId: opts.targetId,
      ref: opts.ref,
      path: opts.path,
      timeoutMs: opts.timeoutMs,
    }),
    timeoutMs: 20000,
  });
}

export async function browserAct(
  baseUrl: string | undefined,
  req: BrowserActRequest,
  opts?: { profile?: string },
): Promise<BrowserActResponse> {
  const q = buildProfileQuery(opts?.profile);
  return await fetchBrowserJson<BrowserActResponse>(withBaseUrl(baseUrl, `/act${q}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
    timeoutMs: 20000,
  });
}

export async function browserScreenshotAction(
  baseUrl: string | undefined,
  opts: {
    targetId?: string;
    fullPage?: boolean;
    ref?: string;
    element?: string;
    type?: "png" | "jpeg";
    profile?: string;
  },
): Promise<BrowserActionPathResult> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionPathResult>(withBaseUrl(baseUrl, `/screenshot${q}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      targetId: opts.targetId,
      fullPage: opts.fullPage,
      ref: opts.ref,
      element: opts.element,
      type: opts.type,
    }),
    timeoutMs: 20000,
  });
}
