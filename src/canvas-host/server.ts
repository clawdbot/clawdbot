import * as fsSync from "node:fs";
import fs from "node:fs/promises";
import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { Socket } from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import {
  clearTimeout as clearNativeTimeout,
  setTimeout as scheduleNativeTimeout,
} from "node:timers";
import chokidar from "chokidar";
import { type WebSocket, WebSocketServer } from "ws";
import { resolveStateDir } from "../config/paths.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { detectMime } from "../media/mime.js";
import type { RuntimeEnv } from "../runtime.js";
import { lowercasePreservingWhitespace, normalizeOptionalString } from "../shared/string-coerce.js";
import { ensureDir, resolveUserPath } from "../utils.js";
import {
  CANVAS_HOST_PATH,
  CANVAS_WS_PATH,
  handleA2uiHttpRequest,
  injectCanvasLiveReload,
} from "./a2ui.js";
import { normalizeUrlPath, resolveFileWithinRoot } from "./file-resolver.js";

type ChokidarWatch = typeof import("chokidar").watch;

export type CanvasHostOpts = {
  runtime: RuntimeEnv;
  rootDir?: string;
  port?: number;
  listenHost?: string;
  allowInTests?: boolean;
  liveReload?: boolean;
  watchFactory?: typeof chokidar.watch;
  webSocketServerClass?: typeof WebSocketServer;
};

export type CanvasHostServerOpts = CanvasHostOpts & {
  handler?: CanvasHostHandler;
  ownsHandler?: boolean;
};

export type CanvasHostServer = {
  port: number;
  rootDir: string;
  close: () => Promise<void>;
};

export type CanvasHostHandlerOpts = {
  runtime: RuntimeEnv;
  rootDir?: string;
  basePath?: string;
  allowInTests?: boolean;
  liveReload?: boolean;
  watchFactory?: typeof chokidar.watch;
  webSocketServerClass?: typeof WebSocketServer;
};

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
      <div class="sub">Interactive test page (auto-reload enabled)</div>
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
  const normalized = normalizeUrlPath(trimmed || CANVAS_HOST_PATH);
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
  const candidates = [path.join(resolveStateDir(), "canvas")];
  const existing = candidates.find((dir) => {
    try {
      return fsSync.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
  return existing ?? candidates[0];
}

function resolveDefaultWatchFactory(): ChokidarWatch {
  const importedWatch = (chokidar as { watch?: ChokidarWatch } | undefined)?.watch;
  if (typeof importedWatch === "function") {
    return importedWatch.bind(chokidar);
  }

  const require = createRequire(import.meta.url);
  const runtime = require("chokidar") as
    | { watch?: ChokidarWatch; default?: { watch?: ChokidarWatch } }
    | undefined;
  if (runtime && typeof runtime.watch === "function") {
    return runtime.watch.bind(runtime);
  }
  if (runtime?.default && typeof runtime.default.watch === "function") {
    return runtime.default.watch.bind(runtime.default);
  }
  throw new Error("chokidar.watch unavailable");
}

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
  const wss = liveReload ? new WebSocketServerClass({ noServer: true }) : null;
  const sockets = new Set<WebSocket>();
  if (wss) {
    wss.on("connection", (ws) => {
      sockets.add(ws);
      ws.on("close", () => sockets.delete(ws));
    });
  }

  let debounce: NodeJS.Timeout | null = null;
  const broadcastReload = () => {
    if (!liveReload) {
      return;
    }
    for (const ws of sockets) {
      try {
        ws.send("reload");
      } catch {
        // ignore
      }
    }
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
  const watchFactory = opts.watchFactory ?? resolveDefaultWatchFactory();
  const watcher = liveReload
    ? watchFactory(rootReal, {
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: writeStabilityThresholdMs,
          pollInterval: writePollIntervalMs,
        },
        usePolling: testMode,
        ignored: [
          /(^|[\\/])\../, // dotfiles
          /(^|[\\/])node_modules([\\/]|$)/,
        ],
      })
    : null;
  watcher?.on("all", () => scheduleReload());
  watcher?.on("error", (err) => {
    if (watcherClosed) {
      return;
    }
    watcherClosed = true;
    opts.runtime.error(
      `canvasHost watcher error: ${String(err)} (live reload disabled; consider canvasHost.liveReload=false or a smaller canvasHost.root)`,
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
        res.end(liveReload ? injectCanvasLiveReload(html) : html);
        return true;
      }

      res.setHeader("Content-Type", mime);
      res.end(data);
      return true;
    } catch (err) {
      opts.runtime.error(`canvasHost request failed: ${String(err)}`);
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
      for (const ws of sockets) {
        try {
          ws.terminate?.();
        } catch {
          // ignore
        }
      }
      if (wss) {
        await new Promise<void>((resolve) => wss.close(() => resolve()));
      }
    },
  };
}

export async function startCanvasHost(opts: CanvasHostServerOpts): Promise<CanvasHostServer> {
  if (isDisabledByEnv() && opts.allowInTests !== true) {
    return { port: 0, rootDir: "", close: async () => {} };
  }

  const handler =
    opts.handler ??
    (await createCanvasHostHandler({
      runtime: opts.runtime,
      rootDir: opts.rootDir,
      basePath: CANVAS_HOST_PATH,
      allowInTests: opts.allowInTests,
      liveReload: opts.liveReload,
      watchFactory: opts.watchFactory,
      webSocketServerClass: opts.webSocketServerClass,
    }));
  const ownsHandler = opts.ownsHandler ?? opts.handler === undefined;

  const bindHost = normalizeOptionalString(opts.listenHost) || "127.0.0.1";
  const server: Server = http.createServer((req, res) => {
    if (lowercasePreservingWhitespace(req.headers.upgrade ?? "") === "websocket") {
      return;
    }
    void (async () => {
      if (await handleA2uiHttpRequest(req, res)) {
        return;
      }
      if (await handler.handleHttpRequest(req, res)) {
        return;
      }
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Not Found");
    })().catch((err) => {
      opts.runtime.error(`canvasHost request failed: ${String(err)}`);
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("error");
    });
  });
  server.on("upgrade", (req, socket, head) => {
    if (handler.handleUpgrade(req, socket, head)) {
      return;
    }
    socket.destroy();
  });

  const listenPort =
    typeof opts.port === "number" && Number.isFinite(opts.port) && opts.port > 0 ? opts.port : 0;
  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(listenPort, bindHost);
  });

  const addr = server.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : 0;
  opts.runtime.log(
    `canvas host listening on http://${bindHost}:${boundPort} (root ${handler.rootDir})`,
  );

  return {
    port: boundPort,
    rootDir: handler.rootDir,
    close: async () => {
      if (ownsHandler) {
        await handler.close();
      }
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}
