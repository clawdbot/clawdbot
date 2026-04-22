import type { SsrFPolicy } from "../infra/net/ssrf.js";
import {
  appendCdpPath,
  assertCdpEndpointAllowed,
  fetchJson,
  isDirectCdpWebSocketEndpoint,
  isLoopbackHost,
  isWebSocketUrl,
  normalizeCdpHttpBaseForJsonEndpoints,
  withCdpSocket,
} from "./cdp.helpers.js";
import { assertBrowserNavigationAllowed, withBrowserNavigationPolicy } from "./navigation-guard.js";

export {
  appendCdpPath,
  fetchJson,
  fetchOk,
  getHeadersWithAuth,
  isWebSocketUrl,
} from "./cdp.helpers.js";

export function normalizeCdpWsUrl(wsUrl: string, cdpUrl: string): string {
  const ws = new URL(wsUrl);
  const cdp = new URL(cdpUrl);
  // Treat 0.0.0.0 and :: as wildcard bind addresses that need rewriting.
  // Containerized browsers (e.g. browserless) report ws://0.0.0.0:<internal-port>
  // in /json/version — these must be rewritten to the external cdpUrl host:port.
  const isWildcardBind = ws.hostname === "0.0.0.0" || ws.hostname === "[::]";
  if ((isLoopbackHost(ws.hostname) || isWildcardBind) && !isLoopbackHost(cdp.hostname)) {
    ws.hostname = cdp.hostname;
    const cdpPort = cdp.port || (cdp.protocol === "https:" ? "443" : "80");
    // `cdpPort` is always truthy: either the explicit cdp.port (truthy
    // string), or the "443"/"80" default from the ternary. The guard is
    // defensive against future parser edge cases.
    /* c8 ignore next 3 */
    if (cdpPort) {
      ws.port = cdpPort;
    }
    ws.protocol = cdp.protocol === "https:" ? "wss:" : "ws:";
  } else if (isLoopbackHost(ws.hostname) && isLoopbackHost(cdp.hostname)) {
    ws.hostname = cdp.hostname;
  }
  if (cdp.protocol === "https:" && ws.protocol === "ws:") {
    ws.protocol = "wss:";
  }
  if (!ws.username && !ws.password && (cdp.username || cdp.password)) {
    ws.username = cdp.username;
    ws.password = cdp.password;
  }
  for (const [key, value] of cdp.searchParams.entries()) {
    if (!ws.searchParams.has(key)) {
      ws.searchParams.append(key, value);
    }
  }
  return ws.toString();
}

export async function captureScreenshotPng(opts: {
  wsUrl: string;
  fullPage?: boolean;
}): Promise<Buffer> {
  return await captureScreenshot({
    wsUrl: opts.wsUrl,
    fullPage: opts.fullPage,
    format: "png",
  });
}

