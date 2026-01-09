import { randomUUID } from "node:crypto";
import net from "node:net";
import os from "node:os";

import { resolveCanvasHostUrl } from "../canvas-host-url.js";
import {
  getPairedNode,
  listNodePairing,
  type NodePairingPendingRequest,
  requestNodePairing,
  updatePairedNodeMetadata,
  verifyNodeToken,
} from "../node-pairing.js";

type BridgeHelloFrame = {
  type: "hello";
  nodeId: string;
  displayName?: string;
  token?: string;
  platform?: string;
  version?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  caps?: string[];
  commands?: string[];
  permissions?: Record<string, boolean>;
};

type BridgePairRequestFrame = {
  type: "pair-request";
  nodeId: string;
  displayName?: string;
  platform?: string;
  version?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  caps?: string[];
  commands?: string[];
  permissions?: Record<string, boolean>;
  remoteAddress?: string;
  silent?: boolean;
};

type BridgeEventFrame = {
  type: "event";
  event: string;
  payloadJSON?: string | null;
};

type BridgeRPCRequestFrame = {
  type: "req";
  id: string;
  method: string;
  paramsJSON?: string | null;
};

type BridgeRPCResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payloadJSON?: string | null;
  error?: { code: string; message: string; details?: unknown } | null;
};

type BridgePingFrame = { type: "ping"; id: string };
type BridgePongFrame = { type: "pong"; id: string };

type BridgeInvokeRequestFrame = {
  type: "invoke";
  id: string;
  command: string;
  paramsJSON?: string | null;
};

type BridgeInvokeResponseFrame = {
  type: "invoke-res";
  id: string;
  ok: boolean;
  payloadJSON?: string | null;
  error?: { code: string; message: string } | null;
};

type BridgeHelloOkFrame = {
  type: "hello-ok";
  serverName: string;
  canvasHostUrl?: string;
};
type BridgePairOkFrame = { type: "pair-ok"; token: string };
type BridgeErrorFrame = { type: "error"; code: string; message: string };

type AnyBridgeFrame =
  | BridgeHelloFrame
  | BridgePairRequestFrame
  | BridgeEventFrame
  | BridgeRPCRequestFrame
  | BridgeRPCResponseFrame
  | BridgePingFrame
  | BridgePongFrame
  | BridgeInvokeRequestFrame
  | BridgeInvokeResponseFrame
  | BridgeHelloOkFrame
  | BridgePairOkFrame
  | BridgeErrorFrame
  | { type: string; [k: string]: unknown };

export type NodeBridgeServer = {
  port: number;
  close: () => Promise<void>;
  invoke: (opts: {
    nodeId: string;
    command: string;
    paramsJSON?: string | null;
    timeoutMs?: number;
  }) => Promise<BridgeInvokeResponseFrame>;
  sendEvent: (opts: {
    nodeId: string;
    event: string;
    payloadJSON?: string | null;
  }) => void;
  listConnected: () => NodeBridgeClientInfo[];
  listeners: Array<{ host: string; port: number }>;
};

export type NodeBridgeClientInfo = {
  nodeId: string;
  displayName?: string;
  platform?: string;
  version?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  remoteIp?: string;
  caps?: string[];
  commands?: string[];
  permissions?: Record<string, boolean>;
};

export type NodeBridgeServerOpts = {
  host: string;
  port: number; // 0 = ephemeral
  pairingBaseDir?: string;
  canvasHostPort?: number;
  canvasHostHost?: string;
  onEvent?: (nodeId: string, evt: BridgeEventFrame) => Promise<void> | void;
  onRequest?: (
    nodeId: string,
    req: BridgeRPCRequestFrame,
  ) => Promise<
    | { ok: true; payloadJSON?: string | null }
    | { ok: false; error: { code: string; message: string; details?: unknown } }
  >;
  onAuthenticated?: (node: NodeBridgeClientInfo) => Promise<void> | void;
  onDisconnected?: (node: NodeBridgeClientInfo) => Promise<void> | void;
  onPairRequested?: (
    request: NodePairingPendingRequest,
  ) => Promise<void> | void;
  serverName?: string;
};

function isTestEnv() {
  return process.env.NODE_ENV === "test" || Boolean(process.env.VITEST);
}

export function configureNodeBridgeSocket(socket: {
  setNoDelay: (noDelay?: boolean) => void;
  setKeepAlive: (enable?: boolean, initialDelay?: number) => void;
}) {
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 15_000);
}

function encodeLine(frame: AnyBridgeFrame) {
  return `${JSON.stringify(frame)}\n`;
}

