import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import WebSocket, { WebSocketServer } from "ws";

import { rawDataToString } from "../infra/ws.js";

type CdpCommand = {
  id: number;
  method: string;
  params?: unknown;
  sessionId?: string;
};

type CdpResponse = {
  id: number;
  result?: unknown;
  error?: { message: string };
  sessionId?: string;
};

type CdpEvent = {
  method: string;
  params?: unknown;
  sessionId?: string;
};

type ExtensionForwardCommandMessage = {
  id: number;
  method: "forwardCDPCommand";
  params: { method: string; params?: unknown; sessionId?: string };
};

type ExtensionResponseMessage = {
  id: number;
  result?: unknown;
  error?: string;
};

type ExtensionForwardEventMessage = {
  method: "forwardCDPEvent";
  params: { method: string; params?: unknown; sessionId?: string };
};

type ExtensionPingMessage = { method: "ping" };
type ExtensionPongMessage = { method: "pong" };

type ExtensionMessage =
  | ExtensionResponseMessage
  | ExtensionForwardEventMessage
  | ExtensionPongMessage;

type TargetInfo = {
  targetId: string;
  type?: string;
  title?: string;
  url?: string;
  attached?: boolean;
};

type AttachedToTargetEvent = {
  sessionId: string;
  targetInfo: TargetInfo;
  waitingForDebugger?: boolean;
};

type DetachedFromTargetEvent = {
  sessionId: string;
  targetId?: string;
};

type ConnectedTarget = {
  sessionId: string;
  targetId: string;
  targetInfo: TargetInfo;
};

export type ChromeExtensionRelayServer = {
  host: string;
  port: number;
  baseUrl: string;
  cdpWsUrl: string;
  extensionConnected: () => boolean;
  stop: () => Promise<void>;
};

function isLoopbackHost(host: string) {
  const h = host.trim().toLowerCase();
  return (
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "0.0.0.0" ||
    h === "[::1]" ||
    h === "::1" ||
    h === "[::]" ||
    h === "::"
  );
}

function isLoopbackAddress(ip: string | undefined): boolean {
  if (!ip) return false;
  if (ip === "127.0.0.1") return true;
  if (ip.startsWith("127.")) return true;
  if (ip === "::1") return true;
  if (ip.startsWith("::ffff:127.")) return true;
  return false;
}

function parseBaseUrl(raw: string): {
  host: string;
  port: number;
  baseUrl: string;
} {
  const parsed = new URL(raw.trim().replace(/\/$/, ""));
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`extension relay cdpUrl must be http(s), got ${parsed.protocol}`);
  }
  const host = parsed.hostname;
  const port =
    parsed.port?.trim() !== "" ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`extension relay cdpUrl has invalid port: ${parsed.port || "(empty)"}`);
  }
  return { host, port, baseUrl: parsed.toString().replace(/\/$/, "") };
}

