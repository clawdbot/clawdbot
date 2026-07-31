import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, test, vi } from "vitest";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  CONTROL_UI_PLUGIN_AUTH_PROBE_MESSAGE,
  CONTROL_UI_PLUGIN_AUTH_PROBE_ORIGIN_QUERY,
  CONTROL_UI_PLUGIN_AUTH_PROBE_QUERY,
} from "./control-ui-contract.js";
import { setControlUiPluginAuthCookie } from "./control-ui-plugin-auth-cookie.js";
import { checkGatewayHttpRequestAuth } from "./http-auth-utils.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";
import type { OperatorScope } from "./operator-scopes.js";
import {
  AUTH_TOKEN,
  createRequest,
  createResponse,
  dispatchRequest,
  withGatewayServer,
} from "./server-http.test-harness.js";
import { createTestRegistry } from "./server/__tests__/test-utils.js";
import { createGatewayPluginRequestHandler } from "./server/plugins-http.js";
import { resolveSharedGatewaySessionGeneration } from "./server/ws-shared-generation.js";

function createControlUiPluginAuthCookieForTest(
  scopes: string[],
  params: {
    pluginId?: string;
    path?: string;
    match?: "exact" | "prefix";
    generation?: string;
  } = {},
): string {
  const response = createResponse();
  setControlUiPluginAuthCookie(
    response.res,
    [
      {
        pluginId: params.pluginId ?? "runtime-scope-control-ui-cookie",
        path: params.path ?? "/secure-hook",
        match: params.match ?? "exact",
        scopes: scopes as OperatorScope[],
      },
    ],
    { generation: params.generation ?? resolveSharedGatewaySessionGeneration(AUTH_TOKEN) },
  );
  const setCookie = response.setHeader.mock.calls.find(([name]) => name === "Set-Cookie")?.[1];
  const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (typeof cookie !== "string") {
    throw new Error("Expected control ui plugin auth cookie");
  }
  return cookie;
}

function createRuntimeScopeRecorderHandler(params: {
  pluginId: string;
  path: string;
  method: string;
  observedRuntimeScopes: string[][];
  allowedResults: boolean[];
  gatewayRuntimeScopeSurface?: "trusted-operator";
  match?: "exact" | "prefix";
}) {
  return createGatewayPluginRequestHandler({
    registry: createTestRegistry({
      httpRoutes: [
        {
          pluginId: params.pluginId,
          source: params.pluginId,
          path: params.path,
          auth: "gateway",
          ...(params.gatewayRuntimeScopeSurface
            ? { gatewayRuntimeScopeSurface: params.gatewayRuntimeScopeSurface }
            : {}),
          match: params.match ?? "exact",
          handler: async (_req: IncomingMessage, res: ServerResponse) => {
            const runtimeScopes =
              getPluginRuntimeGatewayRequestScope()?.client?.connect?.scopes?.slice() ?? [];
            params.observedRuntimeScopes.push(runtimeScopes);
            const auth = authorizeOperatorScopesForMethod(params.method, runtimeScopes);
            params.allowedResults.push(auth.allowed);
            res.statusCode = 200;
            res.end("ok");
            return true;
          },
        },
      ],
    }),
    log: { warn: vi.fn() } as unknown as Parameters<
      typeof createGatewayPluginRequestHandler
    >[0]["log"],
  });
}

async function expectPluginRequestOk(
  server: Parameters<typeof dispatchRequest>[0],
  request: Parameters<typeof createRequest>[0],
): Promise<void> {
  const response = createResponse();
  await dispatchRequest(server, createRequest(request), response.res);
  expect(response.res.statusCode).toBe(200);
  expect(response.getBody()).toBe("ok");
}

