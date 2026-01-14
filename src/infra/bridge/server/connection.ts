import type net from "node:net";

import {
  getPairedNode,
  listNodePairing,
  requestNodePairing,
  updatePairedNodeMetadata,
  verifyNodeToken,
} from "../../node-pairing.js";

import { encodeLine } from "./encode.js";
import { configureNodeBridgeSocket } from "./socket.js";
import type {
  AnyBridgeFrame,
  BridgeErrorFrame,
  BridgeEventFrame,
  BridgeHelloFrame,
  BridgeHelloOkFrame,
  BridgeInvokeResponseFrame,
  BridgePairOkFrame,
  BridgePairRequestFrame,
  BridgePingFrame,
  BridgePongFrame,
  BridgeRPCRequestFrame,
  BridgeRPCResponseFrame,
  NodeBridgeClientInfo,
  NodeBridgeServerOpts,
} from "./types.js";

type InvokeWaiter = {
  resolve: (value: BridgeInvokeResponseFrame) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type ConnectionState = {
  socket: net.Socket;
  nodeInfo: NodeBridgeClientInfo;
  invokeWaiters: Map<string, InvokeWaiter>;
};

async function sleep(ms: number) {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function createNodeBridgeConnectionHandler(params: {
  opts: NodeBridgeServerOpts;
  connections: Map<string, ConnectionState>;
  serverName: string;
  buildCanvasHostUrl: (socket: net.Socket) => string | undefined;
}) {
  const { opts, connections, serverName } = params;

  return (socket: net.Socket) => {
    configureNodeBridgeSocket(socket);

    let buffer = "";
    let isAuthenticated = false;
    let nodeId: string | null = null;
    let nodeInfo: NodeBridgeClientInfo | null = null;
    const invokeWaiters = new Map<string, InvokeWaiter>();

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
      if (platform.includes("ios") || platform.includes("ipados"))
        return ["canvas", "camera"];
      if (platform.includes("android")) return ["canvas", "camera"];
      if (family === "ipad" || family === "iphone" || family === "ios")
        return ["canvas", "camera"];
      if (family === "android") return ["canvas", "camera"];
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
        canvasHostUrl: params.buildCanvasHostUrl(socket),
      } satisfies BridgeHelloOkFrame);
      await opts.onAuthenticated?.(nodeInfo);
    };

    const waitForApproval = async (request: {
      requestId: string;
      nodeId: string;
      ts: number;
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

        // Ensure this approval happened after the request was created.
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
      if (result.created) await opts.onPairRequested?.(result.request);

      const wait = await waitForApproval({
        requestId: result.request.requestId,
        nodeId: result.request.nodeId,
        ts: result.request.ts,
      });
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
        canvasHostUrl: params.buildCanvasHostUrl(socket),
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
              case "invoke":
                // Direction is gateway -> node only.
                sendError("INVALID_REQUEST", "invoke not allowed from node");
                break;
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
}
