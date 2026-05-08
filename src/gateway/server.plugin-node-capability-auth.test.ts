import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { describe, expect, test } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { createAuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { PLUGIN_NODE_CAPABILITY_PATH_PREFIX } from "./plugin-node-capability.js";
import { attachGatewayUpgradeHandler, createGatewayHttpServer } from "./server-http.js";
import { createPreauthConnectionBudget } from "./server/preauth-connection-budget.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { withTempConfig } from "./test-temp-config.js";

const WS_REJECT_TIMEOUT_MS = 2_000;
const WS_CONNECT_TIMEOUT_MS = 5_000;
const HTTP_REQUEST_TIMEOUT_MS = 15_000;
const SERVER_CLOSE_TIMEOUT_MS = 5_000;
const A2UI_PATH = "/__openclaw__/a2ui";
const CANVAS_HOST_PATH = "/__openclaw__/canvas";
const CANVAS_WS_PATH = "/__openclaw__/ws";
const CANVAS_CAPABILITY_PATH_PREFIX = PLUGIN_NODE_CAPABILITY_PATH_PREFIX;

type CanvasHostHandler = {
  rootDir: string;
  basePath: string;
  handleHttpRequest: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
  close: () => Promise<void>;
};

async function fetchCanvas(input: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("connection", "close");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_REQUEST_TIMEOUT_MS);
    try {
      return await fetch(input, {
        ...init,
        headers,
        signal: controller.signal,
      });
    } catch (error) {
      if (attempt === 1) {
        throw error;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("unreachable");
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function listen(
  server: ReturnType<typeof createGatewayHttpServer>,
  host = "127.0.0.1",
): Promise<{
  host: string;
  port: number;
  close: () => Promise<void>;
}> {
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    host,
    port,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await withTimeout(
        new Promise<void>((resolve, reject) =>
          server.close((err) => (err ? reject(err) : resolve())),
        ),
        SERVER_CLOSE_TIMEOUT_MS,
        "gateway test server close",
      );
    },
  };
}

async function expectWsRejected(
  url: string,
  headers: Record<string, string>,
  expectedStatus = 401,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const timer = setTimeout(() => reject(new Error("timeout")), WS_REJECT_TIMEOUT_MS);
    ws.once("open", () => {
      clearTimeout(timer);
      ws.terminate();
      reject(new Error("expected ws to reject"));
    });
    ws.once("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      expect(res.statusCode).toBe(expectedStatus);
      resolve();
    });
    ws.once("error", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function expectWsConnected(url: string, headers?: Record<string, string>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url, headers ? { headers } : undefined);
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(
      () =>
        finish(() => {
          ws.terminate();
          reject(new Error("timeout"));
        }),
      WS_CONNECT_TIMEOUT_MS,
    );
    ws.once("open", () => {
      finish(() => {
        ws.terminate();
        resolve();
      });
    });
    ws.once("unexpected-response", (_req, res) => {
      finish(() => reject(new Error(`unexpected response ${res.statusCode}`)));
    });
    ws.once("close", (code, reason) => {
      finish(() =>
        reject(
          new Error(
            `socket closed before open (${code}${reason.length > 0 ? `: ${reason.toString()}` : ""})`,
          ),
        ),
      );
    });
    ws.once("error", (err) => {
      finish(() => reject(err));
    });
  });
}

function makeWsClient(params: {
  connId: string;
  clientIp: string;
  role: "node" | "operator";
  mode: "node" | "backend" | "webchat";
  capability?: string;
  capabilityExpiresAtMs?: number;
}): GatewayWsClient {
  const pluginNodeCapabilities =
    params.capability && params.capabilityExpiresAtMs !== undefined
      ? { canvas: { capability: params.capability, expiresAtMs: params.capabilityExpiresAtMs } }
      : undefined;
  return {
    socket: {} as unknown as WebSocket,
    connect: {
      role: params.role,
      client: {
        mode: params.mode,
      },
    } as GatewayWsClient["connect"],
    connId: params.connId,
    usesSharedGatewayAuth: false,
    clientIp: params.clientIp,
    ...(pluginNodeCapabilities ? { pluginNodeCapabilities } : {}),
  };
}

function scopedCanvasPath(capability: string, path: string): string {
  return `${CANVAS_CAPABILITY_PATH_PREFIX}/${encodeURIComponent(capability)}${path}`;
}