async function sleep(ms: number) {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function startNodeBridgeServer(
  opts: NodeBridgeServerOpts,
): Promise<NodeBridgeServer> {
  if (isTestEnv() && process.env.CLAWDBOT_ENABLE_BRIDGE_IN_TESTS !== "1") {
    return {
      port: 0,
      close: async () => {},
      invoke: async () => {
        throw new Error("bridge disabled in tests");
      },
      sendEvent: () => {},
      listConnected: () => [],
      listeners: [],
    };
  }

  const serverName =
    typeof opts.serverName === "string" && opts.serverName.trim()
      ? opts.serverName.trim()
      : os.hostname();

  const buildCanvasHostUrl = (socket: net.Socket) => {
    return resolveCanvasHostUrl({
      canvasPort: opts.canvasHostPort,
      hostOverride: opts.canvasHostHost,
      localAddress: socket.localAddress,
      scheme: "http",
    });
  };

  type ConnectionState = {
    socket: net.Socket;
    nodeInfo: NodeBridgeClientInfo;
    invokeWaiters: Map<
      string,
      {
        resolve: (value: BridgeInvokeResponseFrame) => void;
        reject: (err: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >;
  };

  const connections = new Map<string, ConnectionState>();

  const shouldAlsoListenOnLoopback = (host: string | undefined) => {
    const h = String(host ?? "")
      .trim()
      .toLowerCase();
    if (!h) return false; // default listen() already includes loopback
    if (h === "0.0.0.0" || h === "::") return false; // already includes loopback
    if (h === "localhost") return false;
    if (h === "127.0.0.1" || h.startsWith("127.")) return false;
    if (h === "::1") return false;
    return true;
  };

  const loopbackHost = "127.0.0.1";

  const onConnection = (socket: net.Socket) => {
    configureNodeBridgeSocket(socket);

    let buffer = "";
    let isAuthenticated = false;
    let nodeId: string | null = null;
    let nodeInfo: NodeBridgeClientInfo | null = null;
    const invokeWaiters = new Map<
      string,
      {
        resolve: (value: BridgeInvokeResponseFrame) => void;
        reject: (err: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();

    const abort = new AbortController();
    const stop = () => {
      if (!abort.signal.aborted) abort.abort();
      for (const [, waiter] of invokeWaiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("bridge connection closed"));
      }
      invokeWaiters.clear();
      if (nodeId) {
        const existing = connections.get(nodeId);
        if (existing?.socket === socket) connections.delete(nodeId);
      }
    };

    const send = (frame: AnyBridgeFrame) => {
      try {
        socket.write(encodeLine(frame));
      } catch {
        // ignore
      }
    };

    const sendError = (code: string, message: string) => {
      send({ type: "error", code, message } satisfies BridgeErrorFrame);
    };

    const remoteAddress = (() => {
      const addr = socket.remoteAddress?.trim();
      return addr && addr.length > 0 ? addr : undefined;
    })();

    const handleHello = async (hello: BridgeHelloFrame) => {
      nodeId = String(hello.nodeId ?? "").trim();
      if (!nodeId) {
        sendError("INVALID_REQUEST", "nodeId required");
        return;
      }

      const token = typeof hello.token === "string" ? hello.token.trim() : "";
      if (!token) {
        const paired = await getPairedNode(nodeId, opts.pairingBaseDir);
        sendError(paired ? "UNAUTHORIZED" : "NOT_PAIRED", "pairing required");
        return;
      }

      const verified = await verifyNodeToken(
        nodeId,
        token,
        opts.pairingBaseDir,
      );
      if (!verified.ok || !verified.node) {
        sendError("UNAUTHORIZED", "invalid token");
        return;
      }

      const inferCaps = (frame: {
        platform?: string;
        deviceFamily?: string;
      }): string[] | undefined => {
        const platform = String(frame.platform ?? "")
          .trim()
          .toLowerCase();
        const family = String(frame.deviceFamily ?? "")
          .trim()
          .toLowerCase();
        if (platform.includes("ios") || platform.includes("ipados")) {
          return ["canvas", "camera"];
        }
        if (platform.includes("android")) {
          return ["canvas", "camera"];
        }
        if (family === "ipad" || family === "iphone" || family === "ios") {
          return ["canvas", "camera"];
        }
        if (family === "android") {
          return ["canvas", "camera"];
        }
        return undefined;
      };

      const normalizePermissions = (
        raw: unknown,
      ): Record<string, boolean> | undefined => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw))
          return undefined;
        const entries = Object.entries(raw as Record<string, unknown>)
          .map(([key, value]) => [String(key).trim(), value === true] as const)
          .filter(([key]) => key.length > 0);
        if (entries.length === 0) return undefined;
        return Object.fromEntries(entries);
      };

      const caps =
        (Array.isArray(hello.caps)
          ? hello.caps.map((c) => String(c)).filter(Boolean)
          : undefined) ??
        verified.node.caps ??
        inferCaps(hello);

      const commands =
        Array.isArray(hello.commands) && hello.commands.length > 0
          ? hello.commands.map((c) => String(c)).filter(Boolean)
          : verified.node.commands;
      const helloPermissions = normalizePermissions(hello.permissions);
      const basePermissions = verified.node.permissions ?? {};
      const permissions = helloPermissions
        ? { ...basePermissions, ...helloPermissions }
        : verified.node.permissions;

      isAuthenticated = true;
      const existing = connections.get(nodeId);
      if (existing?.socket && existing.socket !== socket) {
        try {
          existing.socket.destroy();
        } catch {
          /* ignore */
        }
      }
      nodeInfo = {
        nodeId,
        displayName: verified.node.displayName ?? hello.displayName,
        platform: verified.node.platform ?? hello.platform,
        version: verified.node.version ?? hello.version,
        deviceFamily: verified.node.deviceFamily ?? hello.deviceFamily,
        modelIdentifier: verified.node.modelIdentifier ?? hello.modelIdentifier,
        caps,
        commands,
        permissions,
        remoteIp: remoteAddress,
      };
      await updatePairedNodeMetadata(
        nodeId,
        {
          displayName: nodeInfo.displayName,
          platform: nodeInfo.platform,
          version: nodeInfo.version,
          deviceFamily: nodeInfo.deviceFamily,
          modelIdentifier: nodeInfo.modelIdentifier,
          remoteIp: nodeInfo.remoteIp,
          caps: nodeInfo.caps,
          commands: nodeInfo.commands,
          permissions: nodeInfo.permissions,
        },
        opts.pairingBaseDir,
      );
      connections.set(nodeId, { socket, nodeInfo, invokeWaiters });
      send({
        type: "hello-ok",
        serverName,
        canvasHostUrl: buildCanvasHostUrl(socket),
      } satisfies BridgeHelloOkFrame);
      await opts.onAuthenticated?.(nodeInfo);
    };

    const waitForApproval = async (request: {
      requestId: string;
      nodeId: string;
      ts: number;
      isRepair?: boolean;
    }): Promise<
      { ok: true; token: string } | { ok: false; reason: string }
    > => {
      const deadline = Date.now() + 5 * 60 * 1000;
      while (!abort.signal.aborted && Date.now() < deadline) {
        const list = await listNodePairing(opts.pairingBaseDir);
        const stillPending = list.pending.some(
          (p) => p.requestId === request.requestId,
        );
        if (stillPending) {
          await sleep(250);
          continue;
        }

        const paired = await getPairedNode(request.nodeId, opts.pairingBaseDir);
        if (!paired) return { ok: false, reason: "pairing rejected" };

        // For a repair, ensure this approval happened after the request was created.
        if (paired.approvedAtMs < request.ts) {
          return { ok: false, reason: "pairing rejected" };
        }

        return { ok: true, token: paired.token };
      }

      return {
        ok: false,
        reason: abort.signal.aborted ? "disconnected" : "pairing expired",
      };
    };

    const handlePairRequest = async (req: BridgePairRequestFrame) => {
      nodeId = String(req.nodeId ?? "").trim();
      if (!nodeId) {
        sendError("INVALID_REQUEST", "nodeId required");
        return;
      }

      const result = await requestNodePairing(
        {
          nodeId,
          displayName: req.displayName,
          platform: req.platform,
          version: req.version,
          deviceFamily: req.deviceFamily,
          modelIdentifier: req.modelIdentifier,
          caps: Array.isArray(req.caps)
            ? req.caps.map((c) => String(c)).filter(Boolean)
            : undefined,
          commands: Array.isArray(req.commands)
            ? req.commands.map((c) => String(c)).filter(Boolean)
            : undefined,
          permissions:
            req.permissions && typeof req.permissions === "object"
              ? (req.permissions as Record<string, boolean>)
              : undefined,
          remoteIp: remoteAddress,
          silent: req.silent === true ? true : undefined,
        },
        opts.pairingBaseDir,
      );
      if (result.created) {
        await opts.onPairRequested?.(result.request);
      }

      const wait = await waitForApproval(result.request);
      if (!wait.ok) {
        sendError("UNAUTHORIZED", wait.reason);
        return;
      }

      isAuthenticated = true;
      const existing = connections.get(nodeId);
      if (existing?.socket && existing.socket !== socket) {
        try {
          existing.socket.destroy();
        } catch {
          /* ignore */
        }
      }
      nodeInfo = {
        nodeId,
        displayName: req.displayName,
        platform: req.platform,
        version: req.version,
        deviceFamily: req.deviceFamily,
        modelIdentifier: req.modelIdentifier,
        caps: Array.isArray(req.caps)
          ? req.caps.map((c) => String(c)).filter(Boolean)
          : undefined,
        commands: Array.isArray(req.commands)
          ? req.commands.map((c) => String(c)).filter(Boolean)
          : undefined,
        permissions:
          req.permissions && typeof req.permissions === "object"
            ? (req.permissions as Record<string, boolean>)
            : undefined,
        remoteIp: remoteAddress,
      };
      connections.set(nodeId, { socket, nodeInfo, invokeWaiters });
      send({ type: "pair-ok", token: wait.token } satisfies BridgePairOkFrame);
      send({
        type: "hello-ok",
        serverName,
        canvasHostUrl: buildCanvasHostUrl(socket),
      } satisfies BridgeHelloOkFrame);
      await opts.onAuthenticated?.(nodeInfo);
    };

    const handleEvent = async (evt: BridgeEventFrame) => {
      if (!isAuthenticated || !nodeId) {
        sendError("UNAUTHORIZED", "not authenticated");
        return;
      }
      await opts.onEvent?.(nodeId, evt);
    };

    const handleRequest = async (req: BridgeRPCRequestFrame) => {
      if (!isAuthenticated || !nodeId) {
        send({
          type: "res",
          id: String(req.id ?? ""),
          ok: false,
          error: { code: "UNAUTHORIZED", message: "not authenticated" },
        } satisfies BridgeRPCResponseFrame);
        return;
      }

      if (!opts.onRequest) {
        send({
          type: "res",
          id: String(req.id ?? ""),
          ok: false,
          error: { code: "UNAVAILABLE", message: "RPC not supported" },
        } satisfies BridgeRPCResponseFrame);
        return;
      }

      const id = String(req.id ?? "");
      const method = String(req.method ?? "");
      if (!id || !method) {
        send({
          type: "res",
          id: id || "invalid",
          ok: false,
          error: { code: "INVALID_REQUEST", message: "id and method required" },
        } satisfies BridgeRPCResponseFrame);
        return;
      }

      try {
        const result = await opts.onRequest(nodeId, {
          type: "req",
          id,
          method,
          paramsJSON: req.paramsJSON ?? null,
        });
        if (result.ok) {
          send({
            type: "res",
            id,
            ok: true,
            payloadJSON: result.payloadJSON ?? null,
          } satisfies BridgeRPCResponseFrame);
        } else {
          send({
            type: "res",
            id,
            ok: false,
            error: result.error,
          } satisfies BridgeRPCResponseFrame);
        }
      } catch (err) {
        send({
          type: "res",
          id,
          ok: false,
          error: { code: "UNAVAILABLE", message: String(err) },
        } satisfies BridgeRPCResponseFrame);
      }
    };

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx === -1) break;
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const trimmed = line.trim();
        if (!trimmed) continue;

        void (async () => {
          let frame: AnyBridgeFrame;
          try {
            frame = JSON.parse(trimmed) as AnyBridgeFrame;
          } catch (err) {
            sendError("INVALID_REQUEST", String(err));
            return;
          }

          const type = typeof frame.type === "string" ? frame.type : "";
          try {
            switch (type) {
              case "hello":
                await handleHello(frame as BridgeHelloFrame);
                break;
              case "pair-request":
                await handlePairRequest(frame as BridgePairRequestFrame);
                break;
              case "event":
                await handleEvent(frame as BridgeEventFrame);
                break;
              case "req":
                await handleRequest(frame as BridgeRPCRequestFrame);
                break;
              case "ping": {
                if (!isAuthenticated) {
                  sendError("UNAUTHORIZED", "not authenticated");
                  break;
                }
                const ping = frame as BridgePingFrame;
                send({
                  type: "pong",
                  id: String(ping.id ?? ""),
                } satisfies BridgePongFrame);
                break;
              }
              case "invoke-res": {
                if (!isAuthenticated) {
                  sendError("UNAUTHORIZED", "not authenticated");
                  break;
                }
                const res = frame as BridgeInvokeResponseFrame;
                const waiter = invokeWaiters.get(res.id);
                if (waiter) {
                  invokeWaiters.delete(res.id);
                  clearTimeout(waiter.timer);
                  waiter.resolve(res);
                }
                break;
              }
              case "invoke": {
                // Direction is gateway -> node only.
                sendError("INVALID_REQUEST", "invoke not allowed from node");
                break;
              }
              case "res":
                // Direction is node -> gateway only.
                sendError("INVALID_REQUEST", "res not allowed from node");
                break;
              case "pong":
                // ignore
                break;
              default:
                sendError("INVALID_REQUEST", "unknown type");
            }
          } catch (err) {
            sendError("INVALID_REQUEST", String(err));
          }
        })();
      }
    });

    socket.on("close", () => {
      const info = nodeInfo;
      stop();
      if (info && isAuthenticated) void opts.onDisconnected?.(info);
    });
    socket.on("error", () => {
      // close handler will run after close
    });
  };

  const listeners: Array<{ host: string; server: net.Server }> = [];
  const primary = net.createServer(onConnection);
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    primary.once("error", onError);
    primary.listen(opts.port, opts.host, () => {
      primary.off("error", onError);
      resolve();
    });
  });
  listeners.push({
    host: String(opts.host ?? "").trim() || "(default)",
    server: primary,
  });

  const address = primary.address();
  const port =
    typeof address === "object" && address ? address.port : opts.port;

  if (shouldAlsoListenOnLoopback(opts.host)) {
    const loopback = net.createServer(onConnection);
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => reject(err);
        loopback.once("error", onError);
        loopback.listen(port, loopbackHost, () => {
          loopback.off("error", onError);
          resolve();
        });
      });
      listeners.push({ host: loopbackHost, server: loopback });
    } catch {
      try {
        loopback.close();
      } catch {
        /* ignore */
      }
    }
  }

  return {
    port,
    close: async () => {
      for (const sock of connections.values()) {
        try {
          sock.socket.destroy();
        } catch {
          /* ignore */
        }
      }
      connections.clear();
      await Promise.all(
        listeners.map(
          (l) =>
            new Promise<void>((resolve, reject) =>
              l.server.close((err) => (err ? reject(err) : resolve())),
            ),
        ),
      );
    },
    listConnected: () => [...connections.values()].map((c) => c.nodeInfo),
    listeners: listeners.map((l) => ({ host: l.host, port })),
    sendEvent: ({ nodeId, event, payloadJSON }) => {
      const normalizedNodeId = String(nodeId ?? "").trim();
      const normalizedEvent = String(event ?? "").trim();
      if (!normalizedNodeId || !normalizedEvent) return;
      const conn = connections.get(normalizedNodeId);
      if (!conn) return;
      try {
        conn.socket.write(
          encodeLine({
            type: "event",
            event: normalizedEvent,
            payloadJSON: payloadJSON ?? null,
          } satisfies BridgeEventFrame),
        );
      } catch {
        // ignore
      }
    },
    invoke: async ({ nodeId, command, paramsJSON, timeoutMs }) => {
      const normalizedNodeId = String(nodeId ?? "").trim();
      const normalizedCommand = String(command ?? "").trim();
      if (!normalizedNodeId) {
        throw new Error("INVALID_REQUEST: nodeId required");
      }
      if (!normalizedCommand) {
        throw new Error("INVALID_REQUEST: command required");
      }

      const conn = connections.get(normalizedNodeId);
      if (!conn) {
        throw new Error(
          `UNAVAILABLE: node not connected (${normalizedNodeId})`,
        );
      }

      const id = randomUUID();
      const timeout = Number.isFinite(timeoutMs) ? Number(timeoutMs) : 15_000;

      return await new Promise<BridgeInvokeResponseFrame>((resolve, reject) => {
        const timer = setTimeout(
          () => {
            conn.invokeWaiters.delete(id);
            reject(new Error("UNAVAILABLE: invoke timeout"));
          },
          Math.max(0, timeout),
        );

        conn.invokeWaiters.set(id, { resolve, reject, timer });
        try {
          conn.socket.write(
            encodeLine({
              type: "invoke",
              id,
              command: normalizedCommand,
              paramsJSON: paramsJSON ?? null,
            } satisfies BridgeInvokeRequestFrame),
          );
        } catch (err) {
          conn.invokeWaiters.delete(id);
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    },
  };
}
