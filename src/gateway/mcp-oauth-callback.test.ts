import { beforeEach, describe, expect, it, vi } from "vitest";
import { requesterMcpOAuthStoreKeyPrefix } from "../agents/mcp-oauth-identity.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  complete: vi.fn(),
  readPending: vi.fn(),
  readStore: vi.fn(),
}));

vi.mock("../agents/mcp-oauth.js", () => ({
  completeOAuthCallback: mocks.complete,
}));
vi.mock("../agents/mcp-oauth-store.js", () => ({
  readMcpOAuthPendingAuthorization: mocks.readPending,
  readMcpOAuthStore: mocks.readStore,
}));

import { handleMcpOAuthCallback } from "./mcp-oauth-callback.js";
import { createRequest, createResponse } from "./server-http.test-harness.js";

const SERVER_URL = "https://calendar.example.com/mcp";
const STORE_KEY = `${requesterMcpOAuthStoreKeyPrefix("calendar", SERVER_URL)}fedcba9876543210`;
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

function pendingStore() {
  return {
    codeVerifier: "verifier",
    lastAuthorizationUrl: AUTHORIZATION_URL,
    redirectUrl: "https://gateway.example.com/oauth/mcp/callback",
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
  mocks.readPending.mockReset().mockReturnValue(STORE_KEY);
  mocks.readStore.mockReset().mockReturnValue(pendingStore());
});

describe("Gateway MCP OAuth callback", () => {
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
    expect(result.response.getBody()).toContain("Ask the bot to connect again.");
    expect(result.response.getBody()).not.toContain("nope");
    expect(mocks.complete).not.toHaveBeenCalled();
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
    expect(result.response.getBody()).toContain("Ask the bot to connect again.");
    expect(result.response.getBody()).not.toContain("invalid_grant");
    expect(result.response.getBody()).not.toContain("wrong-code");
    expect(result.warn).toHaveBeenCalledOnce();
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
