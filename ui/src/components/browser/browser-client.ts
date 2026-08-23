// Typed Control UI wrapper over the `browser.request` gateway method.
//
// The gateway method speaks an HTTP-shaped envelope ({method, path, body})
// that is dispatched against the browser plugin's control routes, either
// locally or via a browser-capable node. This module narrows the handful of
// routes the browser panel needs and keeps route-path knowledge in one place.
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { buildAssistantMediaUrl } from "../../app/assistant-media.ts";
import { t } from "../../i18n/index.ts";

const BROWSER_REQUEST_METHOD = "browser.request";
const BROWSER_SCREENSHOT_FETCH_TIMEOUT_MS = 30_000;

export type BrowserPanelTab = {
  /**
   * Stable panel handle: the plugin's per-profile tab alias (`t1`, a label)
   * when present, else the raw CDP target id. Raw target ids are volatile
   * across form submits/target replacement; aliases migrate server-side, so
   * the panel must address tabs by this id.
   */
  id: string;
  targetId: string;
  title: string;
  url: string;
};

type BrowserTabsSnapshot = {
  running: boolean;
  tabs: BrowserPanelTab[];
};

type BrowserScreenshotCapture = {
  path: string;
  targetId: string;
  url: string;
};

/** CSS-pixel geometry of the remote page, used to map panel coords to page coords. */
export type BrowserPageMetrics = {
  cssWidth: number;
  cssHeight: number;
  title: string;
  url: string;
};

export type BrowserInspectedNode = {
  tag: string;
  id: string;
  classes: string[];
  role: string;
  name: string;
  /** Bounding rect in remote CSS viewport pixels. */
  rect: { x: number; y: number; width: number; height: number };
  focusable: boolean;
};

type BrowserRequestEnvelope = {
  method: "GET" | "POST" | "DELETE";
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  timeoutMs?: number;
};

function browserRequest<T>(client: GatewayBrowserClient, envelope: BrowserRequestEnvelope) {
  return client.request<T>(BROWSER_REQUEST_METHOD, envelope);
}

function stringOrEmpty(value: unknown): string {
  return readStringValue(value) ?? "";
}

function normalizeTab(value: unknown): BrowserPanelTab | null {
  const record = asRecord(value);
  const targetId = stringOrEmpty(record?.targetId);
  if (!targetId) {
    return null;
  }
  const tabId = stringOrEmpty(record?.tabId);
  return {
    id: tabId || targetId,
    targetId,
    title: stringOrEmpty(record?.title),
    url: stringOrEmpty(record?.url),
  };
}

export async function listBrowserTabs(client: GatewayBrowserClient): Promise<BrowserTabsSnapshot> {
  const result = asRecord(await browserRequest(client, { method: "GET", path: "/tabs" }));
  const tabs = Array.isArray(result?.tabs)
    ? result.tabs.flatMap((tab) => normalizeTab(tab) ?? [])
    : [];
  return { running: result?.running === true, tabs };
}

export async function startBrowser(client: GatewayBrowserClient): Promise<void> {
  await browserRequest(client, { method: "POST", path: "/start", body: {} });
}

export async function openBrowserTab(
  client: GatewayBrowserClient,
  url: string,
): Promise<BrowserPanelTab | null> {
  return normalizeTab(
    await browserRequest(client, { method: "POST", path: "/tabs/open", body: { url } }),
  );
}

export async function focusBrowserTab(client: GatewayBrowserClient, targetId: string) {
  await browserRequest(client, { method: "POST", path: "/tabs/focus", body: { targetId } });
}

export async function closeBrowserTab(client: GatewayBrowserClient, targetId: string) {
  await browserRequest(client, {
    method: "DELETE",
    path: `/tabs/${encodeURIComponent(targetId)}`,
  });
}

export async function navigateBrowser(
  client: GatewayBrowserClient,
  params: { url: string; targetId?: string },
): Promise<{ targetId: string; url: string }> {
  const result = asRecord(
    await browserRequest(client, { method: "POST", path: "/navigate", body: params }),
  );
  return {
    targetId: stringOrEmpty(result?.targetId) || params.targetId || "",
    url: stringOrEmpty(result?.url) || params.url,
  };
}

export async function captureBrowserScreenshot(
  client: GatewayBrowserClient,
  targetId: string,
): Promise<BrowserScreenshotCapture> {
  const result = asRecord(
    await browserRequest(client, {
      method: "POST",
      path: "/screenshot",
      body: { targetId, type: "png" },
    }),
  );
  const path = stringOrEmpty(result?.path);
  if (!path) {
    throw new Error(t("browser.errors.screenshotPathMissing"));
  }
  return {
    path,
    targetId: stringOrEmpty(result?.targetId) || targetId,
    url: stringOrEmpty(result?.url),
  };
}

export async function clickBrowserCoords(
  client: GatewayBrowserClient,
  params: { targetId: string; x: number; y: number; doubleClick?: boolean },
) {
  await browserRequest(client, {
    method: "POST",
    path: "/act",
    body: {
      kind: "clickCoords",
      targetId: params.targetId,
      x: Math.max(0, Math.round(params.x)),
      y: Math.max(0, Math.round(params.y)),
      ...(params.doubleClick ? { doubleClick: true } : {}),
    },
  });
}

export async function pressBrowserKey(
  client: GatewayBrowserClient,
  params: { targetId: string; key: string },
) {
  await browserRequest(client, {
    method: "POST",
    path: "/act",
    body: { kind: "press", targetId: params.targetId, key: params.key },
  });
}

export async function resizeBrowserViewport(
  client: GatewayBrowserClient,
  params: { targetId: string; width: number; height: number },
) {
  await browserRequest(client, {
    method: "POST",
    path: "/act",
    body: {
      kind: "resize",
      targetId: params.targetId,
      width: Math.round(params.width),
      height: Math.round(params.height),
    },
  });
}

