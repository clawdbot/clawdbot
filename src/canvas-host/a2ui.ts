import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { LEGACY_CANVAS_HANDLER_NAME } from "../compat/legacy-names.js";
import { detectMime } from "../media/mime.js";

export const A2UI_PATH = "/__moltbot__/a2ui";
export const CANVAS_HOST_PATH = "/__moltbot__/canvas";
export const CANVAS_WS_PATH = "/__moltbot/ws";

let cachedA2uiRootReal: string | null | undefined;
let resolvingA2uiRoot: Promise<string | null> | null = null;

async function resolveA2uiRoot(): Promise<string | null> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Running from source (bun) or dist (tsc + copied assets).
    path.resolve(here, "a2ui"),
    // Running from dist without copied assets (fallback to source).
    path.resolve(here, "../../src/canvas-host/a2ui"),
    // Running from repo root.
    path.resolve(process.cwd(), "src/canvas-host/a2ui"),
    path.resolve(process.cwd(), "dist/canvas-host/a2ui"),
  ];
  if (process.execPath) {
    candidates.unshift(path.resolve(path.dirname(process.execPath), "a2ui"));
  }

  for (const dir of candidates) {
    try {
      const indexPath = path.join(dir, "index.html");
      const bundlePath = path.join(dir, "a2ui.bundle.js");
      await fs.stat(indexPath);
      await fs.stat(bundlePath);
      return dir;
    } catch {
      // try next
    }
  }
  return null;
}

async function resolveA2uiRootReal(): Promise<string | null> {
  if (cachedA2uiRootReal !== undefined) return cachedA2uiRootReal;
  if (!resolvingA2uiRoot) {
    resolvingA2uiRoot = (async () => {
      const root = await resolveA2uiRoot();
      cachedA2uiRootReal = root ? await fs.realpath(root) : null;
      return cachedA2uiRootReal;
    })();
  }
  return resolvingA2uiRoot;
}

function normalizeUrlPath(rawPath: string): string {
  const decoded = decodeURIComponent(rawPath || "/");
  const normalized = path.posix.normalize(decoded);
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

async function resolveA2uiFilePath(rootReal: string, urlPath: string) {
  const normalized = normalizeUrlPath(urlPath);
  const rel = normalized.replace(/^\/+/, "");
  if (rel.split("/").some((p) => p === "..")) return null;

  let candidate = path.join(rootReal, rel);
  if (normalized.endsWith("/")) {
    candidate = path.join(candidate, "index.html");
  }

  try {
    const st = await fs.stat(candidate);
    if (st.isDirectory()) {
      candidate = path.join(candidate, "index.html");
    }
  } catch {
    // ignore
  }

  const rootPrefix = rootReal.endsWith(path.sep) ? rootReal : `${rootReal}${path.sep}`;
  try {
    const lstat = await fs.lstat(candidate);
    if (lstat.isSymbolicLink()) return null;
    const real = await fs.realpath(candidate);
    if (!real.startsWith(rootPrefix)) return null;
    return real;
  } catch {
    return null;
  }
}

export function injectCanvasLiveReload(html: string): string {
  const legacyHandlerName = LEGACY_CANVAS_HANDLER_NAME;
  const snippet = `
<script>
(() => {
  // Cross-platform action bridge helper.
  // Works on:
  // - iOS: window.webkit.messageHandlers.(current|legacy)CanvasA2UIAction.postMessage(...)
  // - Android: window.(current|legacy)CanvasA2UIAction.postMessage(...)
  const handlerNames = ["moltbotCanvasA2UIAction", "${legacyHandlerName}"];
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
    const id =
      (userAction && typeof userAction.id === "string" && userAction.id.trim()) ||
      (globalThis.crypto?.randomUUID?.() ?? String(Date.now()));
    const action = { ...userAction, id };
    return postToNode({ userAction: action });
  }
  globalThis.Moltbot = globalThis.Moltbot ?? {};
  globalThis.Moltbot.postMessage = postToNode;
  globalThis.Moltbot.sendUserAction = sendUserAction;
  globalThis.moltbotPostMessage = postToNode;
  globalThis.moltbotSendUserAction = sendUserAction;
  globalThis.clawdbotPostMessage = postToNode;
  globalThis.clawdbotSendUserAction = sendUserAction;

  try {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(proto + "://" + location.host + ${JSON.stringify(CANVAS_WS_PATH)});
    ws.onmessage = (ev) => {
      if (String(ev.data || "") === "reload") location.reload();
    };
  } catch {}
})();
</script>
`.trim();

  const idx = html.toLowerCase().lastIndexOf("</body>");
  if (idx >= 0) {
    return `${html.slice(0, idx)}\n${snippet}\n${html.slice(idx)}`;
  }
  return `${html}\n${snippet}\n`;
}

export async function handleA2uiHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const urlRaw = req.url;
  if (!urlRaw) return false;

  const url = new URL(urlRaw, "http://localhost");
  if (url.pathname !== A2UI_PATH && !url.pathname.startsWith(`${A2UI_PATH}/`)) {
    return false;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Method Not Allowed");
    return true;
  }

  const a2uiRootReal = await resolveA2uiRootReal();
  if (!a2uiRootReal) {
    res.statusCode = 503;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("A2UI assets not found");
    return true;
  }

  const rel = url.pathname.slice(A2UI_PATH.length);
  const filePath = await resolveA2uiFilePath(a2uiRootReal, rel || "/");
  if (!filePath) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("not found");
    return true;
  }

  const lower = filePath.toLowerCase();
  const mime =
    lower.endsWith(".html") || lower.endsWith(".htm")
      ? "text/html"
      : ((await detectMime({ filePath })) ?? "application/octet-stream");
  res.setHeader("Cache-Control", "no-store");

  if (mime === "text/html") {
    const html = await fs.readFile(filePath, "utf8");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(injectCanvasLiveReload(html));
    return true;
  }

  res.setHeader("Content-Type", mime);
  res.end(await fs.readFile(filePath));
  return true;
}
