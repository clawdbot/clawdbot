import { beforeEach, describe, expect, it, vi } from "vitest";
import { operatorMcpOAuthIdentity } from "../../agents/mcp-oauth-identity.js";
import {
  createCoreGatewayMethodDescriptors,
  resolveCoreOperatorGatewayMethodScope,
} from "../methods/core-descriptors.js";
import { createGatewayMethodRegistry } from "../methods/registry.js";
import { handleGatewayRequest } from "../server-methods.js";

const mocks = vi.hoisted(() => ({
  cancel: vi.fn(),
  clear: vi.fn(),
  readStatus: vi.fn(),
  settleExpired: vi.fn(),
  start: vi.fn(),
}));

vi.mock("../../agents/mcp-oauth.js", () => ({
  cancelMcpOAuthAuthorization: mocks.cancel,
  clearMcpOAuthCredentials: mocks.clear,
  readMcpOAuthControlStatus: mocks.readStatus,
  settleExpiredMcpOAuthAuthorization: mocks.settleExpired,
  startMcpOAuthAuthorization: mocks.start,
}));

import { mcpOAuthHandlers } from "./mcp-oauth.js";

const SERVER_URL = "https://mcp.example.com/mcp";
const CONFIG = {
  mcp: {
    servers: {
      docs: { url: SERVER_URL, transport: "streamable-http", auth: "oauth" },
      requester: {
        url: "https://requester.example.com/mcp",
        transport: "streamable-http",
        auth: "oauth",
        oauth: { identity: "per-requester" },
      },
    },
  },
};

const methodRegistry = createGatewayMethodRegistry(
  createCoreGatewayMethodDescriptors(mcpOAuthHandlers),
);

async function dispatch(
  method: string,
  params: Record<string, unknown>,
  options: { scopes?: string[]; controlUiOrigin?: string; config?: object } = {},
) {
  const respond = vi.fn();
  await handleGatewayRequest({
    req: { type: "req", id: "mcp-oauth-test", method, params },
    respond,
    client: {
      connId: "control-ui-test",
      connect: {
        role: "operator",
        scopes: options.scopes ?? ["operator.admin"],
        client: { id: "openclaw-control-ui", version: "test", platform: "web", mode: "webchat" },
        minProtocol: 1,
        maxProtocol: 1,
      },
      internal: {
        controlUiOrigin: options.controlUiOrigin ?? "http://127.0.0.1:18789",
      },
    } as Parameters<typeof handleGatewayRequest>[0]["client"],
    isWebchatConnect: () => false,
    context: {
      getRuntimeConfig: () => options.config ?? CONFIG,
      logGateway: { warn: vi.fn() },
    } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"],
    methodRegistry,
  });
  return respond;
}

beforeEach(() => {
  mocks.cancel.mockReset().mockResolvedValue(true);
  mocks.clear.mockReset().mockResolvedValue(undefined);
  mocks.readStatus
    .mockReset()
    .mockReturnValue({ state: "authorization-required", credentialPresent: false });
  mocks.settleExpired.mockReset().mockResolvedValue(false);
  mocks.start.mockReset().mockResolvedValue({
    status: "redirect",
    authorizationId: "attempt-1",
    authorizationUrl: "https://accounts.example.com/authorize",
    redirectUrl: "http://127.0.0.1:18789/oauth/mcp/callback",
    state: "synthetic-state",
  });
});

