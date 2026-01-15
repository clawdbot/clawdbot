import { fetchJson, isLoopbackHost, withCdpSocket } from "./cdp.helpers.js";

export function normalizeCdpWsUrl(wsUrl: string, cdpUrl: string): string {
  const ws = new URL(wsUrl);
  const cdp = new URL(cdpUrl);
  if (isLoopbackHost(ws.hostname) && !isLoopbackHost(cdp.hostname)) {
    ws.hostname = cdp.hostname;
    const cdpPort = cdp.port || (cdp.protocol === "https:" ? "443" : "80");
    if (cdpPort) ws.port = cdpPort;
    ws.protocol = cdp.protocol === "https:" ? "wss:" : "ws:";
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

    let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;
    if (opts.fullPage) {
      const metrics = (await send("Page.getLayoutMetrics")) as {
        cssContentSize?: { width?: number; height?: number };
        contentSize?: { width?: number; height?: number };
      };
      const size = metrics?.cssContentSize ?? metrics?.contentSize;
      const width = Number(size?.width ?? 0);
      const height = Number(size?.height ?? 0);
      if (width > 0 && height > 0) {
        clip = { x: 0, y: 0, width, height, scale: 1 };
      }
    }

    const format = opts.format ?? "png";
    const quality =
      format === "jpeg" ? Math.max(0, Math.min(100, Math.round(opts.quality ?? 85))) : undefined;

    const result = (await send("Page.captureScreenshot", {
      format,
      ...(quality !== undefined ? { quality } : {}),
      fromSurface: true,
      captureBeyondViewport: true,
      ...(clip ? { clip } : {}),
    })) as { data?: string };

    const base64 = result?.data;
    if (!base64) throw new Error("Screenshot failed: missing data");
    return Buffer.from(base64, "base64");
  });
}

export async function createTargetViaCdp(opts: {
  cdpUrl: string;
  url: string;
}): Promise<{ targetId: string }> {
  const base = opts.cdpUrl.replace(/\/$/, "");
  const version = await fetchJson<{ webSocketDebuggerUrl?: string }>(`${base}/json/version`, 1500);
  const wsUrlRaw = String(version?.webSocketDebuggerUrl ?? "").trim();
  const wsUrl = wsUrlRaw ? normalizeCdpWsUrl(wsUrlRaw, opts.cdpUrl) : "";
  if (!wsUrl) throw new Error("CDP /json/version missing webSocketDebuggerUrl");

  return await withCdpSocket(wsUrl, async (send) => {
    const created = (await send("Target.createTarget", { url: opts.url })) as {
      targetId?: string;
    };
    const targetId = String(created?.targetId ?? "").trim();
    if (!targetId) throw new Error("CDP Target.createTarget returned no targetId");
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
    if (!result) throw new Error("CDP Runtime.evaluate returned no result");
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
  if (!v || typeof v !== "object") return "";
  const value = (v as { value?: unknown }).value;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

export function formatAriaSnapshot(nodes: RawAXNode[], limit: number): AriaSnapshotNode[] {
  const byId = new Map<string, RawAXNode>();
  for (const n of nodes) {
    if (n.nodeId) byId.set(n.nodeId, n);
  }

  // Heuristic: pick a root-ish node (one that is not referenced as a child), else first.
  const referenced = new Set<string>();
  for (const n of nodes) {
    for (const c of n.childIds ?? []) referenced.add(c);
  }
  const root = nodes.find((n) => n.nodeId && !referenced.has(n.nodeId)) ?? nodes[0];
  if (!root?.nodeId) return [];

  const out: AriaSnapshotNode[] = [];
  const stack: Array<{ id: string; depth: number }> = [{ id: root.nodeId, depth: 0 }];
  while (stack.length && out.length < limit) {
    const popped = stack.pop();
    if (!popped) break;
    const { id, depth } = popped;
    const n = byId.get(id);
    if (!n) continue;
    const role = axValue(n.role);
    const name = axValue(n.name);
    const value = axValue(n.value);
    const description = axValue(n.description);
    const ref = `ax${out.length + 1}`;
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
      if (child) stack.push({ id: child, depth: depth + 1 });
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
    const nodes = [];
    const root = document.documentElement;
    if (!root) return { nodes };
    const stack = [{ el: root, depth: 0, parentRef: null }];
    while (stack.length && nodes.length < maxNodes) {
      const cur = stack.pop();
      const el = cur.el;
      if (!el || el.nodeType !== 1) continue;
      const ref = "n" + String(nodes.length + 1);
      const tag = (el.tagName || "").toLowerCase();
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
  const value = evaluated.result?.value as unknown;
  if (!value || typeof value !== "object") return { nodes: [] };
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
    const els = Array.from(document.querySelectorAll(sel)).slice(0, lim);
    return els.map((el, i) => {
      const tag = (el.tagName || "").toLowerCase();
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