const allowCanvasHostHttp: CanvasHostHandler["handleHttpRequest"] = async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== CANVAS_HOST_PATH && !url.pathname.startsWith(`${CANVAS_HOST_PATH}/`)) {
    return false;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end("ok");
  return true;
};
async function withCanvasGatewayHarness(params: {
  resolvedAuth: ResolvedGatewayAuth;
  getResolvedAuth?: () => ResolvedGatewayAuth;
  listenHost?: string;
  rateLimiter?: ReturnType<typeof createAuthRateLimiter>;
  handleHttpRequest: CanvasHostHandler["handleHttpRequest"];
  run: (ctx: {
    listener: Awaited<ReturnType<typeof listen>>;
    clients: Set<GatewayWsClient>;
  }) => Promise<void>;
}) {
  const clients = new Set<GatewayWsClient>();
  const canvasWss = new WebSocketServer({ noServer: true });
  const canvasHandler: CanvasHostHandler = {
    rootDir: "test",
    basePath: "/canvas",
    close: async () => {},
    handleUpgrade: (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== CANVAS_WS_PATH) {
        return false;
      }
      canvasWss.handleUpgrade(req, socket, head, (ws) => {
        // Let the client observe a successful open before the harness closes.
        setImmediate(() => ws.close());
      });
      return true;
    },
    handleHttpRequest: params.handleHttpRequest,
  };

  const httpServer = createGatewayHttpServer({
    clients,
    controlUiEnabled: false,
    controlUiBasePath: "/__control__",
    openAiChatCompletionsEnabled: false,
    openResponsesEnabled: false,
    handleHooksRequest: async () => false,
    handlePluginRequest: async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === A2UI_PATH || url.pathname.startsWith(`${A2UI_PATH}/`)) {
        res.statusCode = 503;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("A2UI assets not found");
        return true;
      }
      return canvasHandler.handleHttpRequest(req, res);
    },
    resolvePluginNodeCapabilityRoute: () => ({ surface: "canvas" }),
    resolvedAuth: params.resolvedAuth,
    getResolvedAuth: params.getResolvedAuth,
    rateLimiter: params.rateLimiter,
  });

  const wss = new WebSocketServer({ noServer: true });
  attachGatewayUpgradeHandler({
    httpServer,
    wss,
    handlePluginUpgrade: async (req, socket, head) =>
      canvasHandler.handleUpgrade(req, socket, head),
    resolvePluginNodeCapabilityRoute: () => ({ surface: "canvas" }),
    clients,
    preauthConnectionBudget: createPreauthConnectionBudget(8),
    resolvedAuth: params.resolvedAuth,
    getResolvedAuth: params.getResolvedAuth,
    rateLimiter: params.rateLimiter,
  });

  const listener = await listen(httpServer, params.listenHost);
  try {
    await params.run({ listener, clients });
  } finally {
    for (const ws of canvasWss.clients) {
      ws.terminate();
    }
    for (const ws of wss.clients) {
      ws.terminate();
    }
    await new Promise<void>((resolve) => canvasWss.close(() => resolve()));
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await listener.close();
    params.rateLimiter?.dispose();
  }
}

