import { execFileSync } from "node:child_process";
import { request, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { describe, expect, test } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { withTimeout } from "../utils/with-timeout.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { NodeRegistry } from "./node-registry.js";
import { PLUGIN_NODE_CAPABILITY_PATH_PREFIX } from "./plugin-node-capability.js";
import { MAX_PREAUTH_PAYLOAD_BYTES } from "./server-constants.js";
import { attachGatewayUpgradeHandler, createGatewayHttpServer } from "./server-http.js";
import { createPreauthConnectionBudget } from "./server/preauth-connection-budget.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { withTempConfig } from "./test-temp-config.js";

const HTTP_TIMEOUT_MS = 15_000;
const WS_TIMEOUT_MS = 5_000;
const CLOSE_TIMEOUT_MS = 5_000;
const CANVAS_PATH = "/__openclaw__/canvas";
const CANVAS_WS_PATH = "/__openclaw__/test/ws";
const CAPABILITY_PATH_PREFIX = PLUGIN_NODE_CAPABILITY_PATH_PREFIX;
const resolvedAuth: ResolvedGatewayAuth = {
  mode: "token",
  token: "test-token",
  password: undefined,
  allowTailscale: false,
};

type DispatchCounts = { http: number; ws: number };
type BoundaryResult = { http: number; ws: number; dispatches: DispatchCounts };

function makeWsClient(params: {
  connId: string;
  clientIp: string;
  role: "node" | "operator";
  capability: string;
  caps?: string[];
}): GatewayWsClient {
  return {
    socket: {} as unknown as WebSocket,
    connect: {
      role: params.role,
      caps: params.caps ?? (params.role === "node" ? ["canvas"] : []),
      client: { id: params.connId, mode: params.role === "node" ? "node" : "webchat" },
      ...(params.role === "node" ? { declaredCaps: ["canvas"] } : {}),
    } as GatewayWsClient["connect"],
    connId: params.connId,
    usesSharedGatewayAuth: false,
    clientIp: params.clientIp,
    pluginNodeCapabilities: {
      canvas: { capability: params.capability, expiresAtMs: Date.now() + 60_000 },
    },
  };
}

function scopedPath(capability: string, path: string): string {
  return `${CAPABILITY_PATH_PREFIX}/${encodeURIComponent(capability)}${path}`;
}

async function fetchCanvas(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: { connection: "close" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function requestWsStatus(port: number, path: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path,
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
      },
    });
    req.setTimeout(WS_TIMEOUT_MS, () => req.destroy(new Error("timeout")));
    req.once("response", (res) => {
      res.resume();
      res.once("end", () => resolve(res.statusCode ?? 0));
    });
    req.once("upgrade", (_res, socket) => {
      socket.destroy();
      reject(new Error("expected capability rejection"));
    });
    req.once("error", reject);
    req.end();
  });
}

async function expectWsStatus(port: number, path: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("websocket connection timed out"));
    }, WS_TIMEOUT_MS);
    ws.once("open", () => {
      clearTimeout(timer);
      ws.terminate();
      resolve(101);
    });
    ws.once("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      reject(new Error(`unexpected response ${res.statusCode}`));
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function listen(server: ReturnType<typeof createGatewayHttpServer>) {
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        }),
        CLOSE_TIMEOUT_MS,
        { message: "proof gateway server close timed out" },
      );
    },
  };
}

async function runBoundaryProof(
  run: (
    port: number,
    clients: Set<GatewayWsClient>,
    getDispatches: () => DispatchCounts,
  ) => Promise<void>,
) {
  const clients = new Set<GatewayWsClient>();
  let httpDispatches = 0;
  let wsDispatches = 0;
  const canvasWss = new WebSocketServer({ noServer: true, maxPayload: MAX_PREAUTH_PAYLOAD_BYTES });
  const handleCanvasHttp = async (req: IncomingMessage, res: ServerResponse) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname !== CANVAS_PATH && !pathname.startsWith(`${CANVAS_PATH}/`)) {
      return false;
    }
    httpDispatches += 1;
    res.statusCode = 200;
    res.end("ok");
    return true;
  };
  const handleCanvasUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname !== CANVAS_WS_PATH) {
      return false;
    }
    wsDispatches += 1;
    canvasWss.handleUpgrade(req, socket, head, (ws) => ws.close());
    return true;
  };
  const httpServer = createGatewayHttpServer({
    clients,
    controlUiEnabled: false,
    controlUiBasePath: "/__control__",
    openAiChatCompletionsEnabled: false,
    openResponsesEnabled: false,
    handleHooksRequest: async () => false,
    handlePluginRequest: async (req, res) => handleCanvasHttp(req, res),
    resolvePluginNodeCapabilityRoute: () => ({ surface: "canvas" }),
    resolvedAuth,
  });
  const gatewayWss = new WebSocketServer({ noServer: true, maxPayload: MAX_PREAUTH_PAYLOAD_BYTES });
  attachGatewayUpgradeHandler({
    httpServer,
    wss: gatewayWss,
    handlePluginUpgrade: async (req, socket, head) => handleCanvasUpgrade(req, socket, head),
    resolvePluginNodeCapabilityRoute: () => ({ surface: "canvas" }),
    clients,
    preauthConnectionBudget: createPreauthConnectionBudget(8),
    resolvedAuth,
  });
  const listener = await listen(httpServer);
  try {
    await run(listener.port, clients, () => ({ http: httpDispatches, ws: wsDispatches }));
  } finally {
    for (const ws of canvasWss.clients) {
      ws.terminate();
    }
    for (const ws of gatewayWss.clients) {
      ws.terminate();
    }
    await withTimeout(
      new Promise<void>((resolve) => {
        canvasWss.close(() => resolve());
      }),
      CLOSE_TIMEOUT_MS,
      { message: "proof canvas websocket server close timed out" },
    );
    await withTimeout(
      new Promise<void>((resolve) => {
        gatewayWss.close(() => resolve());
      }),
      CLOSE_TIMEOUT_MS,
      { message: "proof gateway websocket server close timed out" },
    );
    await listener.close();
  }
}