describe("MCP OAuth Gateway methods", () => {
  it("requires operator.admin for every OAuth state and mutation method", async () => {
    expect(
      ["mcp.oauth.status", "mcp.oauth.start", "mcp.oauth.cancel", "mcp.oauth.disconnect"].map(
        (method) => resolveCoreOperatorGatewayMethodScope(method),
      ),
    ).toEqual(["operator.admin", "operator.admin", "operator.admin", "operator.admin"]);

    const denied = await dispatch(
      "mcp.oauth.status",
      { serverName: "docs" },
      {
        scopes: ["operator.read"],
      },
    );
    expect(denied).toHaveBeenCalledWith(false, undefined, {
      code: "FORBIDDEN",
      message: "missing scope: operator.admin",
      details: {
        code: "MISSING_SCOPE",
        missingScope: "operator.admin",
        requiredScopes: ["operator.admin"],
      },
    });
    expect(mocks.readStatus).not.toHaveBeenCalled();
  });

  it("settles expired correlation before projecting status", async () => {
    mocks.readStatus
      .mockReturnValueOnce({
        state: "error",
        credentialPresent: true,
        category: "timed-out",
      })
      .mockReturnValueOnce({
        state: "error",
        credentialPresent: true,
        category: "timed-out",
      });
    const respond = await dispatch("mcp.oauth.status", { serverName: "docs" });

    expect(mocks.settleExpired).toHaveBeenCalledWith(operatorMcpOAuthIdentity("docs", SERVER_URL));
    expect(respond).toHaveBeenCalledWith(true, {
      status: { state: "error", credentialPresent: true, category: "timed-out" },
    });
  });

  it("starts the shared operator identity with the admitted Control UI origin", async () => {
    mocks.readStatus.mockReturnValue({
      state: "authorizing",
      credentialPresent: true,
      authorizationId: "attempt-1",
      startedAt: 1,
    });

    const respond = await dispatch("mcp.oauth.start", {
      serverName: "docs",
      reauthorize: true,
    });

    expect(mocks.start).toHaveBeenCalledWith(
      operatorMcpOAuthIdentity("docs", SERVER_URL),
      expect.objectContaining({ kind: "http", url: SERVER_URL, auth: "oauth" }),
      {
        redirectUrl: "http://127.0.0.1:18789/oauth/mcp/callback",
        forceAuthorization: true,
      },
    );
    expect(respond).toHaveBeenCalledWith(true, {
      status: {
        state: "authorizing",
        credentialPresent: true,
        authorizationId: "attempt-1",
        startedAt: 1,
      },
      authorizationPath: "/oauth/mcp/authorize/attempt-1",
    });
  });

  it("rejects requester identities and unexpected identity selectors", async () => {
    const requester = await dispatch("mcp.oauth.status", { serverName: "requester" });
    expect(requester).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "MCP OAuth authorization is unavailable for this server.",
      }),
    );

    const injected = await dispatch("mcp.oauth.status", {
      serverName: "docs",
      storeKey: "another-principal",
    });
    expect(injected).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(mocks.readStatus).not.toHaveBeenCalled();
  });

  it("cancels the exact transaction and disconnects only the selected operator row", async () => {
    mocks.readStatus.mockReturnValue({ state: "ready", credentialPresent: true });
    const cancelled = await dispatch("mcp.oauth.cancel", {
      serverName: "docs",
      authorizationId: "attempt-1",
    });
    expect(mocks.cancel).toHaveBeenCalledWith(
      operatorMcpOAuthIdentity("docs", SERVER_URL),
      "attempt-1",
    );
    expect(cancelled).toHaveBeenCalledWith(true, {
      cancelled: true,
      status: { state: "ready", credentialPresent: true },
    });

    mocks.readStatus.mockReturnValue({
      state: "authorization-required",
      credentialPresent: false,
    });
    const disconnected = await dispatch("mcp.oauth.disconnect", { serverName: "docs" });
    expect(mocks.clear).toHaveBeenCalledWith(operatorMcpOAuthIdentity("docs", SERVER_URL));
    expect(disconnected).toHaveBeenCalledWith(true, {
      status: { state: "authorization-required", credentialPresent: false },
    });
  });

  it("returns a fixed safe start failure without internal exception text", async () => {
    mocks.start.mockRejectedValue(new Error("internal exchange detail"));
    const respond = await dispatch("mcp.oauth.start", { serverName: "docs" });
    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "UNAVAILABLE",
      message: "MCP OAuth authorization could not be started.",
    });
    expect(JSON.stringify(respond.mock.calls)).not.toContain("internal exchange detail");
  });
});