describe("gateway plugin node capability auth", () => {
  const tokenResolvedAuth: ResolvedGatewayAuth = {
    mode: "token",
    token: "test-token",
    password: undefined,
    allowTailscale: false,
  };

  const withLoopbackTrustedProxy = async (run: () => Promise<void>, prefix?: string) => {
    await withTempConfig({
      cfg: {
        gateway: {
          trustedProxies: ["127.0.0.1"],
        },
      },
      ...(prefix ? { prefix } : {}),
      run,
    });
  };

  test("authorizes canvas HTTP/WS via node-scoped capability and rejects misuse", async () => {
    await withLoopbackTrustedProxy(async () => {
      await withCanvasGatewayHarness({
        resolvedAuth: tokenResolvedAuth,
        handleHttpRequest: allowCanvasHostHttp,
        run: async ({ listener, clients }) => {
          const host = "127.0.0.1";
          const webchatCapability = "webchat-cap";
          const expiredNodeCapability = "expired-node";
          const activeNodeCapability = "active-node";
          const activeCanvasPath = scopedCanvasPath(activeNodeCapability, `${CANVAS_HOST_PATH}/`);
          const activeWsPath = scopedCanvasPath(activeNodeCapability, CANVAS_WS_PATH);

          const unauthCanvas = await fetchCanvas(
            `http://${host}:${listener.port}${CANVAS_HOST_PATH}/`,
          );
          expect(unauthCanvas.status).toBe(401);

          const malformedScoped = await fetchCanvas(
            `http://${host}:${listener.port}${CANVAS_CAPABILITY_PATH_PREFIX}/broken`,
          );
          expect(malformedScoped.status).toBe(401);

          clients.add(
            makeWsClient({
              connId: "c-webchat",
              clientIp: "192.168.1.10",
              role: "operator",
              mode: "webchat",
              capability: webchatCapability,
              capabilityExpiresAtMs: Date.now() + 60_000,
            }),
          );

          const webchatCapabilityAllowed = await fetchCanvas(
            `http://${host}:${listener.port}${scopedCanvasPath(webchatCapability, `${CANVAS_HOST_PATH}/`)}`,
          );
          expect(webchatCapabilityAllowed.status).toBe(200);

          clients.add(
            makeWsClient({
              connId: "c-expired-node",
              clientIp: "192.168.1.20",
              role: "node",
              mode: "node",
              capability: expiredNodeCapability,
              capabilityExpiresAtMs: Date.now() - 1,
            }),
          );

          const expiredCapabilityBlocked = await fetchCanvas(
            `http://${host}:${listener.port}${scopedCanvasPath(expiredNodeCapability, `${CANVAS_HOST_PATH}/`)}`,
          );
          expect(expiredCapabilityBlocked.status).toBe(401);

          const activeNodeClient = makeWsClient({
            connId: "c-active-node",
            clientIp: "192.168.1.30",
            role: "node",
            mode: "node",
            capability: activeNodeCapability,
            capabilityExpiresAtMs: Date.now() + 60_000,
          });
          clients.add(activeNodeClient);

          const scopedCanvas = await fetchCanvas(
            `http://${host}:${listener.port}${activeCanvasPath}`,
          );
          expect(scopedCanvas.status).toBe(200);
          expect(await scopedCanvas.text()).toBe("ok");

          const scopedA2ui = await fetchCanvas(
            `http://${host}:${listener.port}${scopedCanvasPath(activeNodeCapability, `${A2UI_PATH}/`)}`,
          );
          expect([200, 404, 503]).toContain(scopedA2ui.status);

          await expectWsConnected(`ws://${host}:${listener.port}${activeWsPath}`);

          clients.delete(activeNodeClient);

          const disconnectedNodeBlocked = await fetchCanvas(
            `http://${host}:${listener.port}${activeCanvasPath}`,
          );
          expect(disconnectedNodeBlocked.status).toBe(401);
          await expectWsRejected(`ws://${host}:${listener.port}${activeWsPath}`, {});
        },
      });
    }, "openclaw-canvas-auth-test-");
  }, 60_000);

  test("denies canvas auth when trusted proxy omits forwarded client headers", async () => {
    await withLoopbackTrustedProxy(async () => {
      await withCanvasGatewayHarness({
        resolvedAuth: tokenResolvedAuth,
        handleHttpRequest: allowCanvasHostHttp,
        run: async ({ listener, clients }) => {
          clients.add(
            makeWsClient({
              connId: "c-loopback-node",
              clientIp: "127.0.0.1",
              role: "node",
              mode: "node",
              capability: "unused",
              capabilityExpiresAtMs: Date.now() + 60_000,
            }),
          );

          const res = await fetchCanvas(`http://127.0.0.1:${listener.port}${CANVAS_HOST_PATH}/`);
          expect(res.status).toBe(401);

          await expectWsRejected(`ws://127.0.0.1:${listener.port}${CANVAS_WS_PATH}`, {});
        },
      });
    });
  }, 60_000);

  test("denies canvas HTTP/WS on loopback without bearer or capability by default", async () => {
    await withCanvasGatewayHarness({
      resolvedAuth: tokenResolvedAuth,
      handleHttpRequest: allowCanvasHostHttp,
      run: async ({ listener }) => {
        const res = await fetchCanvas(`http://127.0.0.1:${listener.port}${CANVAS_HOST_PATH}/`);
        expect(res.status).toBe(401);

        const a2ui = await fetchCanvas(`http://127.0.0.1:${listener.port}${A2UI_PATH}/`);
        expect(a2ui.status).toBe(401);

        await expectWsRejected(`ws://127.0.0.1:${listener.port}${CANVAS_WS_PATH}`, {});
      },
    });
  }, 60_000);

  test("re-resolves canvas bearer auth on each upgrade after shared auth rotation", async () => {
    let currentAuth = tokenResolvedAuth;

    await withCanvasGatewayHarness({
      resolvedAuth: tokenResolvedAuth,
      getResolvedAuth: () => currentAuth,
      handleHttpRequest: allowCanvasHostHttp,
      run: async ({ listener }) => {
        const url = `ws://127.0.0.1:${listener.port}${CANVAS_WS_PATH}`;

        await expectWsConnected(url, {
          authorization: "Bearer test-token",
        });

        currentAuth = {
          ...tokenResolvedAuth,
          token: "rotated-token",
        };

        await expectWsRejected(url, {
          authorization: "Bearer test-token",
        });
        await expectWsConnected(url, {
          authorization: "Bearer rotated-token",
        });
      },
    });
  }, 60_000);

  test("accepts capability-scoped paths over IPv6 loopback", async () => {
    await withTempConfig({
      cfg: {
        gateway: {
          trustedProxies: ["::1"],
        },
      },
      run: async () => {
        try {
          await withCanvasGatewayHarness({
            resolvedAuth: tokenResolvedAuth,
            listenHost: "::1",
            handleHttpRequest: allowCanvasHostHttp,
            run: async ({ listener, clients }) => {
              const capability = "ipv6-node";
              clients.add(
                makeWsClient({
                  connId: "c-ipv6-node",
                  clientIp: "fd12:3456:789a::2",
                  role: "node",
                  mode: "node",
                  capability,
                  capabilityExpiresAtMs: Date.now() + 60_000,
                }),
              );

              const canvasPath = scopedCanvasPath(capability, `${CANVAS_HOST_PATH}/`);
              const wsPath = scopedCanvasPath(capability, CANVAS_WS_PATH);
              const scopedCanvas = await fetchCanvas(`http://[::1]:${listener.port}${canvasPath}`);
              expect(scopedCanvas.status).toBe(200);

              await expectWsConnected(`ws://[::1]:${listener.port}${wsPath}`);
            },
          });
        } catch (err) {
          const message = String(err);
          if (message.includes("EAFNOSUPPORT") || message.includes("EADDRNOTAVAIL")) {
            return;
          }
          throw err;
        }
      },
    });
  }, 60_000);

  test("returns 429 for repeated failed canvas auth attempts (HTTP + WS upgrade)", async () => {
    await withLoopbackTrustedProxy(async () => {
      const rateLimiter = createAuthRateLimiter({
        maxAttempts: 1,
        windowMs: 60_000,
        lockoutMs: 60_000,
        exemptLoopback: false,
      });
      await withCanvasGatewayHarness({
        resolvedAuth: tokenResolvedAuth,
        rateLimiter,
        handleHttpRequest: async () => false,
        run: async ({ listener }) => {
          const headers = {
            authorization: "Bearer wrong",
            "x-forwarded-for": "203.0.113.99",
          };
          const first = await fetchCanvas(`http://127.0.0.1:${listener.port}${CANVAS_HOST_PATH}/`, {
            headers,
          });
          expect(first.status).toBe(401);

          const second = await fetchCanvas(
            `http://127.0.0.1:${listener.port}${CANVAS_HOST_PATH}/`,
            {
              headers,
            },
          );
          expect(second.status).toBe(429);
          expect(second.headers.get("retry-after")).toMatch(/^\d+$/);

          await expectWsRejected(`ws://127.0.0.1:${listener.port}${CANVAS_WS_PATH}`, headers, 429);
        },
      });
    });
  }, 60_000);

  test("rejects spoofed loopback forwarding headers from trusted proxies", async () => {
    await withTempConfig({
      cfg: {
        gateway: {
          trustedProxies: ["127.0.0.1"],
        },
      },
      run: async () => {
        const rateLimiter = createAuthRateLimiter({
          maxAttempts: 1,
          windowMs: 60_000,
          lockoutMs: 60_000,
          exemptLoopback: true,
        });
        await withCanvasGatewayHarness({
          resolvedAuth: tokenResolvedAuth,
          listenHost: "0.0.0.0",
          rateLimiter,
          handleHttpRequest: async () => false,
          run: async ({ listener }) => {
            const headers = {
              authorization: "Bearer wrong",
              host: "localhost",
              "x-forwarded-for": "127.0.0.1, 203.0.113.24",
            };
            const first = await fetchCanvas(
              `http://127.0.0.1:${listener.port}${CANVAS_HOST_PATH}/`,
              {
                headers,
              },
            );
            expect(first.status).toBe(401);

            const second = await fetchCanvas(
              `http://127.0.0.1:${listener.port}${CANVAS_HOST_PATH}/`,
              {
                headers,
              },
            );
            expect(second.status).toBe(429);
          },
        });
      },
    });
  }, 60_000);
});
