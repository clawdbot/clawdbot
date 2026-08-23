/**
 * Canvas host server and static-file/live-reload handler implementation.
 */
import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import {
  clearTimeout as clearNativeTimeout,
  setTimeout as scheduleNativeTimeout,
} from "node:timers";
import chokidar from "chokidar";
import { detectMime } from "openclaw/plugin-sdk/media-mime";
import { isTruthyEnvValue, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { lowercasePreservingWhitespace } from "openclaw/plugin-sdk/string-coerce-runtime";
import { ensureDir, resolveUserPath } from "openclaw/plugin-sdk/text-utility-runtime";
import { WebSocketServer } from "ws";
import { CANVAS_HOST_PATH, CANVAS_WS_PATH, injectCanvasRuntime } from "./a2ui-shared.js";
import { normalizeUrlPath, resolveFileWithinRoot } from "./file-resolver.js";

const CANVAS_LIVE_RELOAD_MAX_INBOUND_MESSAGE_BYTES = 64 * 1024;

/** Options for creating only the Canvas host request handler. */
type CanvasHostHandlerOpts = {
  runtime: RuntimeEnv;
  rootDir?: string;
  basePath?: string;
  allowInTests?: boolean;
  liveReload?: boolean;
  watchFactory?: typeof chokidar.watch;
  webSocketServerClass?: typeof WebSocketServer;
};

/** Canvas host handler for HTTP requests, WebSocket upgrades, and teardown. */
export type CanvasHostHandler = {
  rootDir: string;
  basePath: string;
  handleHttpRequest: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
  close: () => Promise<void>;
};

function defaultIndexHTML() {
  return `<!doctype html>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>OpenClaw Canvas</title>
<style>
  html, body { height: 100%; margin: 0; background: #000; color: #fff; font: 16px/1.4 -apple-system, BlinkMacSystemFont, system-ui, Segoe UI, Roboto, Helvetica, Arial, sans-serif; }
  .wrap { min-height: 100%; display: grid; place-items: center; padding: 24px; }
  .card { width: min(720px, 100%); background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.10); border-radius: 16px; padding: 18px 18px 14px; }
  .title { display: flex; align-items: baseline; gap: 10px; }
  h1 { margin: 0; font-size: 22px; letter-spacing: 0.2px; }
  .sub { opacity: 0.75; font-size: 13px; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 14px; }
  button { appearance: none; border: 1px solid rgba(255,255,255,0.14); background: rgba(255,255,255,0.10); color: #fff; padding: 10px 12px; border-radius: 12px; font-weight: 600; cursor: pointer; }
  button:active { transform: translateY(1px); }
  .ok { color: #24e08a; }
  .bad { color: #ff5c5c; }
  .log { margin-top: 14px; opacity: 0.85; font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; white-space: pre-wrap; background: rgba(0,0,0,0.35); border: 1px solid rgba(255,255,255,0.08); padding: 10px; border-radius: 12px; }
</style>
<div class="wrap">
  <div class="card">
    <div class="title">
      <h1>OpenClaw Canvas</h1>
      <div class="sub">Interactive test page</div>
    </div>

    <div class="row">
      <button id="btn-hello">Hello</button>
      <button id="btn-time">Time</button>
      <button id="btn-photo">Photo</button>
      <button id="btn-dalek">Dalek</button>
    </div>

    <div id="status" class="sub" style="margin-top: 10px;"></div>
    <div id="log" class="log">Ready.</div>
  </div>
</div>
<script>
(() => {
  const logEl = document.getElementById("log");
  const statusEl = document.getElementById("status");
  const log = (msg) => { logEl.textContent = String(msg); };

  const hasIOS = () =>
    !!(
      window.webkit &&
      window.webkit.messageHandlers &&
      window.webkit.messageHandlers.openclawCanvasA2UIAction
    );
  const hasAndroid = () =>
    !!(
      (window.openclawCanvasA2UIAction &&
        typeof window.openclawCanvasA2UIAction.postMessage === "function")
    );
  const hasHelper = () => typeof window.openclawSendUserAction === "function";
  const helperReady = hasHelper();
  statusEl.textContent = "";
  statusEl.appendChild(document.createTextNode("Bridge: "));
  const bridgeStatus = document.createElement("span");
  bridgeStatus.className = helperReady ? "ok" : "bad";
  bridgeStatus.textContent = helperReady ? "ready" : "missing";
  statusEl.appendChild(bridgeStatus);
  statusEl.appendChild(
    document.createTextNode(
      " · iOS=" + (hasIOS() ? "yes" : "no") + " · Android=" + (hasAndroid() ? "yes" : "no"),
    ),
  );

  const onStatus = (ev) => {
    const d = ev && ev.detail || {};
    log("Action status: id=" + (d.id || "?") + " ok=" + String(!!d.ok) + (d.error ? (" error=" + d.error) : ""));
  };
  window.addEventListener("openclaw:a2ui-action-status", onStatus);

  function send(name, sourceComponentId) {
    if (!hasHelper()) {
      log("No action bridge found. Ensure you're viewing this on an iOS/Android OpenClaw node canvas.");
      return;
    }
    const sendUserAction =
      typeof window.openclawSendUserAction === "function"
        ? window.openclawSendUserAction
        : undefined;
    const ok = sendUserAction({
      name,
      surfaceId: "main",
      sourceComponentId,
      context: { t: Date.now() },
    });
    log(ok ? ("Sent action: " + name) : ("Failed to send action: " + name));
  }

  document.getElementById("btn-hello").onclick = () => send("hello", "demo.hello");
  document.getElementById("btn-time").onclick = () => send("time", "demo.time");
  document.getElementById("btn-photo").onclick = () => send("photo", "demo.photo");
  document.getElementById("btn-dalek").onclick = () => send("dalek", "demo.dalek");
})();
</script>
`;
}

function isDisabledByEnv() {
  if (isTruthyEnvValue(process.env.OPENCLAW_SKIP_CANVAS_HOST)) {
    return true;
  }
  if (process.env.NODE_ENV === "test") {
    return true;
  }
  if (process.env.VITEST) {
    return true;
  }
  return false;
}

function normalizeBasePath(rawPath: string | undefined) {
  const trimmed = (rawPath ?? CANVAS_HOST_PATH).trim();
  let normalized: string;
  try {
    normalized = normalizeUrlPath(trimmed || CANVAS_HOST_PATH);
  } catch {
    normalized = normalizeUrlPath(CANVAS_HOST_PATH);
  }
  if (normalized === "/") {
    return "/";
  }
  return normalized.replace(/\/+$/, "");
}

async function prepareCanvasRoot(rootDir: string) {
  await ensureDir(rootDir);
  const rootReal = await fs.realpath(rootDir);
  try {
    const indexPath = path.join(rootReal, "index.html");
    await fs.stat(indexPath);
  } catch {
    try {
      await fs.writeFile(path.join(rootReal, "index.html"), defaultIndexHTML(), "utf8");
    } catch {
      // ignore; we'll still serve the "missing file" message if needed.
    }
  }
  return rootReal;
}

function resolveDefaultCanvasRoot(): string {
  return path.join(resolveStateDir(), "canvas");
}

function shouldIgnoreCanvasWatchPath(rootReal: string, candidatePath: string): boolean {
  const relative = path.relative(rootReal, candidatePath);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    return false;
  }
  // Chokidar evaluates ignored matchers against absolute paths. Scope the
  // policy below the root so the default ~/.openclaw parent is still watched.
  return relative
    .split(/[\\/]/u)
    .some((segment) => segment.startsWith(".") || segment === "node_modules");
}

