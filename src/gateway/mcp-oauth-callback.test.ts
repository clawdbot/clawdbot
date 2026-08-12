import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  operatorMcpOAuthIdentity,
  requesterMcpOAuthStoreKeyPrefix,
} from "../agents/mcp-oauth-identity.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  complete: vi.fn(),
  settle: vi.fn(),
  readPending: vi.fn(),
  readStore: vi.fn(),
}));

vi.mock("../agents/mcp-oauth.js", () => ({
  completeOAuthCallback: mocks.complete,
  settleMcpOAuthCallback: mocks.settle,
}));
vi.mock("../agents/mcp-oauth-store.js", () => ({
  MCP_OAUTH_PENDING_STATE_TTL_MS: 10 * 60 * 1000,
  readMcpOAuthPendingAuthorization: mocks.readPending,
  readMcpOAuthStore: mocks.readStore,
}));

import { handleMcpOAuthCallback } from "./mcp-oauth-callback.js";
import { createRequest, createResponse } from "./server-http.test-harness.js";

const SERVER_URL = "https://calendar.example.com/mcp";
const STORE_KEY = `${requesterMcpOAuthStoreKeyPrefix("calendar", SERVER_URL)}fedcba9876543210`;
const OPERATOR_STORE_KEY = operatorMcpOAuthIdentity("calendar", SERVER_URL).storeKey;
const AUTHORIZATION_URL =
  "https://accounts.example.com/authorize?state=state-1234567890&client_id=openclaw";

function callbackConfig(serverName = "calendar"): OpenClawConfig {
  return {
    mcp: {
      servers: {
        [serverName]: {
          url: SERVER_URL,
          transport: "streamable-http",
          auth: "oauth",
          oauth: { identity: "per-requester" },
        },
      },
    },
  };
}

function sharedCallbackConfig(): OpenClawConfig {
  return {
    mcp: {
      servers: {
        calendar: {
          url: SERVER_URL,
          transport: "streamable-http",
          auth: "oauth",
        },
      },
    },
  };
}

function pendingStore() {
  return {
    codeVerifier: "verifier",
    lastAuthorizationUrl: AUTHORIZATION_URL,
    redirectUrl: "https://gateway.example.com/oauth/mcp/callback",
    authorizationAttempt: {
      id: "attempt-1",
      startedAt: Date.now(),
      status: "pending" as const,
    },
  };
}

async function dispatch(
  path: string,
  options?: { config?: OpenClawConfig; method?: string },
): Promise<{
  handled: boolean;
  response: ReturnType<typeof createResponse>;
  warn: ReturnType<typeof vi.fn>;
}> {
  const response = createResponse();
  const warn = vi.fn();
  const handled = await handleMcpOAuthCallback(
    createRequest({ path, method: options?.method }),
    response.res,
    { config: options?.config ?? callbackConfig(), log: { warn } },
  );
  return { handled, response, warn };
}

beforeEach(() => {
  mocks.complete.mockReset().mockResolvedValue("authorized");
  mocks.settle.mockReset().mockResolvedValue(true);
  mocks.readPending.mockReset().mockReturnValue(STORE_KEY);
  mocks.readStore.mockReset().mockReturnValue(pendingStore());
});

