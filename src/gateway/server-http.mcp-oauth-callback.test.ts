import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import { handleMcpOAuthCallback } from "./mcp-oauth-callback.js";
import {
  AUTH_TOKEN,
  createRequest,
  createResponse,
  dispatchRequest,
  withGatewayServer,
} from "./server-http.test-harness.js";

beforeEach(() => resetGatewayWorkAdmission());
afterEach(() => resetGatewayWorkAdmission());

describe("Gateway MCP OAuth callback route", () => {
  it("serves the exact GET route before authenticated plugin catch-alls", async () => {
    const callback = vi.fn(async (_req: IncomingMessage, res: ServerResponse) => {
      res.statusCode = 200;
      res.end("connected");
      return true;
    });
    const plugin = vi.fn(async () => false);

    await withGatewayServer({
      prefix: "mcp-oauth-callback-route",
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        handleMcpOAuthCallbackRequest: callback,
        handlePluginRequest: plugin,
      },
      run: async (server) => {
        const response = createResponse();
        await dispatchRequest(
          server,
          createRequest({
            path: "/oauth/mcp/callback?code=code&state=state",
            method: "GET",
          }),
          response.res,
        );

        expect(response.res.statusCode).toBe(200);
        expect(response.getBody()).toBe("connected");
        expect(callback).toHaveBeenCalledOnce();
        expect(plugin).not.toHaveBeenCalled();
      },
    });
  });

  it("claims the callback before a hooks path that overlaps /oauth", async () => {
    const callback = vi.fn(async (_req: IncomingMessage, res: ServerResponse) => {
      res.statusCode = 200;
      res.end("connected");
      return true;
    });
    // Simulates hooks.path "/oauth": a prefix-claiming hooks handler that would
    // otherwise 405 the provider redirect.
    const hooks = vi.fn(async (_req: IncomingMessage, res: ServerResponse) => {
      res.statusCode = 405;
      res.end();
      return true;
    });

    await withGatewayServer({
      prefix: "mcp-oauth-callback-hooks-overlap",
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        handleMcpOAuthCallbackRequest: callback,
        handleHooksRequest: hooks,
      },
      run: async (server) => {
        const response = createResponse();
        await dispatchRequest(
          server,
          createRequest({
            path: "/oauth/mcp/callback?code=code&state=state",
            method: "GET",
          }),
          response.res,
        );

        expect(response.res.statusCode).toBe(200);
        expect(callback).toHaveBeenCalledOnce();
        expect(hooks).not.toHaveBeenCalled();
      },
    });
  });

  it("leaves wrong methods and paths outside the callback stage", async () => {
    const callback = vi.fn(async () => false);

    await withGatewayServer({
      prefix: "mcp-oauth-callback-unclaimed",
      resolvedAuth: AUTH_TOKEN,
      overrides: { handleMcpOAuthCallbackRequest: callback },
      run: async (server) => {
        for (const request of [
          createRequest({ path: "/oauth/mcp/callback", method: "POST" }),
          createRequest({ path: "/oauth/other", method: "GET" }),
        ]) {
          const response = createResponse();
          await dispatchRequest(server, request, response.res);
          expect(response.res.statusCode).toBe(404);
        }
        expect(callback).not.toHaveBeenCalled();
      },
    });
  });

  it("falls through to plugin routing when requester OAuth is not configured", async () => {
    const callback = vi.fn((req: IncomingMessage, res: ServerResponse) =>
      handleMcpOAuthCallback(req, res, { config: {}, log: { warn: vi.fn() } }),
    );
    const plugin = vi.fn(async (_req: IncomingMessage, res: ServerResponse) => {
      res.statusCode = 200;
      res.end("plugin");
      return true;
    });

    await withGatewayServer({
      prefix: "mcp-oauth-callback-plugin-fallthrough",
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        handleMcpOAuthCallbackRequest: callback,
        handlePluginRequest: plugin,
        shouldEnforcePluginGatewayAuth: () => false,
      },
      run: async (server) => {
        const response = createResponse();
        await dispatchRequest(
          server,
          createRequest({ path: "/oauth/mcp/callback?code=code&state=state", method: "GET" }),
          response.res,
        );

        expect(response.res.statusCode).toBe(200);
        expect(response.getBody()).toBe("plugin");
        expect(callback).toHaveBeenCalledOnce();
        expect(plugin).toHaveBeenCalledOnce();
      },
    });
  });

  it("rejects callback work after Gateway admission closes", async () => {
    const callback = vi.fn(async () => false);
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);

    try {
      await withGatewayServer({
        prefix: "mcp-oauth-callback-admission",
        resolvedAuth: AUTH_TOKEN,
        overrides: { handleMcpOAuthCallbackRequest: callback },
        run: async (server) => {
          const response = createResponse();
          await dispatchRequest(
            server,
            createRequest({ path: "/oauth/mcp/callback?code=code&state=state" }),
            response.res,
          );

          expect(response.res.statusCode).toBe(503);
          expect(JSON.parse(response.getBody())).toMatchObject({
            error: { code: "gateway_unavailable" },
          });
          expect(callback).not.toHaveBeenCalled();
        },
      });
    } finally {
      suspension?.release();
    }
  });
});
