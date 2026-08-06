/**
 * Shared A2UI/Canvas host paths and live-reload injection helpers.
 */
/** Hosted path prefix for bundled A2UI assets. */
export const A2UI_PATH = "/__openclaw__/a2ui";

/** Hosted path prefix for Canvas document/static assets. */
export const CANVAS_HOST_PATH = "/__openclaw__/canvas";

/** Hosted WebSocket path for Canvas live reload. */
export const CANVAS_WS_PATH = "/__openclaw__/ws";

/** Returns whether a URL path targets the hosted A2UI asset surface. */
export function isA2uiPath(pathname: string): boolean {
  return pathname === A2UI_PATH || pathname.startsWith(`${A2UI_PATH}/`);
}

function findTagEnd(html: string, start: number): number | undefined {
  let quote: '"' | "'" | undefined;
  for (let index = start; index < html.length; index += 1) {
    const char = html[index];
    if (quote) {
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return index + 1;
    }
  }
  return undefined;
}

function findRuntimeInjectionIndex(html: string): number {
  let cursor = 0;
  let fallback = 0;
  while (cursor < html.length) {
    const tagStart = html.indexOf("<", cursor);
    if (tagStart < 0) {
      return fallback;
    }
    if (html.startsWith("<!--", tagStart)) {
      const commentEnd = html.indexOf("-->", tagStart + 4);
      if (commentEnd < 0) {
        return tagStart;
      }
      cursor = commentEnd + 3;
      continue;
    }
    if (html.startsWith("<![CDATA[", tagStart)) {
      const cdataEnd = html.indexOf("]]>", tagStart + 9);
      if (cdataEnd < 0) {
        return tagStart;
      }
      cursor = cdataEnd + 3;
      continue;
    }

    const tagEnd = findTagEnd(html, tagStart + 1);
    if (!tagEnd) {
      return tagStart;
    }
    const content = html.slice(tagStart + 1, tagEnd - 1).trimStart();
    if (/^!doctype(?:\s|$)/iu.test(content)) {
      fallback = tagEnd;
      cursor = tagEnd;
      continue;
    }
    if (content.startsWith("!") || content.startsWith("?")) {
      cursor = tagEnd;
      continue;
    }
    if (content.startsWith("/")) {
      return fallback || tagStart;
    }
    const tagName = /^([a-z][^\s/>]*)/iu.exec(content)?.[1]?.toLowerCase();
    if (tagName === "html") {
      fallback = tagEnd;
      cursor = tagEnd;
      continue;
    }
    if (tagName === "head") {
      return tagEnd;
    }
    // Fragment documents and malformed prologues still need the runtime before
    // their first authored element or script.
    return fallback || tagStart;
  }
  return fallback;
}

/** Injects Canvas bridge helpers and optional live-reload code into HTML. */
export function injectCanvasRuntime(html: string, options: { liveReload?: boolean } = {}): string {
  const liveReloadSnippet =
    options.liveReload === false
      ? ""
      : `
  let liveReloadErrorReported = false;
  let pageUnloading = false;
  globalThis.addEventListener?.("pagehide", () => { pageUnloading = true; });
  globalThis.addEventListener?.("pageshow", () => { pageUnloading = false; });
  function reportCanvasLiveReloadError() {
    if (liveReloadErrorReported) return;
    liveReloadErrorReported = true;
    try {
      // WebSocket error objects may expose the capability-bearing URL.
      console.error("OpenClaw canvas live reload unavailable");
    } catch {}
  }

  try {
    const capMatch = String(location.pathname || "").match(/\\/__openclaw__\\/cap\\/([^/]+)(?:\\/|$)/);
    let pathCapability = "";
    try {
      pathCapability = capMatch?.[1] ? decodeURIComponent(capMatch[1]) : "";
    } catch {}
    const cap = pathCapability || new URLSearchParams(location.search).get("oc_cap");
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const capQuery = cap ? "?oc_cap=" + encodeURIComponent(cap) : "";
    const ws = new WebSocket(proto + "://" + location.host + ${JSON.stringify(CANVAS_WS_PATH)} + capQuery);
    ws.onmessage = (ev) => {
      if (String(ev.data || "") === "reload") location.reload();
    };
    ws.onerror = () => {
      reportCanvasLiveReloadError();
    };
    ws.onclose = (ev) => {
      if (ev.code !== 1000 && !(ev.code === 1001 && pageUnloading)) {
        reportCanvasLiveReloadError();
      }
    };
  } catch {
    reportCanvasLiveReloadError();
  }`;
  const snippet = `
<script>
(() => {
  // Cross-platform action bridge helper.
  // Works on:
  // - iOS: window.webkit.messageHandlers.openclawCanvasA2UIAction.postMessage(...)
  // - Android: window.openclawCanvasA2UIAction.postMessage(...)
  const handlerNames = ["openclawCanvasA2UIAction"];
  function createActionId() {
    const crypto = globalThis.crypto;
    if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
    if (typeof crypto?.getRandomValues === "function") {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    }
  }
  function postToNode(payload) {
    try {
      const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
      for (const name of handlerNames) {
        const iosHandler = globalThis.webkit?.messageHandlers?.[name];
        if (iosHandler && typeof iosHandler.postMessage === "function") {
          iosHandler.postMessage(raw);
          return true;
        }
        const androidHandler = globalThis[name];
        if (androidHandler && typeof androidHandler.postMessage === "function") {
          // Important: call as a method on the interface object (binding matters on Android WebView).
          androidHandler.postMessage(raw);
          return true;
        }
      }
    } catch {}
    return false;
  }
  function sendUserAction(userAction) {
    const baseAction = userAction && typeof userAction === "object" ? userAction : {};
    const id =
      (typeof baseAction.id === "string" && baseAction.id.trim()) || createActionId();
    const action = id ? { ...baseAction, id } : { ...baseAction };
    return postToNode({ userAction: action });
  }
  globalThis.OpenClaw = globalThis.OpenClaw ?? {};
  globalThis.OpenClaw.postMessage = postToNode;
  globalThis.OpenClaw.sendUserAction = sendUserAction;
  globalThis.openclawPostMessage = postToNode;
  globalThis.openclawSendUserAction = sendUserAction;
${liveReloadSnippet}
})();
</script>
`.trim();

  const index = findRuntimeInjectionIndex(html);
  return `${html.slice(0, index)}\n${snippet}\n${html.slice(index)}`;
}