describe("Gateway MCP OAuth callback", () => {
  it("redirects the exact shared pending attempt without returning provider query data to RPC", async () => {
    mocks.readStore.mockImplementation((storeKey: string) =>
      storeKey === OPERATOR_STORE_KEY ? pendingStore() : {},
    );

    const result = await dispatch("/oauth/mcp/authorize/attempt-1", {
      config: sharedCallbackConfig(),
    });

    expect(result.handled).toBe(true);
    expect(result.response.res.statusCode).toBe(302);
    expect(result.response.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(result.response.setHeader).toHaveBeenCalledWith("Location", AUTHORIZATION_URL);
    expect(result.response.setHeader).toHaveBeenCalledWith("Referrer-Policy", "no-referrer");
    expect(result.response.getBody()).toBe("");
    expect(mocks.readPending).not.toHaveBeenCalled();
  });

  it("rejects replaced, expired, requester, and query-bearing launch paths generically", async () => {
    mocks.readStore.mockReturnValue({
      ...pendingStore(),
      authorizationAttempt: {
        id: "replacement-attempt",
        startedAt: Date.now(),
        status: "pending",
      },
    });

    const replaced = await dispatch("/oauth/mcp/authorize/attempt-1", {
      config: sharedCallbackConfig(),
    });
    const requester = await dispatch("/oauth/mcp/authorize/attempt-1");
    const queryBearing = await dispatch("/oauth/mcp/authorize/attempt-1?next=provider");

    for (const result of [replaced, requester, queryBearing]) {
      expect(result.handled).toBe(true);
      expect(result.response.res.statusCode).toBe(404);
      expect(result.response.getBody()).toContain("expired or was already used");
    }
  });

  it("completes the requester row selected by exact OAuth state", async () => {
    const result = await dispatch(
      "/oauth/mcp/callback?code=authorization-code&state=state-1234567890",
    );

    expect(result.handled).toBe(true);
    expect(result.response.res.statusCode).toBe(200);
    expect(result.response.getBody()).toContain("You're connected.");
    expect(result.response.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(mocks.readPending).toHaveBeenCalledWith("state-1234567890");
    expect(mocks.readStore).toHaveBeenCalledWith(STORE_KEY);
    expect(mocks.complete).toHaveBeenCalledWith(
      {
        storeKey: STORE_KEY,
        principal: "requester",
        serverName: "calendar",
        serverUrl: SERVER_URL,
      },
      expect.objectContaining({ kind: "http", url: SERVER_URL }),
      { code: "authorization-code", state: "state-1234567890" },
    );
  });

  it("completes the exact shared operator row used by the Control UI", async () => {
    mocks.readPending.mockReturnValue(OPERATOR_STORE_KEY);

    const result = await dispatch(
      "/oauth/mcp/callback?code=authorization-code&state=state-1234567890",
      { config: sharedCallbackConfig() },
    );

    expect(result.response.res.statusCode).toBe(200);
    expect(mocks.complete).toHaveBeenCalledWith(
      operatorMcpOAuthIdentity("calendar", SERVER_URL),
      expect.objectContaining({ kind: "http", url: SERVER_URL }),
      { code: "authorization-code", state: "state-1234567890" },
    );
  });

  it("rejects a callback whose state was consumed concurrently", async () => {
    mocks.complete.mockResolvedValue("expired");

    const result = await dispatch(
      "/oauth/mcp/callback?code=authorization-code&state=state-1234567890",
    );

    expect(result.response.res.statusCode).toBe(404);
    expect(result.response.getBody()).toContain("expired or was already used");
  });

  it("rejects unknown and replayed states with the same generic page", async () => {
    mocks.readPending.mockReturnValue(undefined);

    const unknown = await dispatch(
      "/oauth/mcp/callback?code=authorization-code&state=unknown-state",
    );
    const replay = await dispatch(
      "/oauth/mcp/callback?code=authorization-code&state=state-1234567890",
    );

    for (const result of [unknown, replay]) {
      expect(result.handled).toBe(true);
      expect(result.response.res.statusCode).toBe(404);
      expect(result.response.getBody()).toContain("expired or was already used");
    }
    expect(mocks.readStore).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("rejects correlation when the OAuth store no longer owns the state", async () => {
    mocks.readStore.mockReturnValue({
      ...pendingStore(),
      lastAuthorizationUrl: "https://accounts.example.com/authorize?state=replaced-state",
    });

    const result = await dispatch(
      "/oauth/mcp/callback?code=authorization-code&state=state-1234567890",
    );

    expect(result.response.res.statusCode).toBe(404);
    expect(result.response.getBody()).toContain("expired or was already used");
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("renders the retry path for provider errors without exchanging a code", async () => {
    const result = await dispatch(
      "/oauth/mcp/callback?error=access_denied&error_description=nope&state=state-1234567890",
    );

    expect(result.response.res.statusCode).toBe(400);
    expect(result.response.getBody()).toContain("Retry authorization in OpenClaw.");
    expect(result.response.getBody()).not.toContain("nope");
    expect(mocks.settle).toHaveBeenCalledWith(expect.objectContaining({ storeKey: STORE_KEY }), {
      state: "state-1234567890",
      category: "authorization-denied",
    });
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("settles a callback that omits the authorization code", async () => {
    const result = await dispatch("/oauth/mcp/callback?state=state-1234567890");

    expect(result.response.res.statusCode).toBe(400);
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.settle).toHaveBeenCalledWith(expect.objectContaining({ storeKey: STORE_KEY }), {
      state: "state-1234567890",
      category: "callback-invalid",
    });
  });

  it("fails generically when the configured server no longer owns the row", async () => {
    const result = await dispatch(
      "/oauth/mcp/callback?code=authorization-code&state=state-1234567890",
      { config: callbackConfig("renamed") },
    );

    expect(result.response.res.statusCode).toBe(404);
    expect(result.response.getBody()).toContain("expired or was already used");
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("does not expose authorization-code exchange failures", async () => {
    mocks.complete.mockRejectedValue(new Error("invalid_grant for secret-code"));

    const result = await dispatch("/oauth/mcp/callback?code=wrong-code&state=state-1234567890");

    expect(result.response.res.statusCode).toBe(400);
    expect(result.response.getBody()).toContain("Retry authorization in OpenClaw.");
    expect(result.response.getBody()).not.toContain("invalid_grant");
    expect(result.response.getBody()).not.toContain("wrong-code");
    expect(result.warn).toHaveBeenCalledOnce();
    expect(String(result.warn.mock.calls[0]?.[0])).not.toContain("secret-code");
    expect(mocks.settle).toHaveBeenCalledWith(expect.objectContaining({ storeKey: STORE_KEY }), {
      state: "state-1234567890",
      category: "exchange-failed",
      stateAlreadyClaimed: true,
    });
  });

  it("leaves other methods and paths unclaimed", async () => {
    const wrongMethod = await dispatch(
      "/oauth/mcp/callback?code=authorization-code&state=state-1234567890",
      { method: "POST" },
    );
    const wrongPath = await dispatch("/oauth/other?code=authorization-code&state=state-1234567890");

    expect(wrongMethod.handled).toBe(false);
    expect(wrongPath.handled).toBe(false);
    expect(mocks.readPending).not.toHaveBeenCalled();
  });

  it("bounds the callback query before reading durable state", async () => {
    const result = await dispatch(
      `/oauth/mcp/callback?code=${"x".repeat(8 * 1024)}&state=state-1234567890`,
    );

    expect(result.handled).toBe(true);
    expect(result.response.res.statusCode).toBe(400);
    expect(mocks.readPending).not.toHaveBeenCalled();
    expect(mocks.readStore).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });
});
