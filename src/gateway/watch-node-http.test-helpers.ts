import { createServer, type Server, type ServerResponse } from "node:http";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getPairedDevice, resolveNodePairingState } from "../infra/device-pairing.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import { NodeRegistry } from "./node-registry.js";
import { createWatchNodeHttpRuntime } from "./watch-node-http.js";

export async function startWatchNodeHttpRuntime(
  baseDir: string,
  servers: Server[],
  options?: {
    rateLimiter?: AuthRateLimiter;
    abortConnectResponse?: boolean;
    config?: OpenClawConfig;
    now?: () => number;
    onConnectResponseStart?: () => void;
    onPollReady?: (response: ServerResponse) => void;
  },
) {
  const nodeRegistry = new NodeRegistry({
    resolveCurrentPairingState: async (nodeId) => {
      const state = resolveNodePairingState(await getPairedDevice(nodeId, baseDir));
      return state
        ? {
            identity: state.identity.key,
            ...(state.generation ? { generation: state.generation.key } : {}),
          }
        : undefined;
    },
  });
  const broadcasts: Array<{ event: string; payload: unknown }> = [];
  const connectedNodes: string[] = [];
  const disconnectedNodes: Array<{ nodeId: string; reason: string }> = [];
  const runtime = createWatchNodeHttpRuntime({
    nodeRegistry,
    getConfig: () => options?.config ?? {},
    pairingBaseDir: baseDir,
    broadcast: (event, payload) => broadcasts.push({ event, payload }),
    onNodeConnected: (session) => connectedNodes.push(session.nodeId),
    onNodeDisconnected: (nodeId, reason) => disconnectedNodes.push({ nodeId, reason }),
    ...(options?.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
    ...(options?.now ? { now: options.now } : {}),
  });
  let resolveConnectHandled: () => void = () => undefined;
  const connectHandled = new Promise<void>((resolve) => {
    resolveConnectHandled = resolve;
  });
  const server = createServer((req, res) => {
    const isConnect = req.url === "/api/nodes/watch/connect";
    if (isConnect && options?.onConnectResponseStart) {
      const end = res.end.bind(res);
      res.end = ((...args: Parameters<typeof res.end>) => {
        options.onConnectResponseStart?.();
        return end(...args);
      }) as typeof res.end;
    }
    if (isConnect && options?.abortConnectResponse) {
      res.end = (() => {
        res.destroy();
        return res;
      }) as typeof res.end;
    }
    void runtime
      .handleRequest(req, res)
      .then((handled) => {
        if (!handled && !res.writableEnded) {
          res.statusCode = 404;
          res.end();
        }
        if (req.url === "/api/nodes/watch/poll" && !res.writableEnded) {
          options?.onPollReady?.(res);
        }
      })
      .finally(() => {
        if (isConnect) {
          resolveConnectHandled();
        }
      });
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP server address");
  }
  return {
    nodeRegistry,
    broadcasts,
    connectedNodes,
    disconnectedNodes,
    runtime,
    connectHandled,
    baseUrl: `http://127.0.0.1:${address.port}/api/nodes/watch`,
  };
}