describe("control ui plugin frame auth route boundaries", () => {
  test("probes cookie availability inside the sandbox without invoking plugin code", async () => {
    const observedRuntimeScopes: string[][] = [];
    const handlePluginRequest = createRuntimeScopeRecorderHandler({
      pluginId: "runtime-scope-control-ui-cookie",
      path: "/secure-hook",
      method: "assistant.media.get",
      observedRuntimeScopes,
      allowedResults: [],
    });
    const cookie = createControlUiPluginAuthCookieForTest(["operator.read"]);
    const nonce = "0123456789abcdef0123456789abcdef";
    const targetOrigin = "https://gateway.example";
    const path = `/secure-hook?${CONTROL_UI_PLUGIN_AUTH_PROBE_QUERY}=${nonce}&${CONTROL_UI_PLUGIN_AUTH_PROBE_ORIGIN_QUERY}=${encodeURIComponent(targetOrigin)}`;

    await withGatewayServer({
      prefix: "openclaw-plugin-http-runtime-scope-cookie-probe-test-",
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        handlePluginRequest,
        shouldEnforcePluginGatewayAuth: (pathContext) => pathContext.pathname === "/secure-hook",
      },
      run: async (server) => {
        const unauthorized = createResponse();
        await dispatchRequest(server, createRequest({ path }), unauthorized.res);
        expect(unauthorized.res.statusCode).toBe(401);

        const authorized = createResponse();
        await dispatchRequest(server, createRequest({ path, headers: { cookie } }), authorized.res);
        expect(authorized.res.statusCode).toBe(200);
        expect(authorized.getBody()).toContain(
          JSON.stringify({ type: CONTROL_UI_PLUGIN_AUTH_PROBE_MESSAGE, nonce }),
        );
        expect(authorized.getBody()).toContain(JSON.stringify(targetOrigin));
        expect(authorized.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
        expect(authorized.setHeader).toHaveBeenCalledWith(
          "Content-Security-Policy",
          expect.stringContaining("frame-ancestors 'self'"),
        );

        const invalid = createResponse();
        await dispatchRequest(
          server,
          createRequest({
            path: `/secure-hook?${CONTROL_UI_PLUGIN_AUTH_PROBE_QUERY}=${nonce}`,
            headers: { cookie },
          }),
          invalid.res,
        );
        expect(invalid.res.statusCode).toBe(400);
      },
    });

    expect(observedRuntimeScopes).toEqual([]);
  });

  test("rejects control ui plugin auth cookies on sibling gateway-auth plugin routes", async () => {
    const observedRuntimeScopes: string[][] = [];
    const handlePluginRequest = createRuntimeScopeRecorderHandler({
      pluginId: "runtime-scope-control-ui-cookie-route-bound",
      path: "/other-secure-hook",
      method: "assistant.media.get",
      observedRuntimeScopes,
      allowedResults: [],
    });
    const cookie = createControlUiPluginAuthCookieForTest(["operator.read"], {
      pluginId: "runtime-scope-control-ui-cookie-route-bound",
      path: "/secure-hook",
    });

    await withGatewayServer({
      prefix: "openclaw-plugin-http-runtime-scope-cookie-route-bound-test-",
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        handlePluginRequest,
        shouldEnforcePluginGatewayAuth: (pathContext) =>
          pathContext.pathname === "/other-secure-hook",
      },
      run: async (server) => {
        const response = createResponse();
        await dispatchRequest(
          server,
          createRequest({ path: "/other-secure-hook", headers: { cookie } }),
          response.res,
        );
        expect(response.res.statusCode).toBe(401);
      },
    });

    expect(observedRuntimeScopes).toEqual([]);
  });

  test("does not broaden an exact-route grant to child paths", async () => {
    const childHandler = vi.fn(async () => true);
    const handlePluginRequest = createGatewayPluginRequestHandler({
      registry: createTestRegistry({
        httpRoutes: [
          {
            pluginId: "exact-plugin",
            path: "/secure-hook/child",
            auth: "gateway",
            match: "exact",
            handler: childHandler,
          },
        ],
      }),
      log: { warn: vi.fn() } as unknown as Parameters<
        typeof createGatewayPluginRequestHandler
      >[0]["log"],
    });
    const cookie = createControlUiPluginAuthCookieForTest(["operator.read"], {
      pluginId: "exact-plugin",
      path: "/secure-hook",
      match: "exact",
    });

    await withGatewayServer({
      prefix: "openclaw-plugin-http-cookie-exact-bound-test-",
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        handlePluginRequest,
        shouldEnforcePluginGatewayAuth: () => true,
      },
      run: async (server) => {
        const response = createResponse();
        await dispatchRequest(
          server,
          createRequest({ path: "/secure-hook/child", headers: { cookie } }),
          response.res,
        );
        expect(response.res.statusCode).toBe(401);
      },
    });

    expect(childHandler).not.toHaveBeenCalled();
  });

  test("rejects encoded path traversal outside the signed route root", async () => {
    const outerHandler = vi.fn(async () => true);
    const adminHandler = vi.fn(async () => true);
    const handlePluginRequest = createGatewayPluginRequestHandler({
      registry: createTestRegistry({
        httpRoutes: [
          {
            pluginId: "same-plugin",
            path: "/admin",
            auth: "gateway",
            match: "exact",
            handler: adminHandler,
          },
          {
            pluginId: "same-plugin",
            path: "/plugins/same",
            auth: "gateway",
            match: "prefix",
            handler: outerHandler,
          },
        ],
      }),
      log: { warn: vi.fn() } as unknown as Parameters<
        typeof createGatewayPluginRequestHandler
      >[0]["log"],
    });
    const cookie = createControlUiPluginAuthCookieForTest(["operator.admin"], {
      pluginId: "same-plugin",
      path: "/plugins/same",
      match: "prefix",
    });

    await withGatewayServer({
      prefix: "openclaw-plugin-http-cookie-canonical-path-test-",
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        handlePluginRequest,
        shouldEnforcePluginGatewayAuth: () => true,
      },
      run: async (server) => {
        const response = createResponse();
        await dispatchRequest(
          server,
          createRequest({
            path: "/plugins/same/%252e%252e/%252e%252e/admin",
            headers: { cookie },
          }),
          response.res,
        );
        expect(response.res.statusCode).toBe(401);
      },
    });

    expect(outerHandler).not.toHaveBeenCalled();
    expect(adminHandler).not.toHaveBeenCalled();
  });

  test("accepts control ui plugin auth cookies for gateway-auth plugin routes", async () => {
    const observedRuntimeScopes: string[][] = [];
    const writeAllowedResults: boolean[] = [];
    const handlePluginRequest = createRuntimeScopeRecorderHandler({
      pluginId: "runtime-scope-control-ui-cookie",
      path: "/secure-hook",
      method: "node.invoke",
      observedRuntimeScopes,
      allowedResults: writeAllowedResults,
    });
    const cookie = createControlUiPluginAuthCookieForTest(["operator.read", "operator.write"]);

    await withGatewayServer({
      prefix: "openclaw-plugin-http-runtime-scope-cookie-test-",
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        handlePluginRequest,
        shouldEnforcePluginGatewayAuth: (pathContext) => pathContext.pathname === "/secure-hook",
      },
      run: async (server) => {
        await expectPluginRequestOk(server, {
          path: "/secure-hook",
          headers: { cookie },
        });
      },
    });

    expect(observedRuntimeScopes).toEqual([["operator.read", "operator.write"]]);
    expect(writeAllowedResults).toEqual([true]);
  });

  test("accepts control ui plugin auth cookies on child paths under the bound tab route", async () => {
    const observedRuntimeScopes: string[][] = [];
    const handlePluginRequest = createRuntimeScopeRecorderHandler({
      pluginId: "runtime-scope-control-ui-cookie-route-child",
      path: "/secure-hook",
      match: "prefix",
      method: "assistant.media.get",
      observedRuntimeScopes,
      allowedResults: [],
    });
    const cookie = createControlUiPluginAuthCookieForTest(["operator.read"], {
      pluginId: "runtime-scope-control-ui-cookie-route-child",
      path: "/secure-hook",
      match: "prefix",
    });

    await withGatewayServer({
      prefix: "openclaw-plugin-http-runtime-scope-cookie-route-child-test-",
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        handlePluginRequest,
        shouldEnforcePluginGatewayAuth: (pathContext) =>
          pathContext.pathname === "/secure-hook/assets/app.js",
      },
      run: async (server) => {
        await expectPluginRequestOk(server, {
          path: "/secure-hook/assets/app.js",
          headers: { cookie },
        });
      },
    });

    expect(observedRuntimeScopes).toEqual([["operator.read"]]);
  });

  test("rejects mutation requests that present only a control ui plugin auth cookie", async () => {
    const handlePluginRequest = vi.fn(async () => true);
    const cookie = createControlUiPluginAuthCookieForTest(["operator.read"], {
      pluginId: "read-only-plugin",
      path: "/secure-hook",
      match: "prefix",
    });

    await withGatewayServer({
      prefix: "openclaw-plugin-http-cookie-read-only-test-",
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        handlePluginRequest,
        shouldEnforcePluginGatewayAuth: () => true,
      },
      run: async (server) => {
        const response = createResponse();
        await dispatchRequest(
          server,
          createRequest({
            path: "/secure-hook/action",
            method: "POST",
            headers: { cookie },
          }),
          response.res,
        );
        expect(response.res.statusCode).toBe(401);
      },
    });

    expect(handlePluginRequest).not.toHaveBeenCalled();
  });

  test("does not accept a control ui plugin auth cookie for websocket upgrade auth", async () => {
    const cookie = createControlUiPluginAuthCookieForTest(["operator.read"]);
    const result = await checkGatewayHttpRequestAuth({
      req: createRequest({
        path: "/secure-hook",
        method: "GET",
        headers: {
          connection: "Upgrade",
          cookie,
          upgrade: "websocket",
        },
      }),
      auth: AUTH_TOKEN,
      cfg: {},
    });

    expect(result.ok).toBe(false);
  });

  test("rejects control ui plugin auth cookies after shared auth generation changes", async () => {
    const observedRuntimeScopes: string[][] = [];
    const handlePluginRequest = createRuntimeScopeRecorderHandler({
      pluginId: "runtime-scope-control-ui-cookie-generation-bound",
      path: "/secure-hook",
      method: "assistant.media.get",
      observedRuntimeScopes,
      allowedResults: [],
    });
    const cookie = createControlUiPluginAuthCookieForTest(["operator.read"], {
      pluginId: "runtime-scope-control-ui-cookie-generation-bound",
      generation: "stale-generation",
    });

    await withGatewayServer({
      prefix: "openclaw-plugin-http-runtime-scope-cookie-generation-bound-test-",
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        handlePluginRequest,
        shouldEnforcePluginGatewayAuth: (pathContext) => pathContext.pathname === "/secure-hook",
      },
      run: async (server) => {
        const response = createResponse();
        await dispatchRequest(
          server,
          createRequest({ path: "/secure-hook", headers: { cookie } }),
          response.res,
        );
        expect(response.res.statusCode).toBe(401);
      },
    });

    expect(observedRuntimeScopes).toEqual([]);
  });

  test("keeps trusted-operator routes constrained to control ui plugin auth cookie scopes", async () => {
    const observedRuntimeScopes: string[][] = [];
    const adminAllowedResults: boolean[] = [];
    const handlePluginRequest = createRuntimeScopeRecorderHandler({
      pluginId: "runtime-scope-control-ui-cookie-trusted-operator",
      path: "/secure-admin-hook",
      method: "set-heartbeats",
      observedRuntimeScopes,
      allowedResults: adminAllowedResults,
      gatewayRuntimeScopeSurface: "trusted-operator",
    });
    const cookie = createControlUiPluginAuthCookieForTest(["operator.read", "operator.write"], {
      pluginId: "runtime-scope-control-ui-cookie-trusted-operator",
      path: "/secure-admin-hook",
    });

    await withGatewayServer({
      prefix: "openclaw-plugin-http-runtime-scope-cookie-trusted-operator-test-",
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        handlePluginRequest,
        shouldEnforcePluginGatewayAuth: (pathContext) =>
          pathContext.pathname === "/secure-admin-hook",
      },
      run: async (server) => {
        await expectPluginRequestOk(server, {
          path: "/secure-admin-hook",
          headers: { cookie },
        });
      },
    });

    expect(observedRuntimeScopes).toEqual([["operator.read", "operator.write"]]);
    expect(adminAllowedResults).toEqual([false]);
  });

  test("rejects a broader plugin grant when a nested gateway route belongs to another plugin", async () => {
    const outerHandler = vi.fn(async () => true);
    const nestedHandler = vi.fn(async () => true);
    const handlePluginRequest = createGatewayPluginRequestHandler({
      registry: createTestRegistry({
        httpRoutes: [
          {
            pluginId: "outer-plugin",
            path: "/plugins/outer",
            auth: "gateway",
            match: "prefix",
            handler: outerHandler,
          },
          {
            pluginId: "nested-plugin",
            path: "/plugins/outer/nested",
            auth: "gateway",
            match: "exact",
            handler: nestedHandler,
          },
        ],
      }),
      log: { warn: vi.fn() } as unknown as Parameters<
        typeof createGatewayPluginRequestHandler
      >[0]["log"],
    });
    const cookie = createControlUiPluginAuthCookieForTest(["operator.write"], {
      pluginId: "outer-plugin",
      path: "/plugins/outer",
      match: "prefix",
    });

    await withGatewayServer({
      prefix: "openclaw-plugin-http-cookie-plugin-bound-test-",
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        handlePluginRequest,
        shouldEnforcePluginGatewayAuth: () => true,
      },
      run: async (server) => {
        const response = createResponse();
        await dispatchRequest(
          server,
          createRequest({ path: "/plugins/outer/nested", headers: { cookie } }),
          response.res,
        );
        expect(response.res.statusCode).toBe(401);
      },
    });

    expect(outerHandler).not.toHaveBeenCalled();
    expect(nestedHandler).not.toHaveBeenCalled();
  });

  test("selects the most-specific valid plugin grant independent of cookie header order", async () => {
    const observedRuntimeScopes: string[][] = [];
    const handlePluginRequest = createRuntimeScopeRecorderHandler({
      pluginId: "nested-plugin",
      path: "/plugins/outer/nested",
      method: "assistant.media.get",
      observedRuntimeScopes,
      allowedResults: [],
    });
    const broadCookie = createControlUiPluginAuthCookieForTest(["operator.write"], {
      pluginId: "outer-plugin",
      path: "/plugins/outer",
      match: "prefix",
    });
    const nestedCookie = createControlUiPluginAuthCookieForTest(["operator.read"], {
      pluginId: "nested-plugin",
      path: "/plugins/outer/nested",
    });

    await withGatewayServer({
      prefix: "openclaw-plugin-http-cookie-specificity-test-",
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        handlePluginRequest,
        shouldEnforcePluginGatewayAuth: () => true,
      },
      run: async (server) => {
        await expectPluginRequestOk(server, {
          path: "/plugins/outer/nested",
          headers: { cookie: `${broadCookie}; ${nestedCookie}` },
        });
      },
    });

    expect(observedRuntimeScopes).toEqual([["operator.read"]]);
  });

  test("selects the grant owned by the first dispatched gateway route", async () => {
    const observedRuntimeScopes: string[][] = [];
    const exactOuterHandler = vi.fn(async (_req: IncomingMessage, res: ServerResponse) => {
      observedRuntimeScopes.push(
        getPluginRuntimeGatewayRequestScope()?.client?.connect?.scopes?.slice() ?? [],
      );
      res.statusCode = 200;
      res.end("ok");
      return true;
    });
    const nestedHandler = vi.fn(async () => true);
    const outerHandler = vi.fn(async () => true);
    const handlePluginRequest = createGatewayPluginRequestHandler({
      registry: createTestRegistry({
        httpRoutes: [
          {
            pluginId: "outer-plugin",
            path: "/plugins/outer/nested/action",
            auth: "gateway",
            match: "exact",
            handler: exactOuterHandler,
          },
          {
            pluginId: "nested-plugin",
            path: "/plugins/outer/nested",
            auth: "gateway",
            match: "prefix",
            handler: nestedHandler,
          },
          {
            pluginId: "outer-plugin",
            path: "/plugins/outer",
            auth: "gateway",
            match: "prefix",
            handler: outerHandler,
          },
        ],
      }),
      log: { warn: vi.fn() } as unknown as Parameters<
        typeof createGatewayPluginRequestHandler
      >[0]["log"],
    });
    const outerCookie = createControlUiPluginAuthCookieForTest(["operator.write"], {
      pluginId: "outer-plugin",
      path: "/plugins/outer",
      match: "prefix",
    });
    const nestedCookie = createControlUiPluginAuthCookieForTest(["operator.read"], {
      pluginId: "nested-plugin",
      path: "/plugins/outer/nested",
      match: "prefix",
    });

    await withGatewayServer({
      prefix: "openclaw-plugin-http-cookie-dispatch-owner-test-",
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        handlePluginRequest,
        shouldEnforcePluginGatewayAuth: () => true,
      },
      run: async (server) => {
        await expectPluginRequestOk(server, {
          path: "/plugins/outer/nested/action",
          headers: { cookie: `${outerCookie}; ${nestedCookie}` },
        });
      },
    });

    expect(observedRuntimeScopes).toEqual([["operator.write"]]);
    expect(exactOuterHandler).toHaveBeenCalledOnce();
    expect(nestedHandler).not.toHaveBeenCalled();
    expect(outerHandler).not.toHaveBeenCalled();
  });

  test("does not fall through from a granted route into another plugin's gateway route", async () => {
    const nestedHandler = vi.fn(async () => false);
    const outerHandler = vi.fn(async () => true);
    const handlePluginRequest = createGatewayPluginRequestHandler({
      registry: createTestRegistry({
        httpRoutes: [
          {
            pluginId: "nested-plugin",
            path: "/plugins/outer/nested",
            auth: "gateway",
            match: "exact",
            handler: nestedHandler,
          },
          {
            pluginId: "outer-plugin",
            path: "/plugins/outer",
            auth: "gateway",
            match: "prefix",
            handler: outerHandler,
          },
        ],
      }),
      log: { warn: vi.fn() } as unknown as Parameters<
        typeof createGatewayPluginRequestHandler
      >[0]["log"],
    });
    const cookie = createControlUiPluginAuthCookieForTest(["operator.read"], {
      pluginId: "nested-plugin",
      path: "/plugins/outer/nested",
    });

    await withGatewayServer({
      prefix: "openclaw-plugin-http-cookie-fallthrough-test-",
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        handlePluginRequest,
        shouldEnforcePluginGatewayAuth: () => true,
      },
      run: async (server) => {
        const response = createResponse();
        await dispatchRequest(
          server,
          createRequest({ path: "/plugins/outer/nested", headers: { cookie } }),
          response.res,
        );
        expect(response.res.statusCode).toBe(404);
      },
    });

    expect(nestedHandler).toHaveBeenCalledOnce();
    expect(outerHandler).not.toHaveBeenCalled();
  });
});
