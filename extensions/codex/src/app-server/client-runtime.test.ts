import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import { createClientHarness } from "./test-support.js";

const mocks = vi.hoisted(() => ({
  refreshAuth: vi.fn(async () => ({ accessToken: "refreshed", chatgptAccountId: "account" })),
  mergeRateLimitUpdate: vi.fn(),
}));

vi.mock("./auth-bridge.js", () => ({
  refreshCodexAppServerAuthTokens: mocks.refreshAuth,
}));

vi.mock("./rate-limit-cache.js", () => ({
  mergeCodexRateLimitsUpdate: mocks.mergeRateLimitUpdate,
}));

const { ensureCodexAppServerClientRuntime } = await import("./client-runtime.js");

describe("Codex app-server client runtime", () => {
  const clients: CodexAppServerClient[] = [];

  afterEach(() => {
    for (const client of clients) {
      client.close();
    }
    clients.length = 0;
    mocks.refreshAuth.mockClear();
    mocks.mergeRateLimitUpdate.mockClear();
  });

  it("installs shared handlers once per physical client", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);
    const context = {
      agentDir: "/tmp/agent",
      authProfileId: "openai:default",
      config: {},
    };
    const updatedContext = {
      ...context,
      authProfileStore: { version: 1 as const, profiles: {} },
      config: { models: { mode: "merge" as const } },
    };
    const addNotificationHandler = vi.spyOn(harness.client, "addNotificationHandler");
    const addRequestHandler = vi.spyOn(harness.client, "addRequestHandler");
    const addCloseHandler = vi.spyOn(harness.client, "addCloseHandler");

    ensureCodexAppServerClientRuntime(harness.client, context);
    ensureCodexAppServerClientRuntime(harness.client, updatedContext);

    expect(addNotificationHandler).toHaveBeenCalledTimes(1);
    expect(addRequestHandler).toHaveBeenCalledTimes(1);
    expect(addCloseHandler).not.toHaveBeenCalled();
    harness.send({
      method: "account/rateLimits/updated",
      params: { rateLimits: { primary: { usedPercent: 12 } } },
    });
    harness.send({
      id: "refresh-1",
      method: "account/chatgptAuthTokens/refresh",
      params: { reason: "expired" },
    });

    await vi.waitFor(() => expect(mocks.mergeRateLimitUpdate).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(mocks.refreshAuth).toHaveBeenCalledTimes(1));
    expect(mocks.refreshAuth).toHaveBeenCalledWith(updatedContext);
    expect(mocks.mergeRateLimitUpdate).toHaveBeenCalledWith(harness.client, {
      rateLimits: { primary: { usedPercent: 12 } },
    });
    await vi.waitFor(() =>
      expect(harness.writes.map((line) => JSON.parse(line) as unknown)).toContainEqual({
        id: "refresh-1",
        result: { accessToken: "refreshed", chatgptAccountId: "account" },
      }),
    );
  });

  it("rejects ChatGPT refresh on a prepared API-key client", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);
    ensureCodexAppServerClientRuntime(harness.client, {
      agentDir: "/tmp/agent",
      authMode: "prepared-api-key",
    });

    harness.send({
      id: "refresh-api-key",
      method: "account/chatgptAuthTokens/refresh",
      params: { reason: "expired" },
    });

    await vi.waitFor(() => expect(harness.writes.length).toBeGreaterThan(0));
    expect(mocks.refreshAuth).not.toHaveBeenCalled();
    expect(JSON.parse(harness.writes.at(-1) ?? "{}")).toMatchObject({
      id: "refresh-api-key",
      error: {
        message: "ChatGPT token refresh is unavailable for prepared Codex API-key auth.",
      },
    });
  });
});
