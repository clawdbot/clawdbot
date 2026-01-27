import fs from "node:fs/promises";
import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";

import chokidar from "chokidar";
import { type WebSocket, WebSocketServer } from "ws";
import { isTruthyEnvValue } from "../infra/env.js";
import { SafeOpenError, openFileWithinRoot } from "../infra/fs-safe.js";
import { detectMime } from "../media/mime.js";
import type { RuntimeEnv } from "../runtime.js";
import { ensureDir, resolveUserPath } from "../utils.js";
import {
  CANVAS_HOST_PATH,
  CANVAS_WS_PATH,
  handleA2uiHttpRequest,
  injectCanvasLiveReload,
} from "./a2ui.js";

export type CanvasHostOpts = {
  runtime: RuntimeEnv;
  rootDir?: string;
  port?: number;
  listenHost?: string;
  allowInTests?: boolean;
  liveReload?: boolean;
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
<title>Moltbot Canvas</title>
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
      <h1>Moltbot Canvas</h1>
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
      (window.webkit.messageHandlers.moltbotCanvasA2UIAction ||
        window.webkit.messageHandlers.clawdbotCanvasA2UIAction)
    );
  const hasAndroid = () =>
    !!(
      (window.moltbotCanvasA2UIAction &&
        typeof window.moltbotCanvasA2UIAction.postMessage === "function") ||
      (window.clawdbotCanvasA2UIAction &&
        typeof window.clawdbotCanvasA2UIAction.postMessage === "function")
    );
  const legacySend = typeof window.clawdbotSendUserAction === "function" ? window.clawdbotSendUserAction : undefined;
  if (!window.moltbotSendUserAction && legacySend) {
    window.moltbotSendUserAction = legacySend;
  }
  if (!window.clawdbotSendUserAction && typeof window.moltbotSendUserAction === "function") {
    window.clawdbotSendUserAction = window.moltbotSendUserAction;
  }
  const hasHelper = () =>
    typeof window.moltbotSendUserAction === "function" ||
    typeof window.clawdbotSendUserAction === "function";
  statusEl.innerHTML =
    "Bridge: " +
    (hasHelper() ? "<span class='ok'>ready</span>" : "<span class='bad'>missing</span>") +
    " · iOS=" + (hasIOS() ? "yes" : "no") +
    " · Android=" + (hasAndroid() ? "yes" : "no");

  window.addEventListener("moltbot:a2ui-action-status", (ev) => {
    const d = ev && ev.detail || {};
    log("Action status: id=" + (d.id || "?") + " ok=" + String(!!d.ok) + (d.error ? (" error=" + d.error) : ""));
  });

  function send(name, sourceComponentId) {
    if (!hasHelper()) {
      log("No action bridge found. Ensure you're viewing this on an iOS/Android Moltbot node canvas.");
      return;
    }
    const sendUserAction =
      typeof window.moltbotSendUserAction === "function"
        ? window.moltbotSendUserAction
        : window.clawdbotSendUserAction;
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

function normalizeUrlPath(rawPath: string): string {
  const decoded = decodeURIComponent(rawPath || "/");
  const normalized = path.posix.normalize(decoded);
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

async function resolveFilePath(rootReal: string, urlPath: string) {
  const normalized = normalizeUrlPath(urlPath);
  const rel = normalized.replace(/^\/+/, "");
  if (rel.split("/").some((p) => p === "..")) return null;

  const tryOpen = async (relative: string) => {
    try {
      return await openFileWithinRoot({ rootDir: rootReal, relativePath: relative });
    } catch (err) {
      if (err instanceof SafeOpenError) return null;
      throw err;
    }
  };

  if (normalized.endsWith("/")) {
    return await tryOpen(path.posix.join(rel, "index.html"));
  }

  const candidate = path.join(rootReal, rel);
  try {
    const st = await fs.lstat(candidate);
    if (st.isSymbolicLink()) return null;
    if (st.isDirectory()) {
      return await tryOpen(path.posix.join(rel, "index.html"));
    }
  } catch {
    // ignore
  }

  return await tryOpen(rel);
}

function isDisabledByEnv() {
  if (isTruthyEnvValue(process.env.CLAWDBOT_SKIP_CANVAS_HOST)) return true;
  if (process.env.NODE_ENV === "test") return true;
  if (process.env.VITEST) return true;
  return false;
}

function normalizeBasePath(rawPath: string | undefined) {
  const trimmed = (rawPath ?? CANVAS_HOST_PATH).trim();
  const normalized = normalizeUrlPath(trimmed || CANVAS_HOST_PATH);
  if (normalized === "/") return "/";
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

  const rootDir = resolveUserPath(opts.rootDir ?? path.join(os.homedir(), "clawd", "canvas"));
  const rootReal = await prepareCanvasRoot(rootDir);

  const liveReload = opts.liveReload !== false;
  const wss = liveReload ? new WebSocketServer({ noServer: true }) : null;
  const sockets = new Set<WebSocket>();
  if (wss) {
    wss.on("connection", (ws) => {
      sockets.add(ws);
      ws.on("close", () => sockets.delete(ws));
    });
  }

  let debounce: NodeJS.Timeout | null = null;
  const broadcastReload = () => {
    if (!liveReload) return;
    for (const ws of sockets) {
      try {
        ws.send("reload");
      } catch {
        // ignore
      }
    }
  };
  const scheduleReload = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      broadcastReload();
    }, 75);
    debounce.unref?.();
  };

  let watcherClosed = false;
  const watcher = liveReload
    ? chokidar.watch(rootReal, {
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 75, pollInterval: 10 },
        usePolling: opts.allowInTests === true,
        ignored: [
          /(^|[\\/])\../, // dotfiles
          /(^|[\\/])node_modules([\\/]|$)/,
        ],
      })
    : null;
  watcher?.on("all", () => scheduleReload());
  watcher?.on("error", (err) => {
    if (watcherClosed) return;
    watcherClosed = true;
    opts.runtime.error(
      `canvasHost watcher error: ${String(err)} (live reload disabled; consider canvasHost.liveReload=false or a smaller canvasHost.root)`,
    );
    void watcher.close().catch(() => {});
  });

  const handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!wss) return false;
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== CANVAS_WS_PATH) return false;
    wss.handleUpgrade(req, socket as Socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
    return true;
  };

  const handleHttpRequest = async (req: IncomingMessage, res: ServerResponse) => {
    const urlRaw = req.url;
    if (!urlRaw) return false;

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
        if (urlPath === basePath) {
          urlPath = "/";
        } else if (urlPath.startsWith(`${basePath}/`)) {
          urlPath = urlPath.slice(basePath.length) || "/";
        } else {
          return false;
        }
      }

      if (req.method !== "GET" && req.method !== "HEAD") {
        res.statusCode = 405;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Method Not Allowed");
        return true;
      }

      const opened = await resolveFilePath(rootReal, urlPath);
      if (!opened) {
        if (urlPath === "/" || urlPath.endsWith("/")) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(
            `<!doctype html><meta charset="utf-8" /><title>Moltbot Canvas</title><pre>Missing file.\nCreate ${rootDir}/index.html</pre>`,
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

      const lower = realPath.toLowerCase();
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
      if (debounce) clearTimeout(debounce);
      watcherClosed = true;
      await watcher?.close().catch(() => {});
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
    }));
  const ownsHandler = opts.ownsHandler ?? opts.handler === undefined;

  const bindHost = opts.listenHost?.trim() || "0.0.0.0";
  const server: Server = http.createServer((req, res) => {
    if (String(req.headers.upgrade ?? "").toLowerCase() === "websocket") return;
    void (async () => {
      if (await handleA2uiHttpRequest(req, res)) return;
      if (await handler.handleHttpRequest(req, res)) return;
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
    if (handler.handleUpgrade(req, socket, head)) return;
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
      if (ownsHandler) await handler.close();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}