export async function captureScreenshot(opts: {
  wsUrl: string;
  fullPage?: boolean;
  format?: "png" | "jpeg";
  quality?: number; // jpeg only (0..100)
}): Promise<Buffer> {
  return await withCdpSocket(opts.wsUrl, async (send) => {
    await send("Page.enable");

    // For full-page captures, temporarily expand the viewport to the content
    // size so the entire page is within the viewport bounds.  We save the
    // current viewport state and restore it after capture so pre-existing
    // device emulation (mobile width, DPR, touch) is not lost.
    let savedVp: { w: number; h: number; dpr: number; sw: number; sh: number } | undefined;
    if (opts.fullPage) {
      const metrics = (await send("Page.getLayoutMetrics")) as {
        cssContentSize?: { width?: number; height?: number };
        contentSize?: { width?: number; height?: number };
      };
      const size = metrics?.cssContentSize ?? metrics?.contentSize;
      const contentWidth = size?.width ?? 0;
      const contentHeight = size?.height ?? 0;
      if (contentWidth > 0 && contentHeight > 0) {
        const vpResult = (await send("Runtime.evaluate", {
          expression:
            "({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio, sw: screen.width, sh: screen.height })",
          returnByValue: true,
        })) as {
          result?: {
            value?: { w?: number; h?: number; dpr?: number; sw?: number; sh?: number };
          };
        };
        const v = vpResult?.result?.value;
        const currentW = v?.w ?? 0;
        const currentH = v?.h ?? 0;
        savedVp = {
          w: currentW,
          h: currentH,
          dpr: v?.dpr ?? 1,
          sw: v?.sw ?? currentW,
          sh: v?.sh ?? currentH,
        };
        // mobile: false is the safe default — CDP provides no way to query
        // the active mobile flag, and inferring from navigator.maxTouchPoints
        // would false-positive on touch-enabled desktops.
        await send("Emulation.setDeviceMetricsOverride", {
          width: Math.ceil(Math.max(currentW, contentWidth)),
          height: Math.ceil(Math.max(currentH, contentHeight)),
          deviceScaleFactor: savedVp.dpr,
          mobile: false,
          screenWidth: savedVp.sw,
          screenHeight: savedVp.sh,
        });
      }
    }

    const format = opts.format ?? "png";
    const quality =
      format === "jpeg" ? Math.max(0, Math.min(100, Math.round(opts.quality ?? 85))) : undefined;

    try {
      // Chromium bug 40760789 (cross-origin textures missing with
      // fromSurface: true + captureBeyondViewport: true) was fixed around
      // Chrome 130. Chrome 146+ managed/headful browsers now reject
      // fromSurface: false, so we omit it and keep captureBeyondViewport: true.
      const result = (await send("Page.captureScreenshot", {
        format,
        ...(quality !== undefined ? { quality } : {}),
        captureBeyondViewport: true,
      })) as { data?: string };

      const base64 = result?.data;
      if (!base64) {
        throw new Error("Screenshot failed: missing data");
      }
      return Buffer.from(base64, "base64");
    } finally {
      if (savedVp) {
        // Clear the temporary viewport expansion first.  If the tab had
        // prior device emulation the clear will change the viewport back to
        // the browser's natural dimensions — detect that and re-apply the
        // saved emulation so the tab's original state is preserved.
        await send("Emulation.clearDeviceMetricsOverride").catch(() => {});
        try {
          const postResult = (await send("Runtime.evaluate", {
            expression:
              "({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio })",
            returnByValue: true,
          })) as { result?: { value?: { w?: number; h?: number; dpr?: number } } };
          const p = postResult?.result?.value;
          if (p?.w !== savedVp.w || p?.h !== savedVp.h || p?.dpr !== savedVp.dpr) {
            await send("Emulation.setDeviceMetricsOverride", {
              width: savedVp.w,
              height: savedVp.h,
              deviceScaleFactor: savedVp.dpr,
              mobile: false,
              screenWidth: savedVp.sw,
              screenHeight: savedVp.sh,
            });
          }
        } catch {
          // Best-effort restoration; ignore failures in the cleanup path.
        }
      }
    }
  });
}

export async function createTargetViaCdp(opts: {
  cdpUrl: string;
  url: string;
  ssrfPolicy?: SsrFPolicy;
}): Promise<{ targetId: string }> {
  await assertBrowserNavigationAllowed({
    url: opts.url,
    ...withBrowserNavigationPolicy(opts.ssrfPolicy),
  });

  let wsUrl: string;
  if (isDirectCdpWebSocketEndpoint(opts.cdpUrl)) {
    // Handshake-ready direct WebSocket URL — skip /json/version discovery.
    await assertCdpEndpointAllowed(opts.cdpUrl, opts.ssrfPolicy);
    wsUrl = opts.cdpUrl;
  } else {
    // Either an HTTP(S) CDP endpoint or a bare ws/wss root. Try
    // /json/version discovery first. For bare ws/wss URLs, fall back to
    // using the URL itself as a direct WS endpoint when discovery is
    // unavailable — some providers (e.g. Browserless/Browserbase) expose
    // a direct WebSocket root without a /json/version route.
    const discoveryUrl = isWebSocketUrl(opts.cdpUrl)
      ? normalizeCdpHttpBaseForJsonEndpoints(opts.cdpUrl)
      : opts.cdpUrl;
    let version: { webSocketDebuggerUrl?: string } | null = null;
    try {
      version = await fetchJson<{ webSocketDebuggerUrl?: string }>(
        appendCdpPath(discoveryUrl, "/json/version"),
        1500,
        undefined,
        opts.ssrfPolicy,
      );
    } catch (err) {
      // Discovery failed for an HTTP/HTTPS URL — propagate immediately.
      if (!isWebSocketUrl(opts.cdpUrl)) {
        throw err;
      }
      // For bare ws/wss URLs, fall through: /json/version is unavailable
      // so we attempt to use opts.cdpUrl as a direct WS endpoint below.
    }
    const wsUrlRaw = version?.webSocketDebuggerUrl?.trim() ?? "";
    if (wsUrlRaw) {
      wsUrl = normalizeCdpWsUrl(wsUrlRaw, discoveryUrl);
    } else if (isWebSocketUrl(opts.cdpUrl)) {
      // /json/version unavailable or returned no WebSocket URL. Treat the
      // original URL as a direct WebSocket endpoint.
      wsUrl = opts.cdpUrl;
    } else {
      throw new Error("CDP /json/version missing webSocketDebuggerUrl");
    }
    await assertCdpEndpointAllowed(wsUrl, opts.ssrfPolicy);
  }

  return await withCdpSocket(wsUrl, async (send) => {
    const created = (await send("Target.createTarget", { url: opts.url })) as {
      targetId?: string;
    };
    const targetId = created?.targetId?.trim() ?? "";
    if (!targetId) {
      throw new Error("CDP Target.createTarget returned no targetId");
    }
    return { targetId };
  });
}