describe("gateway plugin node capability boundary proof", () => {
  test("rejects pending and revoked nodes before HTTP/WS dispatch while allowing operators", async () => {
    await withTempConfig({
      cfg: { gateway: { trustedProxies: ["127.0.0.1"] } },
      run: async () => {
        const proof: Record<string, BoundaryResult> = {};
        await runBoundaryProof(async (port, clients, dispatches) => {
          const probeHttp = async (capability: string) =>
            await fetchCanvas(
              `http://127.0.0.1:${port}${scopedPath(capability, `${CANVAS_PATH}/`)}`,
            );
          const pendingCapability = "pending-node";
          const pendingNode = makeWsClient({
            connId: "c-pending-node",
            clientIp: "192.168.1.10",
            role: "node",
            capability: pendingCapability,
            caps: [],
          });
          const nodeRegistry = new NodeRegistry();
          try {
            nodeRegistry.register(pendingNode, { pairingIdentity: "pending-node" });
            clients.add(pendingNode);
            const pendingHttp = await probeHttp(pendingCapability);
            const pendingWs = await requestWsStatus(
              port,
              scopedPath(pendingCapability, CANVAS_WS_PATH),
            );
            expect(pendingHttp.status).toBe(401);
            expect(pendingWs).toBe(401);
            expect(dispatches()).toEqual({ http: 0, ws: 0 });
            proof.pending = { http: pendingHttp.status, ws: pendingWs, dispatches: dispatches() };

            const approved = nodeRegistry.updateSurface("c-pending-node", {
              caps: ["canvas"],
              commands: [],
            });
            expect(approved?.caps).toEqual(["canvas"]);
            const approvedHttp = await probeHttp(pendingCapability);
            const approvedWs = await expectWsStatus(
              port,
              scopedPath(pendingCapability, CANVAS_WS_PATH),
            );
            expect(approvedHttp.status).toBe(200);
            expect(approvedWs).toBe(101);
            expect(dispatches()).toEqual({ http: 1, ws: 1 });
            proof.approved = {
              http: approvedHttp.status,
              ws: approvedWs,
              dispatches: dispatches(),
            };

            const revoked = nodeRegistry.updateSurface("c-pending-node", {
              caps: [],
              commands: [],
            });
            expect(revoked?.caps).toEqual([]);
            const revokedHttp = await probeHttp(pendingCapability);
            const revokedWs = await requestWsStatus(
              port,
              scopedPath(pendingCapability, CANVAS_WS_PATH),
            );
            expect(revokedHttp.status).toBe(401);
            expect(revokedWs).toBe(401);
            expect(dispatches()).toEqual({ http: 1, ws: 1 });
            proof.revoked = { http: revokedHttp.status, ws: revokedWs, dispatches: dispatches() };
          } finally {
            clients.delete(pendingNode);
            nodeRegistry.unregister(pendingNode.connId);
          }

          const operatorCapability = "operator-cap";
          clients.add(
            makeWsClient({
              connId: "c-operator",
              clientIp: "192.168.1.15",
              role: "operator",
              capability: operatorCapability,
            }),
          );
          const operatorHttp = await probeHttp(operatorCapability);
          const operatorWs = await expectWsStatus(
            port,
            scopedPath(operatorCapability, CANVAS_WS_PATH),
          );
          expect(operatorHttp.status).toBe(200);
          expect(operatorWs).toBe(101);
          expect(dispatches()).toEqual({ http: 2, ws: 2 });
          proof.operator = { http: operatorHttp.status, ws: operatorWs, dispatches: dispatches() };
        });
        const testedCheckoutHead = execFileSync("git", ["rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim();
        const mergeParents = execFileSync("git", ["cat-file", "-p", testedCheckoutHead], {
          encoding: "utf8",
        })
          .match(/^parent ([a-f0-9]{40})$/gmu)
          ?.map((line) => line.slice("parent ".length));
        const reviewedHead =
          process.env.RATCHET_PR_HEAD_SHA?.trim() || mergeParents?.[1] || testedCheckoutHead;
        expect(reviewedHead).toMatch(/^[a-f0-9]{40}$/u);
        if (mergeParents?.length === 2) {
          expect(mergeParents?.[1]).toBe(reviewedHead);
        }
        process.stdout.write(
          `plugin-node-capability-proof ${JSON.stringify(
            {
              reviewedHead,
              testedCheckoutHead,
              boundary: "Gateway Canvas plugin route authorization before HTTP/WS dispatch",
              ...proof,
            },
            null,
            2,
          )}\n`,
        );
      },
    });
  }, 60_000);
});
