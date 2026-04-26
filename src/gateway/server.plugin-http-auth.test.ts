import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, test, vi } from "vitest";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";
import { canonicalizePathVariant, isProtectedPluginRoutePath } from "./security-path.js";
import {
  AUTH_NONE,
  AUTH_TOKEN,
  buildChannelPathFuzzCorpus,
  CANONICAL_AUTH_VARIANTS,
  CANONICAL_UNAUTH_VARIANTS,
  createCanonicalizedChannelPluginHandler,
  createHooksHandler,
  createRequest,
  createResponse,
  createTestGatewayServer,
  dispatchRequest,
  expectAuthorizedVariants,
  expectUnauthorizedResponse,
  expectUnauthorizedVariants,
  sendRequest,
  withGatewayServer,
  withGatewayTempConfig,
} from "./server-http.test-harness.js";
import { createTestRegistry } from "./server/__tests__/test-utils.js";
import { createGatewayPluginRequestHandler } from "./server/plugins-http.js";
import { withTempConfig } from "./test-temp-config.js";

type PluginRequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

function canonicalizePluginPath(pathname: string): string {
  return canonicalizePathVariant(pathname);
}

function respondJsonRoute(res: ServerResponse, route: string): true {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ ok: true, route }));
  return true;
}

function createHealthzPluginHandler() {
  return vi.fn(async (req: IncomingMessage, res: ServerResponse) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname !== "/healthz") {
      return false;
    }
    return respondJsonRoute(res, "plugin-health");
  });
}

async function expectHealthzProbeReserved(params: {
  server: Parameters<typeof sendRequest>[0];
  handlePluginRequest: ReturnType<typeof createHealthzPluginHandler>;
}) {
  const response = await sendRequest(params.server, { path: "/healthz" });
  expect(response.res.statusCode).toBe(200);
  expect(response.getBody()).toBe(JSON.stringify({ ok: true, status: "live" }));
  expect(params.handlePluginRequest).not.toHaveBeenCalled();
}

function createMattermostCallbackConfig(callbackPath: string) {
  return {
    gateway: { trustedProxies: [] },
    channels: {
      mattermost: {
        commands: { callbackPath },
      },
    },
  };
}

function createRootMountedControlUiOverrides(handlePluginRequest: PluginRequestHandler) {
  return {
    controlUiEnabled: true,
    controlUiBasePath: "",
    controlUiRoot: { kind: "missing" as const },
    handlePluginRequest,
  };
}

const withRootMountedControlUiServer = (params: {
  prefix: string;
  handlePluginRequest: PluginRequestHandler;
  run: Parameters<typeof withGatewayServer>[0]["run"];
}) =>
  withPluginGatewayServer({
    prefix: params.prefix,
    resolvedAuth: AUTH_NONE,
    overrides: createRootMountedControlUiOverrides(params.handlePluginRequest),
    run: params.run,
  });

const withPluginGatewayServer = (params: Parameters<typeof withGatewayServer>[0]) =>
  withGatewayServer(params);

const PROBE_CASES = [
  { path: "/health", status: "live" },
  { path: "/healthz", status: "live" },
  { path: "/ready", status: "ready" },
  { path: "/readyz", status: "ready" },
] as const;

async function expectProbeRoutesHealthy(server: Parameters<typeof sendRequest>[0]) {
  for (const probeCase of PROBE_CASES) {
    const response = await sendRequest(server, { path: probeCase.path });
    expect(response.res.statusCode, probeCase.path).toBe(200);
    expect(response.getBody(), probeCase.path).toBe(
      JSON.stringify({ ok: true, status: probeCase.status }),
    );
  }
}

function createProtectedPluginAuthOverrides(handlePluginRequest: PluginRequestHandler) {
  return {
    handlePluginRequest,
    shouldEnforcePluginGatewayAuth: (pathContext: { pathname: string }) =>
      isProtectedPluginRoutePath(pathContext.pathname),
  };
}