export type CdpRemoteObject = {
  type: string;
  subtype?: string;
  value?: unknown;
  description?: string;
  unserializableValue?: string;
  preview?: unknown;
};

export type CdpExceptionDetails = {
  text?: string;
  lineNumber?: number;
  columnNumber?: number;
  exception?: CdpRemoteObject;
  stackTrace?: unknown;
};

export async function evaluateJavaScript(opts: {
  wsUrl: string;
  expression: string;
  awaitPromise?: boolean;
  returnByValue?: boolean;
}): Promise<{
  result: CdpRemoteObject;
  exceptionDetails?: CdpExceptionDetails;
}> {
  return await withCdpSocket(opts.wsUrl, async (send) => {
    await send("Runtime.enable").catch(() => {});
    const evaluated = (await send("Runtime.evaluate", {
      expression: opts.expression,
      awaitPromise: Boolean(opts.awaitPromise),
      returnByValue: opts.returnByValue ?? true,
      userGesture: true,
      includeCommandLineAPI: true,
    })) as {
      result?: CdpRemoteObject;
      exceptionDetails?: CdpExceptionDetails;
    };

    const result = evaluated?.result;
    if (!result) {
      throw new Error("CDP Runtime.evaluate returned no result");
    }
    return { result, exceptionDetails: evaluated.exceptionDetails };
  });
}

export type AriaSnapshotNode = {
  ref: string;
  role: string;
  name: string;
  value?: string;
  description?: string;
  backendDOMNodeId?: number;
  depth: number;
};

export const AX_REF_PREFIX = "ax";
export const AX_REF_PATTERN = new RegExp(`^${AX_REF_PREFIX}\\d+$`);

export type RawAXNode = {
  nodeId?: string;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: string };
  description?: { value?: string };
  childIds?: string[];
  backendDOMNodeId?: number;
};

function axValue(v: unknown): string {
  if (!v || typeof v !== "object") {
    return "";
  }
  const value = (v as { value?: unknown }).value;
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

export function formatAriaSnapshot(nodes: RawAXNode[], limit: number): AriaSnapshotNode[] {
  const byId = new Map<string, RawAXNode>();
  for (const n of nodes) {
    if (n.nodeId) {
      byId.set(n.nodeId, n);
    }
  }

  // Heuristic: pick a root-ish node (one that is not referenced as a child), else first.
  const referenced = new Set<string>();
  for (const n of nodes) {
    for (const c of n.childIds ?? []) {
      referenced.add(c);
    }
  }
  const root = nodes.find((n) => n.nodeId && !referenced.has(n.nodeId)) ?? nodes[0];
  if (!root?.nodeId) {
    return [];
  }

  const out: AriaSnapshotNode[] = [];
  const stack: Array<{ id: string; depth: number }> = [{ id: root.nodeId, depth: 0 }];
  while (stack.length && out.length < limit) {
    const popped = stack.pop();
    // `stack.pop()` only returns undefined on an empty stack, but the
    // while guard already asserts `stack.length > 0`. Dead defensive guard.
    /* c8 ignore next 3 */
    if (!popped) {
      break;
    }
    const { id, depth } = popped;
    const n = byId.get(id);
    // Every id pushed onto the stack came from `children.filter(c => byId.has(c))`,
    // so byId.get(id) is always defined here. Dead defensive guard.
    /* c8 ignore next 3 */
    if (!n) {
      continue;
    }
    const role = axValue(n.role);
    const name = axValue(n.name);
    const value = axValue(n.value);
    const description = axValue(n.description);
    const ref = `${AX_REF_PREFIX}${out.length + 1}`;
    out.push({
      ref,
      role: role || "unknown",
      name: name || "",
      ...(value ? { value } : {}),
      ...(description ? { description } : {}),
      ...(typeof n.backendDOMNodeId === "number" ? { backendDOMNodeId: n.backendDOMNodeId } : {}),
      depth,
    });

    const children = (n.childIds ?? []).filter((c) => byId.has(c));
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      // `children` is a string[] from an array filter over RawAXNode.childIds,
      // so `child` is always a defined string here. Dead defensive guard.
      /* c8 ignore next 3 */
      if (child) {
        stack.push({ id: child, depth: depth + 1 });
      }
    }
  }

  return out;
}

