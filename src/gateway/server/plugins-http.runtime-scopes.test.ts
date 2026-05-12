import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubsystemLogger } from "../../logging/subsystem.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import {
  releasePinnedPluginHttpRouteRegistry,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import type { AuthorizedGatewayHttpRequest } from "../http-utils.js";
import { authorizeOperatorScopesForMethod, CLI_DEFAULT_OPERATOR_SCOPES } from "../method-scopes.js";
import { makeMockHttpResponse } from "../test-http-response.js";
import { createTestRegistry } from "./__tests__/test-utils.js";
import { createGatewayPluginRequestHandler } from "./plugins-http.js";

function createRoute(params: {
  path: string;
  auth: "gateway" | "plugin";
  match?: "exact" | "prefix";
  gatewayRuntimeScopeSurface?: "write-default" | "trusted-operator";
  handler?: (req: IncomingMessage, res: ServerResponse) => boolean | Promise<boolean>;
}) {
  return {
    pluginId: "route",
    path: params.path,
    auth: params.auth,
    gatewayRuntimeScopeSurface: params.gatewayRuntimeScopeSurface,
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
    const handler = createGatewayPluginRequestHandler({
      registry: createTestRegistry({
        httpRoutes: [
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
      }),
      log,
    });

    const response = makeMockHttpResponse();
    const handled = await handler(
      { url: params.path } as IncomingMessage,
      response.res,
      undefined,
      {
        gatewayAuthSatisfied: params.gatewayAuthSatisfied,
        gatewayRequestAuth: params.gatewayRequestAuth,
        gatewayRequestOperatorScopes: params.gatewayRequestOperatorScopes,
      },
    );
    return { handled, log, ...response };
  }

  it("keeps plugin-auth routes off write-capable runtime helpers", async () => {
    const { handled, res, setHeader, end, log } = await invokeRoute({
      path: "/hook",
      auth: "plugin",
      gatewayAuthSatisfied: false,
    });

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(500);
    expect(setHeader).toHaveBeenCalledWith("Content-Type", "text/plain; charset=utf-8");
    expect(end).toHaveBeenCalledWith("Internal Server Error");
    expect(log.warn).toHaveBeenCalledWith(
      "plugin http route failed (route): Error: missing scope: operator.write",
    );
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
    expect(res.statusCode).toBe(500);
    expect(setHeader).toHaveBeenCalledWith("Content-Type", "text/plain; charset=utf-8");
    expect(end).toHaveBeenCalledWith("Internal Server Error");
    expect(log.warn).toHaveBeenCalledWith(
      "plugin http route failed (route): Error: missing scope: operator.write",
    );
  });

  it("restores trusted-operator defaults for routes opting into trusted surface", async () => {
    let observedScopes: string[] | undefined;
    const log = createMockLogger();
    const handler = createGatewayPluginRequestHandler({
      registry: createTestRegistry({
        httpRoutes: [
          createRoute({
            path: "/secure-admin-hook",
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
      }),
      log,
    });

    const response = makeMockHttpResponse();
    const handled = await handler(
      { url: "/secure-admin-hook" } as IncomingMessage,
      response.res,
      undefined,
      {
        gatewayAuthSatisfied: true,
        gatewayRequestAuth: { authMethod: "token", trustDeclaredOperatorScopes: false },
        gatewayRequestOperatorScopes: ["operator.write"],
      },
    );

    expect(handled).toBe(true);
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

    const response = makeMockHttpResponse();
    const handled = await handler(
      { url: "/secure/admin-hook" } as IncomingMessage,
      response.res,
      undefined,
      {
        gatewayAuthSatisfied: true,
        gatewayRequestAuth: { authMethod: "token", trustDeclaredOperatorScopes: false },
        gatewayRequestOperatorScopes: ["operator.write"],
      },
    );

    expect(handled).toBe(true);
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
