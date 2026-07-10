/**
 * Plugin HTTP runtime-scope integration tests.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubsystemLogger } from "../../logging/subsystem.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import {
  pinActivePluginHttpRouteRegistry,
  releasePinnedPluginHttpRouteRegistry,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { resolveControlPlaneRateLimitKey } from "../control-plane-rate-limit.js";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import type { AuthorizedGatewayHttpRequest } from "../http-utils.js";
import { authorizeOperatorScopesForMethod, CLI_DEFAULT_OPERATOR_SCOPES } from "../method-scopes.js";
import { isApprovalRecordVisibleToClient } from "../server-methods/approval-shared.js";
import type { GatewayRequestContext } from "../server-methods/types.js";
import { makeMockHttpResponse } from "../test-http-response.js";
import { createTestRegistry } from "./__tests__/test-utils.js";
import { createGatewayPluginRequestHandler } from "./plugins-http.js";

const SECURE_HOOK_PATH = "/secure-hook";
const SECURE_ADMIN_HOOK_PATH = "/secure-admin-hook";

type PluginHttpRoute = ReturnType<typeof createRoute>;
type PluginRequestHandler = ReturnType<typeof createGatewayPluginRequestHandler>;
type PluginRequestAuthContext = NonNullable<Parameters<PluginRequestHandler>[3]>;

function createRoute(params: {
  path: string;
  auth: "gateway" | "plugin";
  match?: "exact" | "prefix";
  gatewayRuntimeScopeSurface?: "write-default" | "trusted-operator";
  gatewayMethodDispatchAllowed?: boolean;
  handler?: (req: IncomingMessage, res: ServerResponse) => boolean | Promise<boolean>;
}) {
  return {
    pluginId: "route",
    path: params.path,
    auth: params.auth,
    gatewayRuntimeScopeSurface: params.gatewayRuntimeScopeSurface,
    gatewayMethodDispatchAllowed: params.gatewayMethodDispatchAllowed,
    match: params.match ?? "exact",
    handler: params.handler ?? (() => true),
    source: "route",
  };
}

function createMockLogger(): SubsystemLogger {
  const child = vi.fn<(name: string) => SubsystemLogger>();
  const logger = {
    subsystem: "test/plugins-http-runtime-scopes",
    isEnabled: () => true,
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child,
  } satisfies SubsystemLogger;
  child.mockImplementation(() => logger);
  return logger as SubsystemLogger;
}

function assertWriteHelperAllowed() {
  const scopes = getPluginRuntimeGatewayRequestScope()?.client?.connect?.scopes ?? [];
  const auth = authorizeOperatorScopesForMethod("agent", scopes);
  if (!auth.allowed) {
    throw new Error(`missing scope: ${auth.missingScope}`);
  }
}

function assertAdminHelperAllowed() {
  const scopes = getPluginRuntimeGatewayRequestScope()?.client?.connect?.scopes ?? [];
  const auth = authorizeOperatorScopesForMethod("set-heartbeats", scopes);
  if (!auth.allowed) {
    throw new Error(`missing scope: ${auth.missingScope}`);
  }
}

function createPluginRequestHandler(params: {
  routes: PluginHttpRoute[];
  log?: SubsystemLogger;
  getRouteRegistry?: () => ReturnType<typeof createTestRegistry>;
  getGatewayRequestContext?: () => GatewayRequestContext;
}) {
  return createGatewayPluginRequestHandler({
    registry: createTestRegistry({ httpRoutes: params.routes }),
    ...(params.getRouteRegistry ? { getRouteRegistry: params.getRouteRegistry } : {}),
    log: params.log ?? createMockLogger(),
    ...(params.getGatewayRequestContext
      ? { getGatewayRequestContext: params.getGatewayRequestContext }
      : {}),
  });
}

async function dispatchPluginRequest(
  handler: PluginRequestHandler,
  params: {
    path: string;
    authContext: PluginRequestAuthContext;
  },
) {
  const response = makeMockHttpResponse();
  const handled = await handler(
    { url: params.path } as IncomingMessage,
    response.res,
    undefined,
    params.authContext,
  );
  return { handled, ...response };
}

async function dispatchTrustedGatewayRequest(handler: PluginRequestHandler, path: string) {
  return await dispatchPluginRequest(handler, {
    path,
    authContext: {
      gatewayAuthSatisfied: true,
      gatewayRequestAuth: { authMethod: "token", trustDeclaredOperatorScopes: false },
      gatewayRequestOperatorScopes: ["operator.write"],
    },
  });
}

function expectMissingWriteScopeFailure(params: {
  res: ServerResponse;
  setHeader: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  log: SubsystemLogger;
}) {
  expect(params.res.statusCode).toBe(500);
  expect(params.setHeader).toHaveBeenCalledWith("Content-Type", "text/plain; charset=utf-8");
  expect(params.end).toHaveBeenCalledWith("Internal Server Error");
  expect(params.log.warn).toHaveBeenCalledWith(
    "plugin http route failed (route): Error: missing scope: operator.write",
  );
}

describe("plugin HTTP route runtime scopes", () => {
  afterEach(() => {
    releasePinnedPluginHttpRouteRegistry();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  async function invokeRoute(params: {
    path: string;
    auth: "gateway" | "plugin";
    gatewayRuntimeScopeSurface?: "write-default" | "trusted-operator";
    gatewayAuthSatisfied: boolean;
    gatewayRequestAuth?: AuthorizedGatewayHttpRequest;
    gatewayRequestOperatorScopes?: readonly string[];
  }) {
    const log = createMockLogger();
    const handler = createPluginRequestHandler({
      routes: [
        createRoute({
          path: params.path,
          auth: params.auth,
          gatewayRuntimeScopeSurface: params.gatewayRuntimeScopeSurface,
          handler: async () => {
            assertWriteHelperAllowed();
            return true;
          },
        }),
      ],
      log,
    });

    const response = await dispatchPluginRequest(handler, {
      path: params.path,
      authContext: {
        gatewayAuthSatisfied: params.gatewayAuthSatisfied,
        gatewayRequestAuth: params.gatewayRequestAuth,
        gatewayRequestOperatorScopes: params.gatewayRequestOperatorScopes,
      },
    });
    return { log, ...response };
  }

  it("keeps plugin-auth routes off write-capable runtime helpers", async () => {
    const { handled, res, setHeader, end, log } = await invokeRoute({
      path: "/hook",
      auth: "plugin",
      gatewayAuthSatisfied: false,
    });

    expect(handled).toBe(true);
    expectMissingWriteScopeFailure({ res, setHeader, end, log });
  });

  it("preserves write-capable runtime helpers on gateway-auth routes", async () => {
    const { handled, res, log } = await invokeRoute({
      path: "/secure-hook",
      auth: "gateway",
      gatewayAuthSatisfied: true,
      gatewayRequestOperatorScopes: ["operator.write"],
    });

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("threads plugin route identity and gateway dispatch entitlement into runtime scope", async () => {
    let observed:
      | {
          pluginId: string | undefined;
          pluginSource: string | undefined;
          gatewayMethodDispatchAllowed: boolean | undefined;
        }
      | undefined;
    const handler = createPluginRequestHandler({
      routes: [
        createRoute({
          path: SECURE_HOOK_PATH,
          auth: "gateway",
          gatewayMethodDispatchAllowed: true,
          handler: async () => {
            const scope = getPluginRuntimeGatewayRequestScope();
            observed = {
              pluginId: scope?.pluginId,
              pluginSource: scope?.pluginSource,
              gatewayMethodDispatchAllowed: scope?.gatewayMethodDispatchAllowed,
            };
            return true;
          },
        }),
      ],
    });

    const { handled, res } = await dispatchPluginRequest(handler, {
      path: SECURE_HOOK_PATH,
      authContext: {
        gatewayAuthSatisfied: true,
        gatewayRequestOperatorScopes: ["operator.write"],
      },
    });

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(observed).toEqual({
      pluginId: "route",
      pluginSource: "route",
      gatewayMethodDispatchAllowed: true,
    });
  });

  it("threads resolved HTTP client IP into the shared control-plane rate identity", async () => {
    const observed: Array<{ clientIp?: string; connId?: string; rateLimitKey: string }> = [];
    const handler = createPluginRequestHandler({
      routes: [
        createRoute({
          path: SECURE_HOOK_PATH,
          auth: "gateway",
          gatewayRuntimeScopeSurface: "trusted-operator",
          gatewayMethodDispatchAllowed: true,
          handler: async () => {
            const client = getPluginRuntimeGatewayRequestScope()?.client;
            observed.push({
              ...(client?.clientIp ? { clientIp: client.clientIp } : {}),
              ...(client?.connId ? { connId: client.connId } : {}),
              rateLimitKey: resolveControlPlaneRateLimitKey(client ?? null),
            });
            return true;
          },
        }),
      ],
    });

    for (const clientIp of ["203.0.113.10", "203.0.113.10", "203.0.113.11"]) {
      const { handled, res } = await dispatchPluginRequest(handler, {
        path: SECURE_HOOK_PATH,
        authContext: {
          gatewayAuthSatisfied: true,
          gatewayRequestAuth: { authMethod: "token", trustDeclaredOperatorScopes: false },
          gatewayRequestClientIp: clientIp,
        },
      });
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
    }

    expect(observed).toEqual([
      {
        clientIp: "203.0.113.10",
        connId: "plugin-http:203.0.113.10",
        rateLimitKey: "unknown-device|203.0.113.10",
      },
      {
        clientIp: "203.0.113.10",
        connId: "plugin-http:203.0.113.10",
        rateLimitKey: "unknown-device|203.0.113.10",
      },
      {
        clientIp: "203.0.113.11",
        connId: "plugin-http:203.0.113.11",
        rateLimitKey: "unknown-device|203.0.113.11",
      },
    ]);
  });

  it("uses server-local routes and gateway context when the active registry belongs to another gateway", async () => {
    const serverAContext = { label: "server-a" } as unknown as GatewayRequestContext;
    const serverBContext = { label: "server-b" } as unknown as GatewayRequestContext;
    const observed: Array<{ route: string; context?: GatewayRequestContext }> = [];
    const serverARegistry = createTestRegistry({
      httpRoutes: [
        createRoute({
          path: SECURE_HOOK_PATH,
          auth: "gateway",
          handler: async () => {
            const context = getPluginRuntimeGatewayRequestScope()?.context;
            observed.push({ route: "server-a", ...(context ? { context } : {}) });
            return true;
          },
        }),
      ],
    });
    const serverBRegistry = createTestRegistry({
      httpRoutes: [
        createRoute({
          path: SECURE_HOOK_PATH,
          auth: "gateway",
          handler: async () => {
            const context = getPluginRuntimeGatewayRequestScope()?.context;
            observed.push({ route: "server-b", ...(context ? { context } : {}) });
            return true;
          },
        }),
      ],
    });

    setActivePluginRegistry(serverBRegistry);
    pinActivePluginHttpRouteRegistry(serverBRegistry);

    const handlerA = createGatewayPluginRequestHandler({
      registry: serverARegistry,
      getRouteRegistry: () => serverARegistry,
      log: createMockLogger(),
      getGatewayRequestContext: () => serverAContext,
    });
    const handlerB = createGatewayPluginRequestHandler({
      registry: serverBRegistry,
      getRouteRegistry: () => serverBRegistry,
      log: createMockLogger(),
      getGatewayRequestContext: () => serverBContext,
    });

    const responseA = makeMockHttpResponse();
    const handledA = await handlerA(
      { url: SECURE_HOOK_PATH } as IncomingMessage,
      responseA.res,
      undefined,
      {
        gatewayAuthSatisfied: true,
        gatewayRequestOperatorScopes: ["operator.write"],
      },
    );
    const responseB = makeMockHttpResponse();
    const handledB = await handlerB(
      { url: SECURE_HOOK_PATH } as IncomingMessage,
      responseB.res,
      undefined,
      {
        gatewayAuthSatisfied: true,
        gatewayRequestOperatorScopes: ["operator.write"],
      },
    );

    expect(handledA).toBe(true);
    expect(handledB).toBe(true);
    expect(responseA.res.statusCode).toBe(200);
    expect(responseB.res.statusCode).toBe(200);
    expect(observed).toEqual([
      { route: "server-a", context: serverAContext },
      { route: "server-b", context: serverBContext },
    ]);
  });

  it("does not give approval-scoped gateway-auth routes global approval visibility", async () => {
    const manager = new ExecApprovalManager<{ command: string }>();
    const record = manager.create({ command: "echo ok" }, 60_000, "route-hidden-approval");
    record.requestedByDeviceId = "device-owner";
    record.requestedByConnId = "conn-owner";
    record.requestedByClientId = "client-owner";
    let observedApprovalRuntime: boolean | undefined;
    let observedVisibility: boolean | undefined;
    const handler = createPluginRequestHandler({
      routes: [
        createRoute({
          path: SECURE_HOOK_PATH,
          auth: "gateway",
          handler: async () => {
            const runtimeClient = getPluginRuntimeGatewayRequestScope()?.client;
            observedApprovalRuntime = runtimeClient?.internal?.approvalRuntime;
            observedVisibility = isApprovalRecordVisibleToClient({
              record,
              client: runtimeClient ?? null,
            });
            return true;
          },
        }),
      ],
    });

    const { handled, res } = await dispatchPluginRequest(handler, {
      path: SECURE_HOOK_PATH,
      authContext: {
        gatewayAuthSatisfied: true,
        gatewayRequestOperatorScopes: ["operator.approvals"],
      },
    });

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(observedApprovalRuntime).not.toBe(true);
    expect(observedVisibility).toBe(false);
  });

  it("fails closed when gateway-auth route runtime scopes are missing", async () => {
    const { handled, res, log } = await invokeRoute({
      path: "/secure-hook",
      auth: "gateway",
      gatewayAuthSatisfied: true,
    });

    expect(handled).toBe(false);
    expect(res.statusCode).toBe(200);
    expect(log.warn).toHaveBeenCalledWith(
      "plugin http route blocked without caller scope context (/secure-hook)",
    );
  });

  it("does not allow write helpers for read-scoped gateway-auth requests", async () => {
    const { handled, res, setHeader, end, log } = await invokeRoute({
      path: "/secure-hook",
      auth: "gateway",
      gatewayAuthSatisfied: true,
      gatewayRequestOperatorScopes: ["operator.read"],
    });

    expect(handled).toBe(true);
    expectMissingWriteScopeFailure({ res, setHeader, end, log });
  });

  it("restores trusted-operator defaults for routes opting into trusted surface", async () => {
    let observedScopes: string[] | undefined;
    const log = createMockLogger();
    const handler = createPluginRequestHandler({
      routes: [
        createRoute({
          path: SECURE_ADMIN_HOOK_PATH,
          auth: "gateway",
          gatewayRuntimeScopeSurface: "trusted-operator",
          handler: async () => {
            observedScopes =
              getPluginRuntimeGatewayRequestScope()?.client?.connect?.scopes?.slice() ?? [];
            assertAdminHelperAllowed();
            return true;
          },
        }),
      ],
      log,
    });

    const response = await dispatchTrustedGatewayRequest(handler, SECURE_ADMIN_HOOK_PATH);

    expect(response.handled).toBe(true);
    expect(response.res.statusCode).toBe(200);
    expect(log.warn).not.toHaveBeenCalled();
    expect(observedScopes).toEqual(CLI_DEFAULT_OPERATOR_SCOPES);
  });

  it("scopes runtime privileges per matched route for exact/prefix overlap", async () => {
    const observed: Array<{ route: "exact" | "prefix"; scopes: string[] }> = [];
    const log = createMockLogger();
    const handler = createGatewayPluginRequestHandler({
      registry: createTestRegistry({
        httpRoutes: [
          createRoute({
            path: "/secure/admin-hook",
            auth: "gateway",
            match: "exact",
            handler: async () => {
              observed.push({
                route: "exact",
                scopes:
                  getPluginRuntimeGatewayRequestScope()?.client?.connect?.scopes?.slice() ?? [],
              });
              return false;
            },
          }),
          createRoute({
            path: "/secure",
            auth: "gateway",
            match: "prefix",
            gatewayRuntimeScopeSurface: "trusted-operator",
            handler: async () => {
              observed.push({
                route: "prefix",
                scopes:
                  getPluginRuntimeGatewayRequestScope()?.client?.connect?.scopes?.slice() ?? [],
              });
              assertAdminHelperAllowed();
              return true;
            },
          }),
        ],
      }),
      log,
    });

    const response = await dispatchTrustedGatewayRequest(handler, "/secure/admin-hook");

    expect(response.handled).toBe(true);
    expect(response.res.statusCode).toBe(200);
    expect(log.warn).not.toHaveBeenCalled();
    expect(observed).toHaveLength(2);
    expect(observed[0]).toEqual({
      route: "exact",
      scopes: ["operator.write"],
    });
    expect(observed[1]?.route).toBe("prefix");
    expect(observed[1]?.scopes).toEqual(CLI_DEFAULT_OPERATOR_SCOPES);
  });

  it.each([
    {
      auth: "plugin" as const,
      gatewayAuthSatisfied: false,
      path: "/hook",
      gatewayRequestOperatorScopes: undefined,
      expectedScopes: [],
    },
    {
      auth: "gateway" as const,
      gatewayAuthSatisfied: true,
      path: "/secure-hook",
      gatewayRequestOperatorScopes: ["operator.read"],
      expectedScopes: ["operator.read"],
    },
  ])(
    "maps $auth routes to $expectedScopes",
    async ({ auth, gatewayAuthSatisfied, gatewayRequestOperatorScopes, path, expectedScopes }) => {
      let observedScopes: string[] | undefined;
      const handler = createGatewayPluginRequestHandler({
        registry: createTestRegistry({
          httpRoutes: [
            createRoute({
              path,
              auth,
              handler: vi.fn(async () => {
                observedScopes =
                  getPluginRuntimeGatewayRequestScope()?.client?.connect?.scopes?.slice() ?? [];
                return true;
              }),
            }),
          ],
        }),
        log: createMockLogger(),
      });

      const { res } = makeMockHttpResponse();
      const handled = await handler({ url: path } as IncomingMessage, res, undefined, {
        gatewayAuthSatisfied,
        gatewayRequestOperatorScopes,
      });

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
      expect(observedScopes).toEqual(expectedScopes);
    },
  );
});