/** Creates a Canvas static-file handler with optional live reload. */
export async function createCanvasHostHandler(
  opts: CanvasHostHandlerOpts,
): Promise<CanvasHostHandler> {
  const basePath = normalizeBasePath(opts.basePath);
  if (isDisabledByEnv() && opts.allowInTests !== true) {
    return {
      rootDir: "",
      basePath,
      handleHttpRequest: async () => false,
      handleUpgrade: () => false,
      close: async () => {},
    };
  }

  const rootDir = resolveUserPath(opts.rootDir ?? resolveDefaultCanvasRoot());
  const rootReal = await prepareCanvasRoot(rootDir);

  const liveReload = opts.liveReload !== false;
  const testMode = opts.allowInTests === true;
  const reloadDebounceMs = testMode ? 12 : 75;
  const writeStabilityThresholdMs = testMode ? 12 : 75;
  const writePollIntervalMs = testMode ? 5 : 10;
  const WebSocketServerClass = opts.webSocketServerClass ?? WebSocketServer;
  const wss = liveReload
    ? new WebSocketServerClass({
        noServer: true,
        // Live reload clients never need to send application payloads; cap frames
        // before ws buffers oversized input on this long-lived upgrade route.
        maxPayload: CANVAS_LIVE_RELOAD_MAX_INBOUND_MESSAGE_BYTES,
      })
    : null;
  wss?.on("connection", (ws) => {
    // Consume maxPayload errors; ws owns client tracking and close cleanup.
    ws.on("error", () => {});
  });

  let debounce: NodeJS.Timeout | null = null;
  const broadcastReload = () => {
    if (!wss) {
      return;
    }
    wss.clients.forEach((ws) => ws.send("reload"));
  };
  const scheduleReload = () => {
    if (debounce) {
      clearNativeTimeout(debounce);
    }
    debounce = scheduleNativeTimeout(() => {
      debounce = null;
      broadcastReload();
    }, reloadDebounceMs);
    if (!testMode) {
      debounce.unref?.();
    }
  };

  let watcherClosed = false;
  const watcher = liveReload
    ? (opts.watchFactory ?? chokidar.watch)(rootReal, {
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: writeStabilityThresholdMs,
          pollInterval: writePollIntervalMs,
        },
        usePolling: testMode,
        ignored: (candidatePath) => shouldIgnoreCanvasWatchPath(rootReal, candidatePath),
      })
    : null;
  watcher?.on("all", () => scheduleReload());
  watcher?.on("error", (err) => {
    if (watcherClosed) {
      return;
    }
    watcherClosed = true;
    opts.runtime.error(
      `Canvas host watcher error: ${String(err)} (live reload disabled; consider plugins.entries.canvas.config.host.liveReload=false or a smaller plugins.entries.canvas.config.host.root)`,
    );
    void watcher.close().catch(() => {});
  });

  const handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!wss) {
      return false;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== CANVAS_WS_PATH) {
      return false;
    }
    wss.handleUpgrade(req, socket as Socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
    return true;
  };

  const handleHttpRequest = async (req: IncomingMessage, res: ServerResponse) => {
    const urlRaw = req.url;
    if (!urlRaw) {
      return false;
    }

    try {
      const url = new URL(urlRaw, "http://localhost");
      if (url.pathname === CANVAS_WS_PATH) {
        res.statusCode = liveReload ? 426 : 404;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end(liveReload ? "upgrade required" : "not found");
        return true;
      }

      let urlPath = url.pathname;
      if (basePath !== "/") {
        if (urlPath !== basePath && !urlPath.startsWith(`${basePath}/`)) {
          return false;
        }
        urlPath = urlPath === basePath ? "/" : urlPath.slice(basePath.length) || "/";
      }

      // Core owns managed transcript documents; this host keeps only Canvas/A2UI files.
      if (urlPath === "/documents" || urlPath.startsWith("/documents/")) {
        return false;
      }

      if (req.method !== "GET" && req.method !== "HEAD") {
        res.statusCode = 405;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Method Not Allowed");
        return true;
      }

      const opened = await resolveFileWithinRoot(rootReal, urlPath);
      if (!opened) {
        if (urlPath === "/" || urlPath.endsWith("/")) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(
            `<!doctype html><meta charset="utf-8" /><title>OpenClaw Canvas</title><pre>Missing file.\nCreate ${rootDir}/index.html</pre>`,
          );
          return true;
        }
        res.statusCode = 404;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("not found");
        return true;
      }

      const { handle, realPath } = opened;
      let data: Buffer;
      try {
        data = await handle.readFile();
      } finally {
        await handle.close().catch(() => {});
      }

      const lower = lowercasePreservingWhitespace(realPath);
      const mime =
        lower.endsWith(".html") || lower.endsWith(".htm")
          ? "text/html"
          : ((await detectMime({ filePath: realPath })) ?? "application/octet-stream");

      res.setHeader("Cache-Control", "no-store");
      if (mime === "text/html") {
        const html = data.toString("utf8");
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(injectCanvasRuntime(html, { liveReload }));
        return true;
      }

      res.setHeader("Content-Type", mime);
      res.end(data);
      return true;
    } catch (err) {
      opts.runtime.error(`Canvas host request failed: ${String(err)}`);
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("error");
      return true;
    }
  };

  return {
    rootDir,
    basePath,
    handleHttpRequest,
    handleUpgrade,
    close: async () => {
      if (debounce) {
        clearNativeTimeout(debounce);
      }
      watcherClosed = true;
      await watcher?.close().catch(() => {});
      wss?.clients.forEach((ws) => ws.terminate());
      if (wss) {
        await new Promise<void>((resolve) => {
          wss.close(() => resolve());
        });
      }
    },
  };
}