async function evaluateInBrowser<T>(
  client: GatewayBrowserClient,
  params: { targetId: string; fn: string },
): Promise<T | null> {
  const result = asRecord(
    await browserRequest(client, {
      method: "POST",
      path: "/act",
      body: { kind: "evaluate", targetId: params.targetId, fn: params.fn },
    }),
  );
  return (result?.result as T | undefined) ?? null;
}

/** True when the failure is the config-gated `browser.evaluateEnabled=false` rejection. */
export function isBrowserEvaluateDisabledError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("evaluateEnabled=false");
}

export async function scrollBrowserBy(
  client: GatewayBrowserClient,
  params: { targetId: string; deltaX: number; deltaY: number },
) {
  const dx = Math.round(params.deltaX);
  const dy = Math.round(params.deltaY);
  await evaluateInBrowser(client, {
    targetId: params.targetId,
    fn: `() => { window.scrollBy(${dx}, ${dy}); return true; }`,
  });
}

export async function goBrowserHistory(
  client: GatewayBrowserClient,
  params: { targetId: string; delta: -1 | 1 },
) {
  await evaluateInBrowser(client, {
    targetId: params.targetId,
    fn: `() => { history.go(${params.delta}); return true; }`,
  });
}

export async function readBrowserPageMetrics(
  client: GatewayBrowserClient,
  targetId: string,
): Promise<BrowserPageMetrics | null> {
  const result = asRecord(
    await evaluateInBrowser(client, {
      targetId,
      fn: "() => ({ cssWidth: window.innerWidth, cssHeight: window.innerHeight, title: document.title, url: location.href })",
    }),
  );
  const cssWidth = asFiniteNumber(result?.cssWidth);
  const cssHeight = asFiniteNumber(result?.cssHeight);
  if (!cssWidth || !cssHeight || cssWidth <= 0 || cssHeight <= 0) {
    return null;
  }
  return {
    cssWidth,
    cssHeight,
    title: stringOrEmpty(result?.title),
    url: stringOrEmpty(result?.url),
  };
}

export async function inspectBrowserElementAt(
  client: GatewayBrowserClient,
  params: { targetId: string; x: number; y: number },
): Promise<BrowserInspectedNode | null> {
  const x = Math.max(0, Math.round(params.x));
  const y = Math.max(0, Math.round(params.y));
  const result = asRecord(
    await evaluateInBrowser(client, {
      targetId: params.targetId,
      fn: `() => {
        const el = document.elementFromPoint(${x}, ${y});
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        const label = el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("title") || "";
        const text = (el.textContent || "").replace(/\\s+/g, " ").trim();
        const nameSource = label || text;
        const nameLimit = 120;
        // This serialized page function cannot call imported helpers; back up only when the cap splits a surrogate pair.
        const nameEnd = (nameSource.codePointAt(nameLimit - 1) || 0) > 0xffff ? nameLimit - 1 : nameLimit;
        return {
          tag: el.tagName.toLowerCase(),
          id: el.id || "",
          classes: Array.from(el.classList).slice(0, 6),
          role: el.getAttribute("role") || "",
          name: nameSource.slice(0, nameEnd),
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          focusable: typeof el.tabIndex === "number" && el.tabIndex >= 0,
        };
      }`,
    }),
  );
  if (!result) {
    return null;
  }
  const rect = asRecord(result.rect);
  return {
    tag: stringOrEmpty(result.tag),
    id: stringOrEmpty(result.id),
    classes: Array.isArray(result.classes)
      ? result.classes.filter((value): value is string => typeof value === "string")
      : [],
    role: stringOrEmpty(result.role),
    name: stringOrEmpty(result.name),
    rect: {
      x: asFiniteNumber(rect?.x) ?? 0,
      y: asFiniteNumber(rect?.y) ?? 0,
      width: asFiniteNumber(rect?.width) ?? 0,
      height: asFiniteNumber(rect?.height) ?? 0,
    },
    focusable: result.focusable === true,
  };
}

/**
 * Browser screenshots are written to the gateway's media store; the Control UI
 * fetches the bytes over the authenticated assistant-media HTTP route (the
 * same one chat history uses for local media previews).
 */
export async function fetchBrowserScreenshotDataUrl(params: {
  resourceBasePath: string;
  authToken: string | null;
  path: string;
}): Promise<string> {
  const headers = new Headers({ Accept: "image/*" });
  if (params.authToken) {
    headers.set("Authorization", `Bearer ${params.authToken}`);
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () =>
      controller.abort(
        new DOMException(t("browser.errors.screenshotFetchTimedOut"), "TimeoutError"),
      ),
    BROWSER_SCREENSHOT_FETCH_TIMEOUT_MS,
  );
  let blob: Blob;
  try {
    const res = await fetch(buildAssistantMediaUrl(params.path, params.resourceBasePath), {
      method: "GET",
      headers,
      credentials: "same-origin",
      signal: controller.signal,
    });
    if (!res.ok) {
      // A response stream can take indefinitely to cancel; release it without
      // delaying the stable HTTP error or defeating the request deadline.
      void res.body?.cancel().catch(() => undefined);
      throw new Error(t("browser.errors.screenshotFetchFailed", { status: String(res.status) }));
    }
    blob = await res.blob();
  } finally {
    clearTimeout(timeout);
  }
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error(t("browser.errors.screenshotReadFailed")));
      }
    });
    reader.addEventListener("error", () =>
      reject(reader.error ?? new Error(t("browser.errors.screenshotReadFailed"))),
    );
    reader.readAsDataURL(blob);
  });
}