function text(res: Duplex, status: number, bodyText: string) {
  const body = Buffer.from(bodyText);
  res.write(
    `HTTP/1.1 ${status} ${status === 200 ? "OK" : "ERR"}\r\n` +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${body.length}\r\n` +
      "Connection: close\r\n" +
      "\r\n",
  );
  res.write(body);
  res.end();
}

function rejectUpgrade(socket: Duplex, status: number, bodyText: string) {
  text(socket, status, bodyText);
  try {
    socket.destroy();
  } catch {
    // ignore
  }
}

const serversByPort = new Map<number, ChromeExtensionRelayServer>();

export async function ensureChromeExtensionRelayServer(opts: {
  cdpUrl: string;
}): Promise<ChromeExtensionRelayServer> {
  const info = parseBaseUrl(opts.cdpUrl);
  if (!isLoopbackHost(info.host)) {
    throw new Error(`extension relay requires loopback cdpUrl host (got ${info.host})`);
  }

  const existing = serversByPort.get(info.port);
  if (existing) return existing;

  let extensionWs: WebSocket | null = null;
  const cdpClients = new Set<WebSocket>();
  const connectedTargets = new Map<string, ConnectedTarget>();

  const pendingExtension = new Map<
    number,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  let nextExtensionId = 1;

  const sendToExtension = async (payload: ExtensionForwardCommandMessage): Promise<unknown> => {
    const ws = extensionWs;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error("Chrome extension not connected");
    }
    ws.send(JSON.stringify(payload));
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingExtension.delete(payload.id);
        reject(new Error(`extension request timeout: ${payload.params.method}`));
      }, 30_000);
      pendingExtension.set(payload.id, { resolve, reject, timer });
    });
  };

  const broadcastToCdpClients = (evt: CdpEvent) => {
    const msg = JSON.stringify(evt);
    for (const ws of cdpClients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      ws.send(msg);
    }
  };

  const sendResponseToCdp = (ws: WebSocket, res: CdpResponse) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(res));
  };

  const ensureTargetEventsForClient = (ws: WebSocket, mode: "autoAttach" | "discover") => {
    for (const target of connectedTargets.values()) {
      if (mode === "autoAttach") {
        ws.send(
          JSON.stringify({
            method: "Target.attachedToTarget",
            params: {
              sessionId: target.sessionId,
              targetInfo: { ...target.targetInfo, attached: true },
              waitingForDebugger: false,
            },
          } satisfies CdpEvent),
        );
      } else {
        ws.send(
          JSON.stringify({
            method: "Target.targetCreated",
            params: { targetInfo: { ...target.targetInfo, attached: true } },
          } satisfies CdpEvent),
        );
      }
    }
  };

  const routeCdpCommand = async (cmd: CdpCommand): Promise<unknown> => {
    switch (cmd.method) {
      case "Browser.getVersion":
        return {
          protocolVersion: "1.3",
          product: "Chrome/Moltbot-Extension-Relay",
          revision: "0",
          userAgent: "Moltbot-Extension-Relay",
          jsVersion: "V8",
        };
      case "Browser.setDownloadBehavior":
        return {};
      case "Target.setAutoAttach":
      case "Target.setDiscoverTargets":
        return {};
      case "Target.getTargets":
        return {
          targetInfos: Array.from(connectedTargets.values()).map((t) => ({
            ...t.targetInfo,
            attached: true,
          })),
        };
      case "Target.getTargetInfo": {
        const params = (cmd.params ?? {}) as { targetId?: string };
        const targetId = typeof params.targetId === "string" ? params.targetId : undefined;
        if (targetId) {
          for (const t of connectedTargets.values()) {
            if (t.targetId === targetId) return { targetInfo: t.targetInfo };
          }
        }
        if (cmd.sessionId && connectedTargets.has(cmd.sessionId)) {
          const t = connectedTargets.get(cmd.sessionId);
          if (t) return { targetInfo: t.targetInfo };
        }
        const first = Array.from(connectedTargets.values())[0];
        return { targetInfo: first?.targetInfo };
      }
      case "Target.attachToTarget": {
        const params = (cmd.params ?? {}) as { targetId?: string };
        const targetId = typeof params.targetId === "string" ? params.targetId : undefined;
        if (!targetId) throw new Error("targetId required");
        for (const t of connectedTargets.values()) {
          if (t.targetId === targetId) return { sessionId: t.sessionId };
        }
        throw new Error("target not found");
      }
      default: {
        const id = nextExtensionId++;
        return await sendToExtension({
          id,
          method: "forwardCDPCommand",
          params: {
            method: cmd.method,
            sessionId: cmd.sessionId,
            params: cmd.params,
          },
        });
      }
    }
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", info.baseUrl);
    const path = url.pathname;

    if (req.method === "HEAD" && path === "/") {
      res.writeHead(200);
      res.end();
      return;
    }

    if (path === "/") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("OK");
      return;
    }

    if (path === "/extension/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ connected: Boolean(extensionWs) }));
      return;
    }

    const hostHeader = req.headers.host?.trim() || `${info.host}:${info.port}`;
    const wsHost = `ws://${hostHeader}`;
    const cdpWsUrl = `${wsHost}/cdp`;

    if (
      (path === "/json/version" || path === "/json/version/") &&
      (req.method === "GET" || req.method === "PUT")
    ) {
      const payload: Record<string, unknown> = {
        Browser: "Moltbot/extension-relay",
        "Protocol-Version": "1.3",
      };
      // Only advertise the WS URL if a real extension is connected.
      if (extensionWs) payload.webSocketDebuggerUrl = cdpWsUrl;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
      return;
    }

    const listPaths = new Set(["/json", "/json/", "/json/list", "/json/list/"]);
    if (listPaths.has(path) && (req.method === "GET" || req.method === "PUT")) {
      const list = Array.from(connectedTargets.values()).map((t) => ({
        id: t.targetId,
        type: t.targetInfo.type ?? "page",
        title: t.targetInfo.title ?? "",
        description: t.targetInfo.title ?? "",
        url: t.targetInfo.url ?? "",
        webSocketDebuggerUrl: cdpWsUrl,
        devtoolsFrontendUrl: `/devtools/inspector.html?ws=${cdpWsUrl.replace("ws://", "")}`,
      }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(list));
      return;
    }

    const activateMatch = path.match(/^\/json\/activate\/(.+)$/);
    if (activateMatch && (req.method === "GET" || req.method === "PUT")) {
      const targetId = decodeURIComponent(activateMatch[1] ?? "").trim();
      if (!targetId) {
        res.writeHead(400);
        res.end("targetId required");
        return;
      }
      void (async () => {
        try {
          await sendToExtension({
            id: nextExtensionId++,
            method: "forwardCDPCommand",
            params: { method: "Target.activateTarget", params: { targetId } },
          });
        } catch {
          // ignore
        }
      })();
      res.writeHead(200);
      res.end("OK");
      return;
    }

    const closeMatch = path.match(/^\/json\/close\/(.+)$/);
    if (closeMatch && (req.method === "GET" || req.method === "PUT")) {
      const targetId = decodeURIComponent(closeMatch[1] ?? "").trim();
      if (!targetId) {
        res.writeHead(400);
        res.end("targetId required");
        return;
      }
      void (async () => {
        try {
          await sendToExtension({
            id: nextExtensionId++,
            method: "forwardCDPCommand",
            params: { method: "Target.closeTarget", params: { targetId } },
          });
        } catch {
          // ignore
        }
      })();
      res.writeHead(200);
      res.end("OK");
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });

  const wssExtension = new WebSocketServer({ noServer: true });
  const wssCdp = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", info.baseUrl);
    const pathname = url.pathname;
    const remote = req.socket.remoteAddress;

    if (!isLoopbackAddress(remote)) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }

    if (pathname === "/extension") {
      if (extensionWs) {
        rejectUpgrade(socket, 409, "Extension already connected");
        return;
      }
      wssExtension.handleUpgrade(req, socket, head, (ws) => {
        wssExtension.emit("connection", ws, req);
      });
      return;
    }

    if (pathname === "/cdp") {
      if (!extensionWs) {
        rejectUpgrade(socket, 503, "Extension not connected");
        return;
      }
      wssCdp.handleUpgrade(req, socket, head, (ws) => {
        wssCdp.emit("connection", ws, req);
      });
      return;
    }

    rejectUpgrade(socket, 404, "Not Found");
  });

  wssExtension.on("connection", (ws) => {
    extensionWs = ws;

    const ping = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ method: "ping" } satisfies ExtensionPingMessage));
    }, 5000);

    ws.on("message", (data) => {
      let parsed: ExtensionMessage | null = null;
      try {
        parsed = JSON.parse(rawDataToString(data)) as ExtensionMessage;
      } catch {
        return;
      }

      if (parsed && typeof parsed === "object" && "id" in parsed && typeof parsed.id === "number") {
        const pending = pendingExtension.get(parsed.id);
        if (!pending) return;
        pendingExtension.delete(parsed.id);
        clearTimeout(pending.timer);
        if ("error" in parsed && typeof parsed.error === "string" && parsed.error.trim()) {
          pending.reject(new Error(parsed.error));
        } else {
          pending.resolve((parsed as ExtensionResponseMessage).result);
        }
        return;
      }

      if (parsed && typeof parsed === "object" && "method" in parsed) {
        if ((parsed as ExtensionPongMessage).method === "pong") return;
        if ((parsed as ExtensionForwardEventMessage).method !== "forwardCDPEvent") return;
        const evt = parsed as ExtensionForwardEventMessage;
        const method = evt.params?.method;
        const params = evt.params?.params;
        const sessionId = evt.params?.sessionId;
        if (!method || typeof method !== "string") return;

        if (method === "Target.attachedToTarget") {
          const attached = (params ?? {}) as AttachedToTargetEvent;
          const targetType = attached?.targetInfo?.type ?? "page";
          if (targetType !== "page") return;
          if (attached?.sessionId && attached?.targetInfo?.targetId) {
            const prev = connectedTargets.get(attached.sessionId);
            const nextTargetId = attached.targetInfo.targetId;
            const prevTargetId = prev?.targetId;
            const changedTarget = Boolean(prev && prevTargetId && prevTargetId !== nextTargetId);
            connectedTargets.set(attached.sessionId, {
              sessionId: attached.sessionId,
              targetId: nextTargetId,
              targetInfo: attached.targetInfo,
            });
            if (changedTarget && prevTargetId) {
              broadcastToCdpClients({
                method: "Target.detachedFromTarget",
                params: { sessionId: attached.sessionId, targetId: prevTargetId },
                sessionId: attached.sessionId,
              });
            }
            if (!prev || changedTarget) {
              broadcastToCdpClients({ method, params, sessionId });
            }
            return;
          }
        }

        if (method === "Target.detachedFromTarget") {
          const detached = (params ?? {}) as DetachedFromTargetEvent;
          if (detached?.sessionId) connectedTargets.delete(detached.sessionId);
          broadcastToCdpClients({ method, params, sessionId });
          return;
        }

        // Keep cached tab metadata fresh for /json/list.
        // After navigation, Chrome updates URL/title via Target.targetInfoChanged.
        if (method === "Target.targetInfoChanged") {
          const changed = (params ?? {}) as { targetInfo?: { targetId?: string; type?: string } };
          const targetInfo = changed?.targetInfo;
          const targetId = targetInfo?.targetId;
          if (targetId && (targetInfo?.type ?? "page") === "page") {
            for (const [sid, target] of connectedTargets) {
              if (target.targetId !== targetId) continue;
              connectedTargets.set(sid, {
                ...target,
                targetInfo: { ...target.targetInfo, ...(targetInfo as object) },
              });
            }
          }
        }

        broadcastToCdpClients({ method, params, sessionId });
      }
    });

    ws.on("close", () => {
      clearInterval(ping);
      extensionWs = null;
      for (const [, pending] of pendingExtension) {
        clearTimeout(pending.timer);
        pending.reject(new Error("extension disconnected"));
      }
      pendingExtension.clear();
      connectedTargets.clear();

      for (const client of cdpClients) {
        try {
          client.close(1011, "extension disconnected");
        } catch {
          // ignore
        }
      }
      cdpClients.clear();
    });
  });

  wssCdp.on("connection", (ws) => {
    cdpClients.add(ws);

    ws.on("message", async (data) => {
      let cmd: CdpCommand | null = null;
      try {
        cmd = JSON.parse(rawDataToString(data)) as CdpCommand;
      } catch {
        return;
      }
      if (!cmd || typeof cmd !== "object") return;
      if (typeof cmd.id !== "number" || typeof cmd.method !== "string") return;

      if (!extensionWs) {
        sendResponseToCdp(ws, {
          id: cmd.id,
          sessionId: cmd.sessionId,
          error: { message: "Extension not connected" },
        });
        return;
      }

      try {
        const result = await routeCdpCommand(cmd);

        if (cmd.method === "Target.setAutoAttach" && !cmd.sessionId) {
          ensureTargetEventsForClient(ws, "autoAttach");
        }
        if (cmd.method === "Target.setDiscoverTargets") {
          const discover = (cmd.params ?? {}) as { discover?: boolean };
          if (discover.discover === true) {
            ensureTargetEventsForClient(ws, "discover");
          }
        }
        if (cmd.method === "Target.attachToTarget") {
          const params = (cmd.params ?? {}) as { targetId?: string };
          const targetId = typeof params.targetId === "string" ? params.targetId : undefined;
          if (targetId) {
            const target = Array.from(connectedTargets.values()).find(
              (t) => t.targetId === targetId,
            );
            if (target) {
              ws.send(
                JSON.stringify({
                  method: "Target.attachedToTarget",
                  params: {
                    sessionId: target.sessionId,
                    targetInfo: { ...target.targetInfo, attached: true },
                    waitingForDebugger: false,
                  },
                } satisfies CdpEvent),
              );
            }
          }
        }

        sendResponseToCdp(ws, { id: cmd.id, sessionId: cmd.sessionId, result });
      } catch (err) {
        sendResponseToCdp(ws, {
          id: cmd.id,
          sessionId: cmd.sessionId,
          error: { message: err instanceof Error ? err.message : String(err) },
        });
      }
    });

    ws.on("close", () => {
      cdpClients.delete(ws);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(info.port, info.host, () => resolve());
    server.once("error", reject);
  });

  const addr = server.address() as AddressInfo | null;
  const port = addr?.port ?? info.port;
  const host = info.host;
  const baseUrl = `${new URL(info.baseUrl).protocol}//${host}:${port}`;

  const relay: ChromeExtensionRelayServer = {
    host,
    port,
    baseUrl,
    cdpWsUrl: `ws://${host}:${port}/cdp`,
    extensionConnected: () => Boolean(extensionWs),
    stop: async () => {
      serversByPort.delete(port);
      try {
        extensionWs?.close(1001, "server stopping");
      } catch {
        // ignore
      }
      for (const ws of cdpClients) {
        try {
          ws.close(1001, "server stopping");
        } catch {
          // ignore
        }
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      wssExtension.close();
      wssCdp.close();
    },
  };

  serversByPort.set(port, relay);
  return relay;
}

export async function stopChromeExtensionRelayServer(opts: { cdpUrl: string }): Promise<boolean> {
  const info = parseBaseUrl(opts.cdpUrl);
  const existing = serversByPort.get(info.port);
  if (!existing) return false;
  await existing.stop();
  return true;
}
