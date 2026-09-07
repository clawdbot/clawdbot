// Plugin HTTP routing tests cover route matching, gateway auth decisions, and upgrade dispatch.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { makeMockHttpResponse } from "../test-http-response.js";
import { createGatewayTestRegistry } from "./__tests__/test-utils.js";
import {
  createGatewayPluginUpgradeHandler,
  createGatewayPluginRequestHandler,
  isPluginAuthenticatedRoutePath,
  isRegisteredPluginHttpRoutePath,
  shouldEnforceGatewayAuthForPluginPath,
} from "./plugins-http.js";

type PluginHandlerLog = Parameters<typeof createGatewayPluginRequestHandler>[0]["log"];

const CANVAS_WS_PATH = "/__openclaw__/canvas/ws";

function createPluginLog(): PluginHandlerLog {
  return { warn: vi.fn() } as unknown as PluginHandlerLog;
}

function createRoute(params: {
  path: string;
  pluginId?: string;
  auth?: "gateway" | "plugin";
  match?: "exact" | "prefix";
  handler?: (req: IncomingMessage, res: ServerResponse) => boolean | void | Promise<boolean | void>;
  handleUpgrade?: (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => boolean | void | Promise<boolean | void>;
}) {
  return {
    pluginId: params.pluginId ?? "route",
    path: params.path,
    auth: params.auth ?? "plugin",
    match: params.match ?? "exact",
    handler: params.handler ?? (() => {}),
    handleUpgrade: params.handleUpgrade,
    source: params.pluginId ?? "route",
  };
}

function createMockUpgradeSocket() {
  const socket = {
    chunks: [] as string[],
    destroyed: false,
    write(chunk: string) {
      socket.chunks.push(chunk);
    },
    end(chunk: string, callback: () => void) {
      socket.write(chunk);
      callback();
    },
    destroy() {
      socket.destroyed = true;
    },
  } as unknown as Duplex & { chunks: string[]; destroyed: boolean };
  return socket;
}

function buildRepeatedEncodedSlash(depth: number): string {
  let encodedSlash = "%2f";
  for (let i = 1; i < depth; i++) {
    encodedSlash = encodedSlash.replace(/%/g, "%25");
  }
  return encodedSlash;
}

function createSecurePluginRouteHandler(params: {
  exactPluginHandler: () => boolean | Promise<boolean>;
  prefixGatewayHandler: () => boolean | Promise<boolean>;
}) {
  return createGatewayPluginRequestHandler({
    registry: createGatewayTestRegistry({
      httpRoutes: [
        createRoute({
          path: "/plugin/secure/report",
          match: "exact",
          auth: "plugin",
          handler: params.exactPluginHandler,
        }),
        createRoute({
          path: "/plugin/secure",
          match: "prefix",
          auth: "gateway",
          handler: params.prefixGatewayHandler,
        }),
      ],
    }),
    log: createPluginLog(),
  });
}

async function invokeSecureGatewayRoute(params: {
  gatewayAuthSatisfied: boolean;
  gatewayRequestOperatorScopes?: readonly string[];
}) {
  const exactPluginHandler = vi.fn(async () => false);
  const prefixGatewayHandler = vi.fn(async () => true);
  const handler = createSecurePluginRouteHandler({
    exactPluginHandler,
    prefixGatewayHandler,
  });
  const { res } = makeMockHttpResponse();
  const handled = await handler(
    { url: "/plugin/secure/report" } as IncomingMessage,
    res,
    undefined,
    {
      gatewayAuthSatisfied: params.gatewayAuthSatisfied,
      gatewayRequestOperatorScopes: params.gatewayRequestOperatorScopes,
    },
  );
  return { handled, exactPluginHandler, prefixGatewayHandler };
}

async function invokeRouteAndCollectRuntimeScopes(params: {
  path: string;
  auth: "gateway" | "plugin";
  gatewayAuthSatisfied: boolean;
  gatewayRequestOperatorScopes?: readonly string[];
}) {
  let observedScopes: string[] | undefined;
  const handler = createGatewayPluginRequestHandler({
    registry: createGatewayTestRegistry({
      httpRoutes: [
        createRoute({
          path: params.path,
          auth: params.auth,
          handler: async () => {
            observedScopes =
              getPluginRuntimeGatewayRequestScope()?.client?.connect?.scopes?.slice() ?? [];
            return true;
          },
        }),
      ],
    }),
    log: createPluginLog(),
  });

  const response = makeMockHttpResponse();
  const handled = await handler({ url: params.path } as IncomingMessage, response.res, undefined, {
    gatewayAuthSatisfied: params.gatewayAuthSatisfied,
    gatewayRequestOperatorScopes: params.gatewayRequestOperatorScopes,
  });
  return { handled, observedScopes, ...response };
}

async function invokeCanvasGatewayUpgrade(params: { gatewayAuthSatisfied: boolean }) {
  const routeUpgradeHandler = vi.fn(async () => true);
  const handler = createGatewayPluginUpgradeHandler({
    registry: createGatewayTestRegistry({
      httpRoutes: [
        createRoute({
          path: CANVAS_WS_PATH,
          auth: "gateway",
          handleUpgrade: routeUpgradeHandler,
        }),
      ],
    }),
    log: createPluginLog(),
  });
  const socket = createMockUpgradeSocket();
  const handled = await handler(
    { url: CANVAS_WS_PATH } as IncomingMessage,
    socket,
    Buffer.alloc(0),
    undefined,
    {
      gatewayAuthSatisfied: params.gatewayAuthSatisfied,
      ...(params.gatewayAuthSatisfied ? { gatewayRequestOperatorScopes: ["operator.read"] } : {}),
    },
  );
  return { handled, routeUpgradeHandler, socket };
}

describe("createGatewayPluginRequestHandler", () => {
  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("keeps unauthenticated plugin routes off operator runtime scopes", async () => {
    const { handled, observedScopes, res } = await invokeRouteAndCollectRuntimeScopes({
      path: "/hook",
      auth: "plugin",
      gatewayAuthSatisfied: false,
    });

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(observedScopes).toStrictEqual([]);
  });

  it("preserves gateway-authenticated plugin route runtime scopes from request auth", async () => {
    const { handled, observedScopes, res } = await invokeRouteAndCollectRuntimeScopes({
      path: "/secure-hook",
      auth: "gateway",
      gatewayAuthSatisfied: true,
      gatewayRequestOperatorScopes: ["operator.read"],
    });

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(observedScopes).toEqual(["operator.read"]);
  });

  it("returns false when no routes are registered", async () => {
    const log = createPluginLog();
    const handler = createGatewayPluginRequestHandler({
      registry: createGatewayTestRegistry(),
      log,
    });
    const { res } = makeMockHttpResponse();
    const handled = await handler({} as IncomingMessage, res);
    expect(handled).toBe(false);
  });

  it("handles exact route matches", async () => {
    const routeHandler = vi.fn(async (_req, res: ServerResponse) => {
      res.statusCode = 200;
    });
    const handler = createGatewayPluginRequestHandler({
      registry: createGatewayTestRegistry({
        httpRoutes: [createRoute({ path: "/demo", handler: routeHandler })],
      }),
      log: createPluginLog(),
    });

    const { res } = makeMockHttpResponse();
    const handled = await handler({ url: "/demo" } as IncomingMessage, res);
    expect(handled).toBe(true);
    expect(routeHandler).toHaveBeenCalledTimes(1);
  });

  it("prefers exact matches before prefix matches", async () => {
    const exactHandler = vi.fn(async (_req, res: ServerResponse) => {
      res.statusCode = 200;
    });
    const prefixHandler = vi.fn(async () => true);
    const handler = createGatewayPluginRequestHandler({
      registry: createGatewayTestRegistry({
        httpRoutes: [
          createRoute({ path: "/api", match: "prefix", handler: prefixHandler }),
          createRoute({ path: "/api/demo", match: "exact", handler: exactHandler }),
        ],
      }),
      log: createPluginLog(),
    });

    const { res } = makeMockHttpResponse();
    const handled = await handler({ url: "/api/demo" } as IncomingMessage, res);
    expect(handled).toBe(true);
    expect(exactHandler).toHaveBeenCalledTimes(1);
    expect(prefixHandler).not.toHaveBeenCalled();
  });

  it("supports route fallthrough when handler returns false", async () => {
    const first = vi.fn(async () => false);
    const second = vi.fn(async () => true);
    const handler = createGatewayPluginRequestHandler({
      registry: createGatewayTestRegistry({
        httpRoutes: [
          createRoute({ path: "/hook", match: "exact", handler: first }),
          createRoute({ path: "/hook", match: "prefix", handler: second }),
        ],
      }),
      log: createPluginLog(),
    });

    const { res } = makeMockHttpResponse();
    const handled = await handler({ url: "/hook" } as IncomingMessage, res);
    expect(handled).toBe(true);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a matched gateway route reaches dispatch without auth", async () => {
    const { handled, exactPluginHandler, prefixGatewayHandler } = await invokeSecureGatewayRoute({
      gatewayAuthSatisfied: false,
    });
    expect(handled).toBe(false);
    expect(exactPluginHandler).not.toHaveBeenCalled();
    expect(prefixGatewayHandler).not.toHaveBeenCalled();
  });

  it("keeps hosted-media bearer query strings out of route-auth logs", async () => {
    const warn = vi.fn();
    const log = { warn } as unknown as PluginHandlerLog;
    const handler = createGatewayPluginRequestHandler({
      registry: createGatewayTestRegistry({
        httpRoutes: [createRoute({ path: "/webhooks/sms", auth: "gateway" })],
      }),
      log,
    });
    const tokenParam = `__openclaw_mms_token_${"a".repeat(24)}`;
    const { res } = makeMockHttpResponse();

    const handled = await handler(
      {
        url: `/webhooks/sms?upstream-token=proxy-secret&${tokenParam}=media-secret`,
      } as IncomingMessage,
      res,
      undefined,
      { gatewayAuthSatisfied: false },
    );

    expect(handled).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      "plugin http route blocked without gateway auth (/webhooks/sms)",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("proxy-secret");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("media-secret");
  });

  it("allows gateway route fallthrough only after gateway auth succeeds", async () => {
    const { handled, exactPluginHandler, prefixGatewayHandler } = await invokeSecureGatewayRoute({
      gatewayAuthSatisfied: true,
      gatewayRequestOperatorScopes: ["operator.write"],
    });
    expect(handled).toBe(true);
    expect(exactPluginHandler).toHaveBeenCalledTimes(1);
    expect(prefixGatewayHandler).toHaveBeenCalledTimes(1);
  });

  it("fails closed when gateway route dispatch lacks caller scopes", async () => {
    const { handled, exactPluginHandler, prefixGatewayHandler } = await invokeSecureGatewayRoute({
      gatewayAuthSatisfied: true,
    });
    expect(handled).toBe(false);
    expect(exactPluginHandler).not.toHaveBeenCalled();
    expect(prefixGatewayHandler).not.toHaveBeenCalled();
  });

  it("matches canonicalized route variants", async () => {
    const routeHandler = vi.fn(async (_req, res: ServerResponse) => {
      res.statusCode = 200;
    });
    const handler = createGatewayPluginRequestHandler({
      registry: createGatewayTestRegistry({
        httpRoutes: [createRoute({ path: "/api/demo", handler: routeHandler })],
      }),
      log: createPluginLog(),
    });

    const { res } = makeMockHttpResponse();
    const handled = await handler({ url: "/API//demo" } as IncomingMessage, res);
    expect(handled).toBe(true);
    expect(routeHandler).toHaveBeenCalledTimes(1);
  });

  it("uses the explicit registry when no route registry resolver is provided", async () => {
    const explicitRouteHandler = vi.fn(async (_req, res: ServerResponse) => {
      res.statusCode = 200;
      return true;
    });
    const explicitRegistry = createGatewayTestRegistry({
      httpRoutes: [createRoute({ path: "/demo", auth: "plugin", handler: explicitRouteHandler })],
    });

    const handler = createGatewayPluginRequestHandler({
      registry: explicitRegistry,
      log: createPluginLog(),
    });

    const { res } = makeMockHttpResponse();
    const handled = await handler({ url: "/demo" } as IncomingMessage, res);
    expect(handled).toBe(true);
    expect(explicitRouteHandler).toHaveBeenCalledTimes(1);
  });

  it("logs and responds with 500 when a route throws", async () => {
    const log = createPluginLog();
    const handler = createGatewayPluginRequestHandler({
      registry: createGatewayTestRegistry({
        httpRoutes: [
          createRoute({
            path: "/boom",
            handler: async () => {
              throw new Error("boom");
            },
          }),
        ],
      }),
      log,
    });

    const { res, setHeader, end } = makeMockHttpResponse();
    const handled = await handler({ url: "/boom" } as IncomingMessage, res);
    expect(handled).toBe(true);
    expect(log.warn).toHaveBeenCalledWith("plugin http route failed (route): Error: boom");
    expect(res.statusCode).toBe(500);
    expect(setHeader).toHaveBeenCalledWith("Content-Type", "text/plain; charset=utf-8");
    expect(end).toHaveBeenCalledWith("Internal Server Error");
  });

  it("aborts an incomplete unframed response when the plugin route throws", async () => {
    const log = createPluginLog();
    const handler = createGatewayPluginRequestHandler({
      registry: createGatewayTestRegistry({
        httpRoutes: [
          createRoute({
            path: "/partial",
            handler: async (_req, res) => {
              res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
              res.write("partial");
              throw new Error("boom");
            },
          }),
        ],
      }),
      log,
    });
    const server = createServer((req, res) => {
      void (async () => {
        const handled = await handler(req, res);
        if (!handled) {
          res.statusCode = 404;
          res.end("not found");
        }
      })();
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server did not bind to a TCP port");
    }
    try {
      await expect(
        fetch(`http://127.0.0.1:${address.port}/partial`, {
          signal: AbortSignal.timeout(1_000),
        }).then(async (response) => await response.text()),
      ).rejects.toMatchObject({ name: "TypeError" });
      expect(log.warn).toHaveBeenCalledWith("plugin http route failed (route): Error: boom");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it.each([
    {
      label: "setHeader",
      setContentLength: (res: ServerResponse) => res.setHeader("Content-Length", "10"),
    },
    {
      label: "writeHead",
      setContentLength: (res: ServerResponse) => res.writeHead(200, { "Content-Length": "10" }),
    },
  ])(
    "closes an incomplete plugin $label fixed-length response after its route throws",
    async ({ setContentLength }) => {
      const log = createPluginLog();
      const handler = createGatewayPluginRequestHandler({
        registry: createGatewayTestRegistry({
          httpRoutes: [
            createRoute({
              path: "/incomplete",
              handler: async (_req, res) => {
                setContentLength(res);
                res.write("partial");
                throw new Error("boom");
              },
            }),
          ],
        }),
        log,
      });
      const server = createServer((req, res) => {
        void handler(req, res);
      });

      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("server did not bind to a TCP port");
      }

      try {
        await expect(
          fetch(`http://127.0.0.1:${address.port}/incomplete`, {
            signal: AbortSignal.timeout(500),
          }).then(async (response) => await response.text()),
        ).rejects.toMatchObject({ name: "TypeError" });
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      }
    },
  );

  it("does not end a response the plugin already destroyed before throwing", async () => {
    const log = createPluginLog();
    const handler = createGatewayPluginRequestHandler({
      registry: createGatewayTestRegistry({
        httpRoutes: [
          createRoute({
            path: "/destroyed",
            handler: async (_req, res) => {
              Object.defineProperty(res, "headersSent", { value: true, configurable: true });
              res.destroy();
              throw new Error("boom");
            },
          }),
        ],
      }),
      log,
    });
    const { res, end } = makeMockHttpResponse();

    const handled = await handler({ url: "/destroyed" } as IncomingMessage, res);

    expect(handled).toBe(true);
    expect(res.destroyed).toBe(true);
    expect(end).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith("plugin http route failed (route): Error: boom");
  });
});

describe("createGatewayPluginUpgradeHandler", () => {
  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("claims and rejects matched gateway upgrades when auth was not satisfied", async () => {
    const { handled, routeUpgradeHandler, socket } = await invokeCanvasGatewayUpgrade({
      gatewayAuthSatisfied: false,
    });

    expect(handled).toBe(true);
    expect(routeUpgradeHandler).not.toHaveBeenCalled();
    expect(socket.destroyed).toBe(true);
    expect(socket.chunks.join("")).toContain("HTTP/1.1 401 Unauthorized");
  });

  it("dispatches gateway upgrades after gateway auth succeeds", async () => {
    const { handled, routeUpgradeHandler, socket } = await invokeCanvasGatewayUpgrade({
      gatewayAuthSatisfied: true,
    });

    expect(handled).toBe(true);
    expect(routeUpgradeHandler).toHaveBeenCalledTimes(1);
    expect(socket.destroyed).toBe(false);
    expect(socket.chunks).toStrictEqual([]);
  });
});

describe("plugin HTTP route auth checks", () => {
  const deeplyEncodedChannelPath =
    "/api%2525252fchannels%2525252fnostr%2525252fdefault%2525252fprofile";
  const decodeOverflowPublicPath = `/googlechat${buildRepeatedEncodedSlash(40)}public`;

  it("detects registered route paths", () => {
    const registry = createGatewayTestRegistry({
      httpRoutes: [createRoute({ path: "/demo" })],
    });
    expect(isRegisteredPluginHttpRoutePath(registry, "/demo")).toBe(true);
    expect(isRegisteredPluginHttpRoutePath(registry, "/missing")).toBe(false);
  });

  it("matches canonicalized variants of registered route paths", () => {
    const registry = createGatewayTestRegistry({
      httpRoutes: [createRoute({ path: "/api/demo" })],
    });
    expect(isRegisteredPluginHttpRoutePath(registry, "/api//demo")).toBe(true);
    expect(isRegisteredPluginHttpRoutePath(registry, "/API/demo")).toBe(true);
    expect(isRegisteredPluginHttpRoutePath(registry, "/api/%2564emo")).toBe(true);
  });

  it("enforces auth for protected and gateway-auth routes", () => {
    const registry = createGatewayTestRegistry({
      httpRoutes: [
        createRoute({ path: "/googlechat", match: "prefix", auth: "plugin" }),
        createRoute({ path: "/api/demo", auth: "gateway" }),
      ],
    });
    expect(shouldEnforceGatewayAuthForPluginPath(registry, "/api//demo")).toBe(true);
    expect(shouldEnforceGatewayAuthForPluginPath(registry, "/googlechat/public")).toBe(false);
    expect(shouldEnforceGatewayAuthForPluginPath(registry, "/api/channels/status")).toBe(true);
    expect(shouldEnforceGatewayAuthForPluginPath(registry, deeplyEncodedChannelPath)).toBe(true);
    expect(shouldEnforceGatewayAuthForPluginPath(registry, decodeOverflowPublicPath)).toBe(true);
    expect(shouldEnforceGatewayAuthForPluginPath(registry, "/not-plugin")).toBe(false);
  });

  it("enforces auth when any overlapping matched route requires gateway auth", () => {
    const registry = createGatewayTestRegistry({
      httpRoutes: [
        createRoute({ path: "/plugin/secure/report", match: "exact", auth: "plugin" }),
        createRoute({ path: "/plugin/secure", match: "prefix", auth: "gateway" }),
      ],
    });
    expect(shouldEnforceGatewayAuthForPluginPath(registry, "/plugin/secure/report")).toBe(true);
  });

  it("recognizes only existing, unambiguous plugin-authenticated routes", () => {
    const registry = createGatewayTestRegistry({
      httpRoutes: [
        createRoute({ path: "/googlechat", match: "prefix", auth: "plugin" }),
        createRoute({ path: "/plugin/secure", match: "prefix", auth: "gateway" }),
        createRoute({ path: "/plugin/secure/report", auth: "plugin" }),
      ],
    });

    expect(isPluginAuthenticatedRoutePath(registry, "/googlechat")).toBe(true);
    expect(isPluginAuthenticatedRoutePath(registry, "/googlechat/events")).toBe(true);
    expect(isPluginAuthenticatedRoutePath(registry, "/missing")).toBe(false);
    expect(isPluginAuthenticatedRoutePath(registry, "/api/channels/status")).toBe(false);
    expect(isPluginAuthenticatedRoutePath(registry, "/plugin/secure/report")).toBe(false);
    expect(isPluginAuthenticatedRoutePath(registry, decodeOverflowPublicPath)).toBe(false);
  });
});