export async function snapshotAria(opts: {
  wsUrl: string;
  limit?: number;
}): Promise<{ nodes: AriaSnapshotNode[] }> {
  const limit = Math.max(1, Math.min(2000, Math.floor(opts.limit ?? 500)));
  return await withCdpSocket(opts.wsUrl, async (send) => {
    await send("Accessibility.enable").catch(() => {});
    const res = (await send("Accessibility.getFullAXTree")) as {
      nodes?: RawAXNode[];
    };
    const nodes = Array.isArray(res?.nodes) ? res.nodes : [];
    return { nodes: formatAriaSnapshot(nodes, limit) };
  });
}

export async function snapshotDom(opts: {
  wsUrl: string;
  limit?: number;
  maxTextChars?: number;
}): Promise<{
  nodes: DomSnapshotNode[];
}> {
  const limit = Math.max(1, Math.min(5000, Math.floor(opts.limit ?? 800)));
  const maxTextChars = Math.max(0, Math.min(5000, Math.floor(opts.maxTextChars ?? 220)));

  const expression = `(() => {
    const maxNodes = ${JSON.stringify(limit)};
    const maxText = ${JSON.stringify(maxTextChars)};
    const lower = (value) => String(value || "").toLocaleLowerCase();
    const nodes = [];
    const root = document.documentElement;
    if (!root) return { nodes };
    const stack = [{ el: root, depth: 0, parentRef: null }];
    while (stack.length && nodes.length < maxNodes) {
      const cur = stack.pop();
      const el = cur.el;
      if (!el || el.nodeType !== 1) continue;
      const ref = "n" + String(nodes.length + 1);
      const tag = lower(el.tagName);
      const id = el.id ? String(el.id) : undefined;
      const className = el.className ? String(el.className).slice(0, 300) : undefined;
      const role = el.getAttribute && el.getAttribute("role") ? String(el.getAttribute("role")) : undefined;
      const name = el.getAttribute && el.getAttribute("aria-label") ? String(el.getAttribute("aria-label")) : undefined;
      let text = "";
      try { text = String(el.innerText || "").trim(); } catch {}
      if (maxText && text.length > maxText) text = text.slice(0, maxText) + "…";
      const href = (el.href !== undefined && el.href !== null) ? String(el.href) : undefined;
      const type = (el.type !== undefined && el.type !== null) ? String(el.type) : undefined;
      const value = (el.value !== undefined && el.value !== null) ? String(el.value).slice(0, 500) : undefined;
      nodes.push({
        ref,
        parentRef: cur.parentRef,
        depth: cur.depth,
        tag,
        ...(id ? { id } : {}),
        ...(className ? { className } : {}),
        ...(role ? { role } : {}),
        ...(name ? { name } : {}),
        ...(text ? { text } : {}),
        ...(href ? { href } : {}),
        ...(type ? { type } : {}),
        ...(value ? { value } : {}),
      });
      const children = el.children ? Array.from(el.children) : [];
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push({ el: children[i], depth: cur.depth + 1, parentRef: ref });
      }
    }
    return { nodes };
  })()`;

  const evaluated = await evaluateJavaScript({
    wsUrl: opts.wsUrl,
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  const value = evaluated.result?.value;
  if (!value || typeof value !== "object") {
    return { nodes: [] };
  }
  const nodes = (value as { nodes?: unknown }).nodes;
  return { nodes: Array.isArray(nodes) ? (nodes as DomSnapshotNode[]) : [] };
}

export type DomSnapshotNode = {
  ref: string;
  parentRef: string | null;
  depth: number;
  tag: string;
  id?: string;
  className?: string;
  role?: string;
  name?: string;
  text?: string;
  href?: string;
  type?: string;
  value?: string;
};

export async function getDomText(opts: {
  wsUrl: string;
  format: "html" | "text";
  maxChars?: number;
  selector?: string;
}): Promise<{ text: string }> {
  const maxChars = Math.max(0, Math.min(5_000_000, Math.floor(opts.maxChars ?? 200_000)));
  const selectorExpr = opts.selector ? JSON.stringify(opts.selector) : "null";
  const expression = `(() => {
    const fmt = ${JSON.stringify(opts.format)};
    const max = ${JSON.stringify(maxChars)};
    const sel = ${selectorExpr};
    const pick = sel ? document.querySelector(sel) : null;
    let out = "";
    if (fmt === "text") {
      const el = pick || document.body || document.documentElement;
      try { out = String(el && el.innerText ? el.innerText : ""); } catch { out = ""; }
    } else {
      const el = pick || document.documentElement;
      try { out = String(el && el.outerHTML ? el.outerHTML : ""); } catch { out = ""; }
    }
    if (max && out.length > max) out = out.slice(0, max) + "\\n<!-- …truncated… -->";
    return out;
  })()`;

  const evaluated = await evaluateJavaScript({
    wsUrl: opts.wsUrl,
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  const textValue = (evaluated.result?.value ?? "") as unknown;
  const text =
    typeof textValue === "string"
      ? textValue
      : typeof textValue === "number" || typeof textValue === "boolean"
        ? String(textValue)
        : "";
  return { text };
}

export async function querySelector(opts: {
  wsUrl: string;
  selector: string;
  limit?: number;
  maxTextChars?: number;
  maxHtmlChars?: number;
}): Promise<{
  matches: QueryMatch[];
}> {
  const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 20)));
  const maxText = Math.max(0, Math.min(5000, Math.floor(opts.maxTextChars ?? 500)));
  const maxHtml = Math.max(0, Math.min(20000, Math.floor(opts.maxHtmlChars ?? 1500)));

  const expression = `(() => {
    const sel = ${JSON.stringify(opts.selector)};
    const lim = ${JSON.stringify(limit)};
    const maxText = ${JSON.stringify(maxText)};
    const maxHtml = ${JSON.stringify(maxHtml)};
    const lower = (value) => String(value || "").toLocaleLowerCase();
    const els = Array.from(document.querySelectorAll(sel)).slice(0, lim);
    return els.map((el, i) => {
      const tag = lower(el.tagName);
      const id = el.id ? String(el.id) : undefined;
      const className = el.className ? String(el.className).slice(0, 300) : undefined;
      let text = "";
      try { text = String(el.innerText || "").trim(); } catch {}
      if (maxText && text.length > maxText) text = text.slice(0, maxText) + "…";
      const value = (el.value !== undefined && el.value !== null) ? String(el.value).slice(0, 500) : undefined;
      const href = (el.href !== undefined && el.href !== null) ? String(el.href) : undefined;
      let outerHTML = "";
      try { outerHTML = String(el.outerHTML || ""); } catch {}
      if (maxHtml && outerHTML.length > maxHtml) outerHTML = outerHTML.slice(0, maxHtml) + "…";
      return {
        index: i + 1,
        tag,
        ...(id ? { id } : {}),
        ...(className ? { className } : {}),
        ...(text ? { text } : {}),
        ...(value ? { value } : {}),
        ...(href ? { href } : {}),
        ...(outerHTML ? { outerHTML } : {}),
      };
    });
  })()`;

  const evaluated = await evaluateJavaScript({
    wsUrl: opts.wsUrl,
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  const matches = evaluated.result?.value;
  return { matches: Array.isArray(matches) ? (matches as QueryMatch[]) : [] };
}

export type QueryMatch = {
  index: number;
  tag: string;
  id?: string;
  className?: string;
  text?: string;
  value?: string;
  href?: string;
  outerHTML?: string;
};
