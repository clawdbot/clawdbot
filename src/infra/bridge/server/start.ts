import { randomUUID } from "node:crypto";
import net from "node:net";
import os from "node:os";

import { resolveCanvasHostUrl } from "../../canvas-host-url.js";

import {
  type ConnectionState,
  createNodeBridgeConnectionHandler,
} from "./connection.js";
import { createDisabledNodeBridgeServer } from "./disabled.js";
import { encodeLine } from "./encode.js";
import { shouldAlsoListenOnLoopback } from "./loopback.js";
import { isNodeBridgeTestEnv } from "./test-env.js";
import type {
  BridgeEventFrame,
  BridgeInvokeRequestFrame,
  BridgeInvokeResponseFrame,
  NodeBridgeServer,
  NodeBridgeServerOpts,
} from "./types.js";

export async function startNodeBridgeServer(
  opts: NodeBridgeServerOpts,
): Promise<NodeBridgeServer> {
  if (
    isNodeBridgeTestEnv() &&
    process.env.CLAWDBOT_ENABLE_BRIDGE_IN_TESTS !== "1"
  ) {
    return createDisabledNodeBridgeServer();
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

  const connections = new Map<string, ConnectionState>();
  const onConnection = createNodeBridgeConnectionHandler({
    opts,
    connections,
    serverName,
    buildCanvasHostUrl,
  });

  const loopbackHost = "127.0.0.1";

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
      if (!normalizedNodeId)
        throw new Error("INVALID_REQUEST: nodeId required");
      if (!normalizedCommand)
        throw new Error("INVALID_REQUEST: command required");

      const conn = connections.get(normalizedNodeId);
      if (!conn)
        throw new Error(
          `UNAVAILABLE: node not connected (${normalizedNodeId})`,
        );

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