function createRuntimeScopeRecorderHandler(params: {
  pluginId: string;
  path: string;
  method: string;
  observedRuntimeScopes: string[][];
  allowedResults: boolean[];
  gatewayRuntimeScopeSurface?: "trusted-operator";
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
          match: "exact",
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

describe("gateway plugin HTTP auth boundary", () => {
  test("applies default security headers and optional strict transport security", async () => {
    await withGatewayTempConfig("openclaw-plugin-http-security-headers-test-", async () => {
      const withoutHsts = createTestGatewayServer({ resolvedAuth: AUTH_NONE });
      const withoutHstsResponse = await sendRequest(withoutHsts, { path: "/missing" });
      expect(withoutHstsResponse.setHeader).toHaveBeenCalledWith(
        "X-Content-Type-Options",
        "nosniff",
      );
      expect(withoutHstsResponse.setHeader).toHaveBeenCalledWith("Referrer-Policy", "no-referrer");
      expect(withoutHstsResponse.setHeader).not.toHaveBeenCalledWith(
        "Strict-Transport-Security",
        expect.any(String),
      );

      const withHsts = createTestGatewayServer({
        resolvedAuth: AUTH_NONE,
        overrides: {
          strictTransportSecurityHeader: "max-age=31536000; includeSubDomains",
        },
      });
      const withHstsResponse = await sendRequest(withHsts, { path: "/missing" });
      expect(withHstsResponse.setHeader).toHaveBeenCalledWith(
        "Strict-Transport-Security",
        "max-age=31536000; includeSubDomains",
      );
    });
  });

  test("serves unauthenticated liveness/readiness probe routes when no other route handles them", async () => {
    await withGatewayServer({
      prefix: "openclaw-plugin-http-probes-test-",
      resolvedAuth: AUTH_TOKEN,
      run: async (server) => {
        await expectProbeRoutesHealthy(server);
      },
    });
  });

  test("reserves gateway probe routes ahead of plugin routes", async () => {
    const handlePluginRequest = createHealthzPluginHandler();

    await withGatewayServer({
      prefix: "openclaw-plugin-http-probes-shadow-test-",
      resolvedAuth: AUTH_NONE,
      overrides: { handlePluginRequest },
      run: async (server) => {
        await expectHealthzProbeReserved({ server, handlePluginRequest });
      },
    });
  });

  test("rejects non-GET/HEAD methods on probe routes", async () => {
    await withGatewayServer({
      prefix: "openclaw-plugin-http-probes-method-test-",
      resolvedAuth: AUTH_NONE,
      run: async (server) => {
        const postResponse = await sendRequest(server, { path: "/healthz", method: "POST" });
        expect(postResponse.res.statusCode).toBe(405);
        expect(postResponse.setHeader).toHaveBeenCalledWith("Allow", "GET, HEAD");
        expect(postResponse.getBody()).toBe("Method Not Allowed");

        const headResponse = await sendRequest(server, { path: "/readyz", method: "HEAD" });
        expect(headResponse.res.statusCode).toBe(200);
        expect(headResponse.getBody()).toBe("");
      },
    });
  });

  test("requires gateway auth for protected plugin route space and allows authenticated pass-through", async () => {
    const handlePluginRequest = vi.fn(async (req: IncomingMessage, res: ServerResponse) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      if (pathname === "/api/channels") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ ok: true, route: "channel-root" }));
        return true;
      }
      if (pathname === "/api/channels/nostr/default/profile") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ ok: true, route: "channel" }));
        return true;
      }
      if (pathname === "/plugin/public") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ ok: true, route: "public" }));
        return true;
      }
      return false;
    });

    await withGatewayServer({
      prefix: "openclaw-plugin-http-auth-test-",
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        handlePluginRequest,
        shouldEnforcePluginGatewayAuth: (pathContext) =>
          isProtectedPluginRoutePath(pathContext.pathname) ||
          pathContext.pathname === "/plugin/public",
      },
      run: async (server) => {
        const unauthenticated = await sendRequest(server, {
          path: "/api/channels/nostr/default/profile",
        });
        expectUnauthorizedResponse(unauthenticated);
        expect(handlePluginRequest).not.toHaveBeenCalled();

        const unauthenticatedRoot = await sendRequest(server, { path: "/api/channels" });
        expectUnauthorizedResponse(unauthenticatedRoot);
        expect(handlePluginRequest).not.toHaveBeenCalled();

        const authenticated = await sendRequest(server, {
          path: "/api/channels/nostr/default/profile",
          authorization: "Bearer test-token",
        });
        expect(authenticated.res.statusCode).toBe(200);
        expect(authenticated.getBody()).toContain('"route":"channel"');

        const unauthenticatedPublic = await sendRequest(server, { path: "/plugin/public" });
        expectUnauthorizedResponse(unauthenticatedPublic);

        expect(handlePluginRequest).toHaveBeenCalledTimes(1);
      },
    });
  });

  test("preserves trusted-proxy read scopes for gateway-auth plugin runtime routes", async () => {
    const observedRuntimeScopes: string[][] = [];
    const writeAllowedResults: boolean[] = [];
    const handlePluginRequest = createRuntimeScopeRecorderHandler({
      pluginId: "runtime-scope",
      path: "/secure-hook",
      method: "node.invoke",
      observedRuntimeScopes,
      allowedResults: writeAllowedResults,
    });

    await withTempConfig({
      cfg: {
        gateway: {
          trustedProxies: ["203.0.113.10"],
        },
      },
      prefix: "openclaw-plugin-http-runtime-scope-trusted-proxy-test-",
      run: async () => {
        const server = createTestGatewayServer({
          resolvedAuth: {
            mode: "trusted-proxy",
            allowTailscale: false,
            trustedProxy: { userHeader: "x-forwarded-user" },
          },
          overrides: {
            handlePluginRequest,
            shouldEnforcePluginGatewayAuth: (pathContext) =>
              pathContext.pathname === "/secure-hook",
          },
        });

        const response = createResponse();
        await dispatchRequest(
          server,
          createRequest({
            path: "/secure-hook",
            remoteAddress: "203.0.113.10",
            headers: {
              "x-forwarded-user": "operator",
              "x-forwarded-for": "198.51.100.20",
              "x-openclaw-scopes": "operator.read",
            },
          }),
          response.res,
        );

        expect(response.res.statusCode).toBe(200);
        expect(response.getBody()).toBe("ok");
      },
    });

    expect(observedRuntimeScopes).toEqual([["operator.read"]]);
    expect(writeAllowedResults).toEqual([false]);
  });

  test("keeps write runtime scopes for shared-secret bearer gateway-auth plugin routes", async () => {
    const observedRuntimeScopes: string[][] = [];
    const writeAllowedResults: boolean[] = [];
    const handlePluginRequest = createRuntimeScopeRecorderHandler({
      pluginId: "runtime-scope-bearer",
      path: "/secure-hook",
      method: "node.invoke",
      observedRuntimeScopes,
      allowedResults: writeAllowedResults,
    });

    await withGatewayServer({
      prefix: "openclaw-plugin-http-runtime-scope-bearer-test-",
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        handlePluginRequest,
        shouldEnforcePluginGatewayAuth: (pathContext) => pathContext.pathname === "/secure-hook",
      },
      run: async (server) => {
        const response = createResponse();
        await dispatchRequest(
          server,
          createRequest({
            path: "/secure-hook",
            authorization: "Bearer test-token",
            headers: {
              "x-openclaw-scopes": "operator.read",
            },
          }),
          response.res,
        );

        expect(response.res.statusCode).toBe(200);
        expect(response.getBody()).toBe("ok");
      },
    });

    expect(observedRuntimeScopes).toEqual([["operator.write"]]);
    expect(writeAllowedResults).toEqual([true]);
  });

  test("allows trusted-operator plugin routes to resolve admin-capable runtime scopes for shared-secret bearer auth without scope headers", async () => {
    const observedRuntimeScopes: string[][] = [];
    const adminAllowedResults: boolean[] = [];
    const handlePluginRequest = createRuntimeScopeRecorderHandler({
      pluginId: "runtime-scope-bearer-trusted-operator",
      path: "/secure-admin-hook",
      method: "set-heartbeats",
      observedRuntimeScopes,
      allowedResults: adminAllowedResults,
      gatewayRuntimeScopeSurface: "trusted-operator",
    });

    await withGatewayServer({
      prefix: "openclaw-plugin-http-runtime-scope-bearer-trusted-operator-test-",
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        handlePluginRequest,
        shouldEnforcePluginGatewayAuth: (pathContext) =>
          pathContext.pathname === "/secure-admin-hook",
      },
      run: async (server) => {
        const response = createResponse();
        await dispatchRequest(
          server,
          createRequest({
            path: "/secure-admin-hook",
            authorization: "Bearer test-token",
          }),
          response.res,
        );

        expect(response.res.statusCode).toBe(200);
        expect(response.getBody()).toBe("ok");
      },
    });

    expect(observedRuntimeScopes).toHaveLength(1);
    expect(observedRuntimeScopes[0]).toEqual(
      expect.arrayContaining(["operator.admin", "operator.read", "operator.write"]),
    );
    expect(adminAllowedResults).toEqual([true]);
  });

  test("allows unauthenticated Mattermost slash callback routes while keeping other channel routes protected", async () => {
    const handlePluginRequest = vi.fn(async (req: IncomingMessage, res: ServerResponse) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      if (pathname === "/api/channels/mattermost/command") {
        res.statusCode = 200;
        res.end("ok:mm-callback");
        return true;
      }
      if (pathname === "/api/channels/nostr/default/profile") {
        res.statusCode = 200;
        res.end("ok:nostr");
        return true;
      }
      return false;
    });

    await withTempConfig({
      cfg: createMattermostCallbackConfig("/api/channels/mattermost/command"),
      prefix: "openclaw-plugin-http-auth-mm-callback-",
      run: async () => {
        const server = createTestGatewayServer({
          resolvedAuth: AUTH_TOKEN,
          overrides: { handlePluginRequest },
        });

        const slashCallback = await sendRequest(server, {
          path: "/api/channels/mattermost/command",
          method: "POST",
        });
        expect(slashCallback.res.statusCode).toBe(200);
        expect(slashCallback.getBody()).toBe("ok:mm-callback");

        const otherChannelUnauthed = await sendRequest(server, {
          path: "/api/channels/nostr/default/profile",
        });
        expect(otherChannelUnauthed.res.statusCode).toBe(401);
        expect(otherChannelUnauthed.getBody()).toContain("Unauthorized");
      },
    });
  });

  test("does not bypass auth when mattermost callbackPath points to non-mattermost channel routes", async () => {
    const handlePluginRequest = vi.fn(async (req: IncomingMessage, res: ServerResponse) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      if (pathname === "/api/channels/nostr/default/profile") {
        res.statusCode = 200;
        res.end("ok:nostr");
        return true;
      }
      return false;
    });

    await withTempConfig({
      cfg: createMattermostCallbackConfig("/api/channels/nostr/default/profile"),
      prefix: "openclaw-plugin-http-auth-mm-misconfig-",
      run: async () => {
        const server = createTestGatewayServer({
          resolvedAuth: AUTH_TOKEN,
          overrides: { handlePluginRequest },
        });

        const unauthenticated = await sendRequest(server, {
          path: "/api/channels/nostr/default/profile",
          method: "POST",
        });

        expect(unauthenticated.res.statusCode).toBe(401);
        expect(unauthenticated.getBody()).toContain("Unauthorized");
        expect(handlePluginRequest).not.toHaveBeenCalled();
      },
    });
  });

  test("keeps wildcard plugin handlers ungated when auth enforcement predicate excludes their paths", async () => {
    const handlePluginRequest = vi.fn(async (req: IncomingMessage, res: ServerResponse) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      if (pathname === "/plugin/routed") {
        return respondJsonRoute(res, "routed");
      }
      if (pathname === "/googlechat") {
        return respondJsonRoute(res, "wildcard-handler");
      }
      return false;
    });

    await withGatewayServer({
      prefix: "openclaw-plugin-http-auth-wildcard-handler-test-",
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        handlePluginRequest,
        shouldEnforcePluginGatewayAuth: (pathContext) =>
          pathContext.pathname.startsWith("/api/channels") ||
          pathContext.pathname === "/plugin/routed",
      },
      run: async (server) => {
        const unauthenticatedRouted = await sendRequest(server, { path: "/plugin/routed" });
        expectUnauthorizedResponse(unauthenticatedRouted);

        const unauthenticatedWildcard = await sendRequest(server, { path: "/googlechat" });
        expect(unauthenticatedWildcard.res.statusCode).toBe(200);
        expect(unauthenticatedWildcard.getBody()).toContain('"route":"wildcard-handler"');

        const authenticatedRouted = await sendRequest(server, {
          path: "/plugin/routed",
          authorization: "Bearer test-token",
        });
        expect(authenticatedRouted.res.statusCode).toBe(200);
        expect(authenticatedRouted.getBody()).toContain('"route":"routed"');
      },
    });
  });

  test("uses /api/channels auth by default while keeping wildcard handlers ungated with no predicate", async () => {
    const handlePluginRequest = vi.fn(async (req: IncomingMessage, res: ServerResponse) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      if (canonicalizePluginPath(pathname) === "/api/channels/nostr/default/profile") {
        return respondJsonRoute(res, "channel-default");
      }
      if (pathname === "/googlechat") {
        return respondJsonRoute(res, "wildcard-default");
      }
      return false;
    });

    await withGatewayServer({
      prefix: "openclaw-plugin-http-auth-wildcard-default-test-",
      resolvedAuth: AUTH_TOKEN,
      overrides: { handlePluginRequest },
      run: async (server) => {
        const unauthenticated = await sendRequest(server, { path: "/googlechat" });
        expect(unauthenticated.res.statusCode).toBe(200);
        expect(unauthenticated.getBody()).toContain('"route":"wildcard-default"');

        const unauthenticatedChannel = await sendRequest(server, {
          path: "/api/channels/nostr/default/profile",
        });
        expectUnauthorizedResponse(unauthenticatedChannel);

        const unauthenticatedDeepEncodedChannel = await sendRequest(server, {
          path: "/api%2525252fchannels%2525252fnostr%2525252fdefault%2525252fprofile",
        });
        expectUnauthorizedResponse(unauthenticatedDeepEncodedChannel);

        const authenticated = await sendRequest(server, {
          path: "/googlechat",
          authorization: "Bearer test-token",
        });
        expect(authenticated.res.statusCode).toBe(200);
        expect(authenticated.getBody()).toContain('"route":"wildcard-default"');

        const authenticatedChannel = await sendRequest(server, {
          path: "/api/channels/nostr/default/profile",
          authorization: "Bearer test-token",
        });
        expect(authenticatedChannel.res.statusCode).toBe(200);
        expect(authenticatedChannel.getBody()).toContain('"route":"channel-default"');

        const authenticatedDeepEncodedChannel = await sendRequest(server, {
          path: "/api%2525252fchannels%2525252fnostr%2525252fdefault%2525252fprofile",
          authorization: "Bearer test-token",
        });
        expect(authenticatedDeepEncodedChannel.res.statusCode).toBe(200);
        expect(authenticatedDeepEncodedChannel.getBody()).toContain('"route":"channel-default"');
      },
    });
  });

  test("serves plugin routes before control ui spa fallback", async () => {
    const handlePluginRequest = vi.fn(async (req: IncomingMessage, res: ServerResponse) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      if (pathname === "/plugins/diffs/view/demo-id/demo-token") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end("<!doctype html><title>diff-view</title>");
        return true;
      }
      return false;
    });

    await withRootMountedControlUiServer({
      prefix: "openclaw-plugin-http-control-ui-precedence-test-",
      handlePluginRequest,
      run: async (server) => {
        const response = await sendRequest(server, {
          path: "/plugins/diffs/view/demo-id/demo-token",
        });

        expect(response.res.statusCode).toBe(200);
        expect(response.getBody()).toContain("diff-view");
        expect(handlePluginRequest).toHaveBeenCalledTimes(1);
      },
    });
  });

  test("passes POST webhook routes through root-mounted control ui to plugins", async () => {
    const handlePluginRequest = vi.fn(async (req: IncomingMessage, res: ServerResponse) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      if (req.method !== "POST" || pathname !== "/bluebubbles-webhook") {
        return false;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("plugin-webhook");
      return true;
    });

    await withRootMountedControlUiServer({
      prefix: "openclaw-plugin-http-control-ui-webhook-post-test-",
      handlePluginRequest,
      run: async (server) => {
        const response = await sendRequest(server, {
          path: "/bluebubbles-webhook",
          method: "POST",
        });

        expect(response.res.statusCode).toBe(200);
        expect(response.getBody()).toBe("plugin-webhook");
        expect(handlePluginRequest).toHaveBeenCalledTimes(1);
      },
    });
  });

  test("plugin routes take priority over control ui catch-all", async () => {
    const handlePluginRequest = vi.fn(async (req: IncomingMessage, res: ServerResponse) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      if (pathname === "/my-plugin/inbound") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("plugin-handled");
        return true;
      }
      return false;
    });

    await withRootMountedControlUiServer({
      prefix: "openclaw-plugin-http-control-ui-shadow-test-",
      handlePluginRequest,
      run: async (server) => {
        const response = await sendRequest(server, { path: "/my-plugin/inbound" });

        expect(response.res.statusCode).toBe(200);
        expect(response.getBody()).toContain("plugin-handled");
        expect(handlePluginRequest).toHaveBeenCalledTimes(1);
      },
    });
  });

  test("unmatched plugin paths fall through to control ui", async () => {
    const handlePluginRequest = vi.fn(async () => false);

    await withRootMountedControlUiServer({
      prefix: "openclaw-plugin-http-control-ui-fallthrough-test-",
      handlePluginRequest,
      run: async (server) => {
        const response = await sendRequest(server, { path: "/chat" });

        expect(handlePluginRequest).toHaveBeenCalledTimes(1);
        expect(response.res.statusCode).toBe(503);
        expect(response.getBody()).toContain("Control UI assets not found");
      },
    });
  });

  test("root-mounted control ui does not swallow gateway probe routes", async () => {
    const handlePluginRequest = vi.fn(async () => false);

    await withRootMountedControlUiServer({
      prefix: "openclaw-plugin-http-control-ui-probes-test-",
      handlePluginRequest,
      run: async (server) => {
        await expectProbeRoutesHealthy(server);
        expect(handlePluginRequest).not.toHaveBeenCalled();
      },
    });
  });

  test("root-mounted control ui keeps gateway probe routes reserved ahead of plugins", async () => {
    const handlePluginRequest = createHealthzPluginHandler();

    await withRootMountedControlUiServer({
      prefix: "openclaw-plugin-http-control-ui-probe-shadow-test-",
      handlePluginRequest,
      run: async (server) => {
        await expectHealthzProbeReserved({ server, handlePluginRequest });
      },
    });
  });

  test("requires gateway auth for canonicalized /api/channels variants", async () => {
    const handlePluginRequest = createCanonicalizedChannelPluginHandler();

    await withPluginGatewayServer({
      prefix: "openclaw-plugin-http-auth-canonicalized-test-",
      resolvedAuth: AUTH_TOKEN,
      overrides: createProtectedPluginAuthOverrides(handlePluginRequest),
      run: async (server) => {
        await expectUnauthorizedVariants({ server, variants: CANONICAL_UNAUTH_VARIANTS });
        expect(handlePluginRequest).not.toHaveBeenCalled();

        await expectAuthorizedVariants({
          server,
          variants: CANONICAL_AUTH_VARIANTS,
          authorization: "Bearer test-token",
        });
        expect(handlePluginRequest).toHaveBeenCalledTimes(CANONICAL_AUTH_VARIANTS.length);
      },
    });
  });

  test("rejects unauthenticated plugin-channel fuzz corpus variants", async () => {
    const handlePluginRequest = createCanonicalizedChannelPluginHandler();

    await withPluginGatewayServer({
      prefix: "openclaw-plugin-http-auth-fuzz-corpus-test-",
      resolvedAuth: AUTH_TOKEN,
      overrides: createProtectedPluginAuthOverrides(handlePluginRequest),
      run: async (server) => {
        await expectUnauthorizedVariants({
          server,
          variants: buildChannelPathFuzzCorpus(),
        });
        expect(handlePluginRequest).not.toHaveBeenCalled();
      },
    });
  });

  test("enforces auth before plugin handlers on encoded protected-path variants", async () => {
    const encodedVariants = buildChannelPathFuzzCorpus().filter((variant) =>
      variant.path.includes("%"),
    );
    const handlePluginRequest = vi.fn(async (_req: IncomingMessage, res: ServerResponse) => {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: true, route: "should-not-run" }));
      return true;
    });

    await withGatewayServer({
      prefix: "openclaw-plugin-http-auth-encoded-order-test-",
      resolvedAuth: AUTH_TOKEN,
      overrides: { handlePluginRequest },
      run: async (server) => {
        await expectUnauthorizedVariants({ server, variants: encodedVariants });
        expect(handlePluginRequest).not.toHaveBeenCalled();
      },
    });
  });

  test.each(["0.0.0.0", "::"])(
    "returns 404 (not 500) for non-hook routes with hooks enabled and bindHost=%s",
    async (bindHost) => {
      await withGatewayTempConfig("openclaw-plugin-http-hooks-bindhost-", async () => {
        const handleHooksRequest = createHooksHandler(bindHost);
        const server = createTestGatewayServer({
          resolvedAuth: AUTH_NONE,
          overrides: { handleHooksRequest },
        });

        const response = await sendRequest(server, { path: "/" });

        expect(response.res.statusCode).toBe(404);
        expect(response.getBody()).toBe("Not Found");
      });
    },
  );

  test("rejects query-token hooks requests with bindHost=::", async () => {
    await withGatewayTempConfig("openclaw-plugin-http-hooks-query-token-", async () => {
      const handleHooksRequest = createHooksHandler("::");
      const server = createTestGatewayServer({
        resolvedAuth: AUTH_NONE,
        overrides: { handleHooksRequest },
      });

      const response = await sendRequest(server, { path: "/hooks/wake?token=bad" });

      expect(response.res.statusCode).toBe(400);
      expect(response.getBody()).toContain("Hook token must be provided");
    });
  });
});
