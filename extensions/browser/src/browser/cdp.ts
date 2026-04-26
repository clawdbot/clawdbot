import type { SsrFPolicy } from "../infra/net/ssrf.js";
import {
  appendCdpPath,
  assertCdpEndpointAllowed,
  type CdpSendFn,
  fetchJson,
  isDirectCdpWebSocketEndpoint,
  isLoopbackHost,
  isWebSocketUrl,
  normalizeCdpHttpBaseForJsonEndpoints,
  withCdpSocket,
} from "./cdp.helpers.js";
import { assertBrowserNavigationAllowed, withBrowserNavigationPolicy } from "./navigation-guard.js";
import { CONTENT_ROLES, INTERACTIVE_ROLES, STRUCTURAL_ROLES } from "./snapshot-roles.js";

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
  timeoutMs?: number;
}): Promise<Buffer> {
  return await captureScreenshot({
    wsUrl: opts.wsUrl,
    fullPage: opts.fullPage,
    format: "png",
    timeoutMs: opts.timeoutMs,
  });
}

export async function captureScreenshot(opts: {
  wsUrl: string;
  fullPage?: boolean;
  format?: "png" | "jpeg";
  quality?: number; // jpeg only (0..100)
  timeoutMs?: number;
}): Promise<Buffer> {
  return await withCdpSocket(
    opts.wsUrl,
    async (send) => {
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
        // Chrome 146+ managed/headful browsers reject fromSurface: false.
        // For ordinary viewport captures, keep CDP's captureBeyondViewport
        // default (false), matching Playwright's Chromium path.
        const result = (await send("Page.captureScreenshot", {
          format,
          ...(quality !== undefined ? { quality } : {}),
          ...(opts.fullPage ? { captureBeyondViewport: true } : {}),
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
    },
    { commandTimeoutMs: opts.timeoutMs },
  );
}

export type CdpActionTimeouts = {
  httpTimeoutMs?: number;
  handshakeTimeoutMs?: number;
};

export async function createTargetViaCdp(opts: {
  cdpUrl: string;
  url: string;
  ssrfPolicy?: SsrFPolicy;
  timeouts?: CdpActionTimeouts;
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
        opts.timeouts?.httpTimeoutMs,
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
  }

  const candidateWsUrls =
    isWebSocketUrl(opts.cdpUrl) && wsUrl !== opts.cdpUrl ? [wsUrl, opts.cdpUrl] : [wsUrl];
  let lastError: unknown;
  for (const candidateWsUrl of candidateWsUrls) {
    try {
      await assertCdpEndpointAllowed(candidateWsUrl, opts.ssrfPolicy);
      return await withCdpSocket(
        candidateWsUrl,
        async (send) => {
          const created = (await send("Target.createTarget", { url: opts.url })) as {
            targetId?: string;
          };
          const targetId = created?.targetId?.trim() ?? "";
          if (!targetId) {
            throw new Error("CDP Target.createTarget returned no targetId");
          }
          await prepareCdpTargetSession(send, targetId);
          return { targetId };
        },
        {
          commandTimeoutMs: opts.timeouts?.httpTimeoutMs ?? 5000,
          handshakeTimeoutMs: opts.timeouts?.handshakeTimeoutMs,
        },
      );
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error("CDP Target.createTarget failed");
}

async function prepareCdpTargetSession(send: CdpSendFn, targetId: string): Promise<void> {
  const attached = (await send("Target.attachToTarget", {
    targetId,
    flatten: true,
  }).catch(() => null)) as { sessionId?: unknown } | null;
  const sessionId = typeof attached?.sessionId === "string" ? attached.sessionId : undefined;
  if (!sessionId) {
    return;
  }
  try {
    await prepareCdpPageSession(send, sessionId);
  } finally {
    await send("Target.detachFromTarget", { sessionId }).catch(() => {});
  }
}

async function prepareCdpPageSession(send: CdpSendFn, sessionId?: string): Promise<void> {
  await Promise.all([
    send("Page.enable", undefined, sessionId).catch(() => {}),
    send("Runtime.enable", undefined, sessionId).catch(() => {}),
    send("Network.enable", undefined, sessionId).catch(() => {}),
    send("DOM.enable", undefined, sessionId).catch(() => {}),
    send("Accessibility.enable", undefined, sessionId).catch(() => {}),
  ]);
  await send("Runtime.runIfWaitingForDebugger", undefined, sessionId).catch(() => {});
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
  timeoutMs?: number;
}): Promise<{ nodes: AriaSnapshotNode[] }> {
  const limit = Math.max(1, Math.min(2000, Math.floor(opts.limit ?? 500)));
  return await withCdpSocket(
    opts.wsUrl,
    async (send) => {
      await prepareCdpPageSession(send);
      const res = (await send("Accessibility.getFullAXTree")) as {
        nodes?: RawAXNode[];
      };
      const nodes = Array.isArray(res?.nodes) ? res.nodes : [];
      return { nodes: formatAriaSnapshot(nodes, limit) };
    },
    { commandTimeoutMs: opts.timeoutMs ?? 5000 },
  );
}

export type CdpRoleRef = {
  role: string;
  name?: string;
  nth?: number;
  backendDOMNodeId?: number;
  frameId?: string;
};

export type CdpRoleSnapshotOptions = {
  interactive?: boolean;
  compact?: boolean;
  maxDepth?: number;
};

type CursorInteractiveInfo = {
  text: string;
  tagName: string;
  hasOnClick?: boolean;
  hasCursorPointer?: boolean;
  hasTabIndex?: boolean;
  isEditable?: boolean;
  hiddenInputType?: string;
};

type RoleTreeNode = {
  raw: RawAXNode;
  role: string;
  name: string;
  value: string;
  backendDOMNodeId?: number;
  children: number[];
  parent?: number;
  depth: number;
  ref?: string;
  nth?: number;
  url?: string;
  cursorInfo?: CursorInteractiveInfo;
  frameId?: string;
};

function buildRoleTree(nodes: RawAXNode[]): { tree: RoleTreeNode[]; roots: number[] } {
  const byId = new Map<string, number>();
  const tree: RoleTreeNode[] = [];
  for (const raw of nodes) {
    const nodeId = raw.nodeId ?? "";
    if (!nodeId) {
      continue;
    }
    byId.set(nodeId, tree.length);
    tree.push({
      raw,
      role: axValue(raw.role) || "unknown",
      name: axValue(raw.name),
      value: axValue(raw.value),
      backendDOMNodeId:
        typeof raw.backendDOMNodeId === "number" && raw.backendDOMNodeId > 0
          ? Math.floor(raw.backendDOMNodeId)
          : undefined,
      children: [],
      depth: 0,
    });
  }

  const childIndexes = new Set<number>();
  for (let index = 0; index < tree.length; index += 1) {
    for (const childId of tree[index]?.raw.childIds ?? []) {
      const childIndex = byId.get(childId);
      if (childIndex === undefined) {
        continue;
      }
      tree[index]?.children.push(childIndex);
      tree[childIndex].parent = index;
      childIndexes.add(childIndex);
    }
  }

  const roots = tree.map((_node, index) => index).filter((index) => !childIndexes.has(index));
  const stack = roots.map((index) => ({ index, depth: 0 }));
  while (stack.length) {
    const current = stack.pop();
    if (!current) {
      break;
    }
    tree[current.index].depth = current.depth;
    for (const child of (tree[current.index]?.children ?? []).toReversed()) {
      stack.push({ index: child, depth: current.depth + 1 });
    }
  }
  return { tree, roots: roots.length ? roots : tree.length ? [0] : [] };
}

function shouldIncludeRoleNode(node: RoleTreeNode, options: CdpRoleSnapshotOptions): boolean {
  const role = node.role.toLowerCase();
  if (options.maxDepth !== undefined && node.depth > options.maxDepth) {
    return false;
  }
  if (options.interactive) {
    return INTERACTIVE_ROLES.has(role) || role === "iframe" || Boolean(node.cursorInfo);
  }
  if (options.compact && STRUCTURAL_ROLES.has(role) && !node.name && !node.ref) {
    return false;
  }
  return true;
}

function cursorSuffix(info?: CursorInteractiveInfo): string {
  if (!info) {
    return "";
  }
  const parts = [
    info.hasCursorPointer ? "cursor:pointer" : undefined,
    info.hasOnClick ? "onclick" : undefined,
    info.hasTabIndex ? "tabindex" : undefined,
    info.isEditable ? "contenteditable" : undefined,
    info.hiddenInputType ? `hidden-${info.hiddenInputType}` : undefined,
  ].filter(Boolean);
  return parts.length ? ` [${parts.join(", ")}]` : "";
}

function renderRoleTree(
  tree: RoleTreeNode[],
  index: number,
  output: string[],
  options: CdpRoleSnapshotOptions,
  indentOffset = 0,
): void {
  const node = tree[index];
  if (!node) {
    return;
  }
  if (shouldIncludeRoleNode(node, options)) {
    const indent = "  ".repeat(Math.max(0, node.depth + indentOffset));
    const name = node.name ? ` "${node.name.replaceAll('"', '\\"')}"` : "";
    const ref = node.ref ? ` [ref=${node.ref}]` : "";
    const nth = node.nth !== undefined && node.nth > 0 ? ` [nth=${node.nth}]` : "";
    const value = node.value ? ` value="${node.value.replaceAll('"', '\\"')}"` : "";
    const url = node.url ? ` [url=${node.url}]` : "";
    output.push(
      `${indent}- ${node.role}${name}${ref}${nth}${value}${url}${cursorSuffix(node.cursorInfo)}`,
    );
  }
  for (const child of node.children) {
    renderRoleTree(tree, child, output, options, indentOffset);
  }
}

async function findCursorInteractiveElements(
  send: CdpSendFn,
  sessionId?: string,
): Promise<Map<number, CursorInteractiveInfo>> {
  const attr = "data-openclaw-cdp-ci";
  const evaluated = (await send(
    "Runtime.evaluate",
    {
      expression: `(() => {
        const out = [];
        const roles = new Set(["button","link","textbox","checkbox","radio","combobox","listbox","menuitem","menuitemcheckbox","menuitemradio","option","searchbox","slider","spinbutton","switch","tab","treeitem"]);
        const tags = new Set(["a","button","input","select","textarea","details","summary"]);
        document.querySelectorAll("[${attr}]").forEach((el) => el.removeAttribute("${attr}"));
        for (const el of Array.from(document.body ? document.body.querySelectorAll("*") : [])) {
          if (!(el instanceof HTMLElement) || el.closest("[hidden],[aria-hidden='true']")) continue;
          const tagName = el.tagName.toLowerCase();
          if (tags.has(tagName)) continue;
          const role = String(el.getAttribute("role") || "").toLowerCase();
          if (roles.has(role)) continue;
          const style = getComputedStyle(el);
          const hasCursorPointer = style.cursor === "pointer";
          const hasOnClick = el.hasAttribute("onclick") || el.onclick !== null;
          const tabIndex = el.getAttribute("tabindex");
          const hasTabIndex = tabIndex !== null && tabIndex !== "-1";
          const ce = el.getAttribute("contenteditable");
          const isEditable = ce === "" || ce === "true";
          if (!hasCursorPointer && !hasOnClick && !hasTabIndex && !isEditable) continue;
          if (hasCursorPointer && !hasOnClick && !hasTabIndex && !isEditable) {
            const parent = el.parentElement;
            if (parent && getComputedStyle(parent).cursor === "pointer") continue;
          }
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;
          let hiddenInputType = "";
          const hiddenInput = el.querySelector("input[type='radio'],input[type='checkbox']");
          if (hiddenInput instanceof HTMLInputElement) {
            const hiddenStyle = getComputedStyle(hiddenInput);
            if (hiddenInput.hidden || hiddenStyle.display === "none" || hiddenStyle.visibility === "hidden") {
              hiddenInputType = hiddenInput.type;
            }
          }
          el.setAttribute("${attr}", String(out.length));
          out.push({
            text: String(el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 100),
            tagName,
            hasCursorPointer,
            hasOnClick,
            hasTabIndex,
            isEditable,
            hiddenInputType,
          });
        }
        return out;
      })()`,
      returnByValue: true,
      awaitPromise: false,
    },
    sessionId,
  ).catch(() => null)) as { result?: { value?: unknown } } | null;
  const entries = Array.isArray(evaluated?.result?.value)
    ? (evaluated.result.value as CursorInteractiveInfo[])
    : [];
  if (!entries.length) {
    return new Map();
  }

  const doc = (await send("DOM.getDocument", { depth: 0 }, sessionId).catch(() => null)) as {
    root?: { nodeId?: number };
  } | null;
  const rootNodeId = doc?.root?.nodeId;
  if (typeof rootNodeId !== "number") {
    return new Map();
  }
  const queried = (await send(
    "DOM.querySelectorAll",
    { nodeId: rootNodeId, selector: `[${attr}]` },
    sessionId,
  ).catch(() => null)) as { nodeIds?: number[] } | null;
  const out = new Map<number, CursorInteractiveInfo>();
  await Promise.all(
    (queried?.nodeIds ?? []).map(async (nodeId) => {
      const described = (await send("DOM.describeNode", { nodeId }, sessionId).catch(
        () => null,
      )) as { node?: { backendNodeId?: number; attributes?: string[] } } | null;
      const attrs = described?.node?.attributes ?? [];
      const attrIndex = attrs.indexOf(attr);
      const rawIndex = attrIndex >= 0 ? attrs[attrIndex + 1] : undefined;
      const index = typeof rawIndex === "string" ? Number(rawIndex) : Number.NaN;
      const backendNodeId = described?.node?.backendNodeId;
      if (typeof backendNodeId === "number" && Number.isInteger(index) && entries[index]) {
        out.set(backendNodeId, entries[index]);
      }
    }),
  );
  await send(
    "Runtime.evaluate",
    {
      expression: `document.querySelectorAll("[${attr}]").forEach((el) => el.removeAttribute("${attr}"))`,
      returnByValue: true,
    },
    sessionId,
  ).catch(() => {});
  return out;
}

async function resolveLinkUrls(
  send: CdpSendFn,
  refs: Record<string, CdpRoleRef>,
  sessionId?: string,
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  await Promise.all(
    Object.values(refs).map(async (ref) => {
      if (ref.role !== "link" || !ref.backendDOMNodeId) {
        return;
      }
      const resolved = (await send(
        "DOM.resolveNode",
        { backendNodeId: ref.backendDOMNodeId },
        sessionId,
      ).catch(() => null)) as { object?: { objectId?: string } } | null;
      const objectId = resolved?.object?.objectId;
      if (!objectId) {
        return;
      }
      const hrefResult = (await send(
        "Runtime.callFunctionOn",
        {
          objectId,
          functionDeclaration: "function() { return this.href || ''; }",
          returnByValue: true,
        },
        sessionId,
      ).catch(() => null)) as { result?: { value?: unknown } } | null;
      const href = typeof hrefResult?.result?.value === "string" ? hrefResult.result.value : "";
      if (href) {
        out.set(ref.backendDOMNodeId, href);
      }
    }),
  );
  return out;
}

async function resolveIframeFrameIds(
  send: CdpSendFn,
  tree: RoleTreeNode[],
  sessionId?: string,
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  await Promise.all(
    tree.map(async (node) => {
      if (node.role.toLowerCase() !== "iframe" || !node.backendDOMNodeId) {
        return;
      }
      const described = (await send(
        "DOM.describeNode",
        { backendNodeId: node.backendDOMNodeId, depth: 1 },
        sessionId,
      ).catch(() => null)) as {
        node?: { frameId?: string; contentDocument?: { frameId?: string } };
      } | null;
      const frameId = described?.node?.contentDocument?.frameId ?? described?.node?.frameId ?? "";
      if (frameId) {
        out.set(node.backendDOMNodeId, frameId);
      }
    }),
  );
  return out;
}

async function buildCdpRoleSnapshot(params: {
  send: CdpSendFn;
  sessionId?: string;
  frameId?: string;
  options: CdpRoleSnapshotOptions;
  urls?: boolean;
  recurseIframes?: boolean;
  nextRef: { value: number };
}): Promise<{
  lines: string[];
  refs: Record<string, CdpRoleRef>;
  stats: { refs: number; interactive: number };
}> {
  const res = (await params.send(
    "Accessibility.getFullAXTree",
    params.frameId ? { frameId: params.frameId } : undefined,
    params.sessionId,
  )) as { nodes?: RawAXNode[] };
  const { tree, roots } = buildRoleTree(Array.isArray(res.nodes) ? res.nodes : []);
  const cursorElements = await findCursorInteractiveElements(params.send, params.sessionId);
  for (const node of tree) {
    if (node.backendDOMNodeId && cursorElements.has(node.backendDOMNodeId)) {
      const cursorInfo = cursorElements.get(node.backendDOMNodeId);
      node.cursorInfo = cursorInfo;
      if (!node.name && cursorInfo?.text) {
        node.name = cursorInfo.text;
      }
    }
  }

  const counts = new Map<string, number>();
  const refsByKey = new Map<string, string[]>();
  const refs: Record<string, CdpRoleRef> = {};
  for (const node of tree) {
    const role = node.role.toLowerCase();
    const shouldRef =
      INTERACTIVE_ROLES.has(role) ||
      (CONTENT_ROLES.has(role) && Boolean(node.name)) ||
      role === "iframe" ||
      Boolean(node.cursorInfo);
    if (!shouldRef) {
      continue;
    }
    const key = `${role}:${node.name}`;
    const nth = counts.get(key) ?? 0;
    counts.set(key, nth + 1);
    const ref = `e${params.nextRef.value}`;
    params.nextRef.value += 1;
    node.ref = ref;
    node.nth = nth;
    refsByKey.set(key, [...(refsByKey.get(key) ?? []), ref]);
    refs[ref] = {
      role,
      ...(node.name ? { name: node.name } : {}),
      ...(nth > 0 ? { nth } : {}),
      ...(node.backendDOMNodeId ? { backendDOMNodeId: node.backendDOMNodeId } : {}),
      ...(params.frameId ? { frameId: params.frameId } : {}),
    };
  }
  for (const refList of refsByKey.values()) {
    if (refList.length > 1) {
      continue;
    }
    const ref = refList[0];
    if (ref) {
      delete refs[ref]?.nth;
      const node = tree.find((entry) => entry.ref === ref);
      if (node) {
        delete node.nth;
      }
    }
  }

  const iframeFrameIds = await resolveIframeFrameIds(params.send, tree, params.sessionId);
  for (const node of tree) {
    if (node.backendDOMNodeId && iframeFrameIds.has(node.backendDOMNodeId)) {
      node.frameId = iframeFrameIds.get(node.backendDOMNodeId);
      if (node.ref && refs[node.ref]) {
        refs[node.ref].frameId = node.frameId;
      }
    }
  }

  if (params.urls) {
    const urls = await resolveLinkUrls(params.send, refs, params.sessionId);
    for (const node of tree) {
      if (node.backendDOMNodeId && urls.has(node.backendDOMNodeId)) {
        node.url = urls.get(node.backendDOMNodeId);
      }
    }
  }

  const lines: string[] = [];
  for (const root of roots) {
    renderRoleTree(tree, root, lines, params.options);
  }

  if (params.recurseIframes) {
    const iframeNodes = tree.filter((node) => node.ref && node.frameId);
    for (const iframe of iframeNodes) {
      const marker = `[ref=${iframe.ref}]`;
      const lineIndex = lines.findIndex((line) => line.includes(marker));
      if (lineIndex < 0 || !iframe.frameId) {
        continue;
      }
      const child = await buildCdpRoleSnapshot({
        ...params,
        frameId: iframe.frameId,
        recurseIframes: false,
      }).catch(() => null);
      if (!child?.lines.length) {
        continue;
      }
      Object.assign(refs, child.refs);
      lines.splice(lineIndex + 1, 0, ...child.lines.map((line) => `  ${line}`));
    }
  }

  const refValues = Object.values(refs);
  return {
    lines,
    refs,
    stats: {
      refs: refValues.length,
      interactive: refValues.filter((ref) => INTERACTIVE_ROLES.has(ref.role)).length,
    },
  };
}

export async function snapshotRoleViaCdp(opts: {
  wsUrl: string;
  options?: CdpRoleSnapshotOptions;
  urls?: boolean;
  timeoutMs?: number;
}): Promise<{
  snapshot: string;
  refs: Record<string, CdpRoleRef>;
  stats: { lines: number; chars: number; refs: number; interactive: number };
}> {
  return await withCdpSocket(
    opts.wsUrl,
    async (send) => {
      await prepareCdpPageSession(send);
      const built = await buildCdpRoleSnapshot({
        send,
        options: opts.options ?? {},
        urls: opts.urls,
        recurseIframes: true,
        nextRef: { value: 1 },
      });
      const snapshot =
        built.lines.join("\n").trim() ||
        (opts.options?.interactive ? "(no interactive elements)" : "(empty page)");
      return {
        snapshot,
        refs: built.refs,
        stats: {
          lines: snapshot.split("\n").length,
          chars: snapshot.length,
          refs: built.stats.refs,
          interactive: built.stats.interactive,
        },
      };
    },
    { commandTimeoutMs: opts.timeoutMs ?? 5000 },
  );
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
