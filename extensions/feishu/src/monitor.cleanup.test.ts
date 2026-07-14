// Feishu tests cover monitor.cleanup plugin behavior.
import type { Server } from "node:http";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanupFeishuMonitorStateForTests } from "./monitor.cleanup.test-helpers.js";
import {
  botNames,
  botOpenIds,
  closeTrackedFeishuHttpServer,
  httpServers,
  setFeishuBotIdentityState,
  wsClients,
} from "./monitor.state.js";
import type { ResolvedFeishuAccount } from "./types.js";

const FEISHU_HTTP_SERVER_CLOSE_TIMEOUT_MS = 5_000;

const createFeishuWSClientMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuWSClient: createFeishuWSClientMock,
}));

import { monitorWebSocket } from "./monitor.transport.js";

type MockWsClient = {
  start: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

function createAccount(accountId: string): ResolvedFeishuAccount {
  return {
    accountId,
    enabled: true,
    configured: true,
    appId: `cli_${accountId}`,
    appSecret: `secret_${accountId}`, // pragma: allowlist secret
    domain: "feishu",
    config: {
      enabled: true,
      connectionMode: "websocket",
    },
  } as ResolvedFeishuAccount;
}

function createWsClient(): MockWsClient {
  return {
    start: vi.fn(),
    close: vi.fn(),
  };
}

function createHttpServerMock(): {
  server: Server;
  close: ReturnType<typeof vi.fn>;
  closeAllConnections: ReturnType<typeof vi.fn>;
  finishClose: (error?: Error) => void;
} {
  let closeCallback: ((err?: Error) => void) | undefined;
  const server = {} as Server;
  const close = vi.fn((callback?: (err?: Error) => void) => {
    closeCallback = callback;
    return server;
  });
  const closeAllConnections = vi.fn();
  server.close = close as unknown as Server["close"];
  server.closeAllConnections = closeAllConnections;
  return {
    server,
    close,
    closeAllConnections,
    finishClose: (error?: Error) => {
      if (!closeCallback) {
        throw new Error("expected HTTP server close callback");
      }
      closeCallback(error);
    },
  };
}

function firstRuntimeError(runtime: { error: ReturnType<typeof vi.fn> }): string {
  return String(runtime.error.mock.calls[0]?.[0] ?? "");
}

function firstWsCallbacks(): { onError?: (err: Error) => void } {
  const callbacks = createFeishuWSClientMock.mock.calls[0]?.[1];
  if (!callbacks || typeof callbacks !== "object") {
    throw new Error("expected Feishu websocket callbacks");
  }
  return callbacks as { onError?: (err: Error) => void };
}

afterEach(() => {
  vi.useRealTimers();
  cleanupFeishuMonitorStateForTests();
  vi.clearAllMocks();
});

afterAll(() => {
  vi.doUnmock("./client.js");
  vi.resetModules();
});

describe("feishu websocket cleanup", () => {
  it("closes the websocket client when the monitor aborts", async () => {
    const wsClient = createWsClient();
    createFeishuWSClientMock.mockReturnValue(wsClient);

    const abortController = new AbortController();
    const accountId = "alpha";

    botOpenIds.set(accountId, "ou_alpha");
    botNames.set(accountId, "Alpha");

    const monitorPromise = monitorWebSocket({
      account: createAccount(accountId),
      accountId,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
      abortSignal: abortController.signal,
      eventDispatcher: {} as never,
    });

    await vi.waitFor(() => {
      expect(wsClient.start).toHaveBeenCalledTimes(1);
      expect(wsClients.get(accountId)).toBe(wsClient);
    });

    abortController.abort();
    await monitorPromise;

    expect(wsClient.close).toHaveBeenCalledTimes(1);
    expect(wsClients.has(accountId)).toBe(false);
    expect(botOpenIds.has(accountId)).toBe(false);
    expect(botNames.has(accountId)).toBe(false);
  });

  it("retries with backoff after websocket start rejects", async () => {
    vi.useFakeTimers();
    const failedClient = createWsClient();
    failedClient.start.mockRejectedValueOnce(
      new Error("connect failed\nAuthorization: Bearer token_abc appSecret=secret_abc"),
    );
    const recoveredClient = createWsClient();
    createFeishuWSClientMock
      .mockResolvedValueOnce(failedClient)
      .mockResolvedValueOnce(recoveredClient);

    const abortController = new AbortController();
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    const accountId = "retry";

    const monitorPromise = monitorWebSocket({
      account: createAccount(accountId),
      accountId,
      runtime,
      abortSignal: abortController.signal,
      eventDispatcher: {} as never,
    });

    await vi.waitFor(() => {
      expect(failedClient.start).toHaveBeenCalledTimes(1);
      expect(failedClient.close).toHaveBeenCalledTimes(1);
      expect(wsClients.has(accountId)).toBe(false);
    });

    await vi.advanceTimersByTimeAsync(1_000);

    await vi.waitFor(() => {
      expect(recoveredClient.start).toHaveBeenCalledTimes(1);
      expect(wsClients.get(accountId)).toBe(recoveredClient);
    });

    abortController.abort();
    await monitorPromise;

    expect(createFeishuWSClientMock).toHaveBeenCalledTimes(2);
    expect(recoveredClient.close).toHaveBeenCalledTimes(1);
    expect(runtime.error).toHaveBeenCalledTimes(1);
    const errorMessage = firstRuntimeError(runtime);
    expect(errorMessage).toContain("WebSocket start failed, retrying in 1000ms");
    expect(errorMessage).not.toContain("\n");
    expect(errorMessage).not.toContain("token_abc");
    expect(errorMessage).not.toContain("secret_abc");
    expect(errorMessage).toContain("Authorization: Bearer [redacted]");
    expect(errorMessage).toContain("appSecret=[redacted]");
  });

  it("recreates the websocket client after sdk reconnect exhaustion", async () => {
    vi.useFakeTimers();
    const exhaustedClient = createWsClient();
    const recoveredClient = createWsClient();
    createFeishuWSClientMock
      .mockResolvedValueOnce(exhaustedClient)
      .mockResolvedValueOnce(recoveredClient);

    const abortController = new AbortController();
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    const accountId = "exhausted";
    botOpenIds.set(accountId, "ou_exhausted");
    botNames.set(accountId, "Exhausted");

    const monitorPromise = monitorWebSocket({
      account: createAccount(accountId),
      accountId,
      runtime,
      abortSignal: abortController.signal,
      eventDispatcher: {} as never,
    });

    await vi.waitFor(() => {
      expect(exhaustedClient.start).toHaveBeenCalledTimes(1);
      expect(wsClients.get(accountId)).toBe(exhaustedClient);
    });

    firstWsCallbacks().onError?.(
      new Error("WebSocket reconnect exhausted after 3 attempts\nBearer token_abc"),
    );

    await vi.waitFor(() => {
      expect(exhaustedClient.close).toHaveBeenCalledTimes(1);
      expect(wsClients.has(accountId)).toBe(false);
    });
    expect(botOpenIds.get(accountId)).toBe("ou_exhausted");
    expect(botNames.get(accountId)).toBe("Exhausted");

    await vi.advanceTimersByTimeAsync(1_000);

    await vi.waitFor(() => {
      expect(recoveredClient.start).toHaveBeenCalledTimes(1);
      expect(wsClients.get(accountId)).toBe(recoveredClient);
    });

    abortController.abort();
    await monitorPromise;

    expect(createFeishuWSClientMock).toHaveBeenCalledTimes(2);
    expect(recoveredClient.close).toHaveBeenCalledTimes(1);
    expect(botOpenIds.has(accountId)).toBe(false);
    expect(botNames.has(accountId)).toBe(false);
    const errorMessage = firstRuntimeError(runtime);
    expect(errorMessage).toContain("WebSocket connection ended, recreating client in 1000ms");
    expect(errorMessage).toContain("Bearer [redacted]");
    expect(errorMessage).not.toContain("\n");
    expect(errorMessage).not.toContain("token_abc");
  });

  it("keeps the websocket client alive after recoverable sdk callback errors", async () => {
    vi.useFakeTimers();
    const wsClient = createWsClient();
    createFeishuWSClientMock.mockResolvedValueOnce(wsClient);

    const abortController = new AbortController();
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    const accountId = "recoverable-callback";

    const monitorPromise = monitorWebSocket({
      account: createAccount(accountId),
      accountId,
      runtime,
      abortSignal: abortController.signal,
      eventDispatcher: {} as never,
    });

    await vi.waitFor(() => {
      expect(wsClient.start).toHaveBeenCalledTimes(1);
      expect(wsClients.get(accountId)).toBe(wsClient);
    });

    firstWsCallbacks().onError?.(new Error("temporary callback failure\nBearer token_abc"));

    await vi.advanceTimersByTimeAsync(1_000);

    expect(createFeishuWSClientMock).toHaveBeenCalledTimes(1);
    expect(wsClient.close).not.toHaveBeenCalled();
    expect(wsClients.get(accountId)).toBe(wsClient);
    const errorMessage = firstRuntimeError(runtime);
    expect(errorMessage).toContain("WebSocket SDK reported recoverable error");
    expect(errorMessage).toContain("Bearer [redacted]");
    expect(errorMessage).not.toContain("\n");
    expect(errorMessage).not.toContain("token_abc");

    abortController.abort();
    await monitorPromise;

    expect(createFeishuWSClientMock).toHaveBeenCalledTimes(1);
    expect(wsClient.close).toHaveBeenCalledTimes(1);
  });

  it("clears identity without recreating a websocket when aborted during reconnect backoff", async () => {
    vi.useFakeTimers();
    const exhaustedClient = createWsClient();
    createFeishuWSClientMock.mockResolvedValueOnce(exhaustedClient);

    const abortController = new AbortController();
    const accountId = "abort-backoff";
    botOpenIds.set(accountId, "ou_abort");
    botNames.set(accountId, "Abort");

    const monitorPromise = monitorWebSocket({
      account: createAccount(accountId),
      accountId,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
      abortSignal: abortController.signal,
      eventDispatcher: {} as never,
    });

    await vi.waitFor(() => {
      expect(exhaustedClient.start).toHaveBeenCalledTimes(1);
    });

    firstWsCallbacks().onError?.(new Error("WebSocket reconnect exhausted after 3 attempts"));

    await vi.waitFor(() => {
      expect(exhaustedClient.close).toHaveBeenCalledTimes(1);
    });

    abortController.abort();
    await monitorPromise;

    expect(createFeishuWSClientMock).toHaveBeenCalledTimes(1);
    expect(wsClients.has(accountId)).toBe(false);
    expect(botOpenIds.has(accountId)).toBe(false);
    expect(botNames.has(accountId)).toBe(false);
  });

  it("redacts websocket close errors during abort cleanup", async () => {
    const wsClient = createWsClient();
    wsClient.close.mockImplementationOnce(() => {
      throw new Error("close failed\naccess_token=secret_token");
    });
    createFeishuWSClientMock.mockReturnValue(wsClient);

    const abortController = new AbortController();
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    const monitorPromise = monitorWebSocket({
      account: createAccount("close-error"),
      accountId: "close-error",
      runtime,
      abortSignal: abortController.signal,
      eventDispatcher: {} as never,
    });

    await vi.waitFor(() => {
      expect(wsClient.start).toHaveBeenCalledTimes(1);
    });

    abortController.abort();
    await monitorPromise;

    const errorMessage = firstRuntimeError(runtime);
    expect(errorMessage).toContain("error closing WebSocket client");
    expect(errorMessage).toContain("access_token=[redacted]");
    expect(errorMessage).not.toContain("\n");
    expect(errorMessage).not.toContain("secret_token");
  });

  it("keeps websocket close error logs UTF-16 safe at the truncation boundary", async () => {
    const wsClient = createWsClient();
    wsClient.close.mockImplementationOnce(() => {
      throw new Error(`${"x".repeat(499)}😀tail`);
    });
    createFeishuWSClientMock.mockReturnValue(wsClient);

    const abortController = new AbortController();
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    const monitorPromise = monitorWebSocket({
      account: createAccount("close-error-utf16"),
      accountId: "close-error-utf16",
      runtime,
      abortSignal: abortController.signal,
      eventDispatcher: {} as never,
    });

    await vi.waitFor(() => {
      expect(wsClient.start).toHaveBeenCalledTimes(1);
    });
    abortController.abort();
    await monitorPromise;

    expect(firstRuntimeError(runtime)).toBe(
      `feishu[close-error-utf16]: error closing WebSocket client: ${"x".repeat(499)}...`,
    );
  });

  it("keeps targeted HTTP server state until close completes", async () => {
    const { server, close, closeAllConnections, finishClose } = createHttpServerMock();

    httpServers.set("alpha", server);
    botOpenIds.set("alpha", "ou_alpha");
    botNames.set("alpha", "Alpha");

    const stopPromise = closeTrackedFeishuHttpServer("alpha", server);
    await Promise.resolve();

    expect(close).toHaveBeenCalledTimes(1);
    expect(httpServers.get("alpha")).toBe(server);
    expect(botOpenIds.get("alpha")).toBe("ou_alpha");
    expect(botNames.get("alpha")).toBe("Alpha");

    finishClose();
    await stopPromise;

    expect(closeAllConnections).not.toHaveBeenCalled();
    expect(httpServers.has("alpha")).toBe(false);
    expect(botOpenIds.has("alpha")).toBe(false);
    expect(botNames.has("alpha")).toBe(false);
  });

  it("preserves replacement HTTP state after delayed targeted cleanup", async () => {
    const oldServer = createHttpServerMock();
    const replacementServer = createHttpServerMock();

    httpServers.set("alpha", oldServer.server);
    setFeishuBotIdentityState("alpha", { botOpenId: "ou_old", botName: "Old" });

    const stopPromise = closeTrackedFeishuHttpServer("alpha", oldServer.server);
    await Promise.resolve();

    setFeishuBotIdentityState("alpha", { botOpenId: "ou_new", botName: "New" });
    httpServers.set("alpha", replacementServer.server);

    oldServer.finishClose();
    await stopPromise;

    expect(httpServers.get("alpha")).toBe(replacementServer.server);
    expect(botOpenIds.get("alpha")).toBe("ou_new");
    expect(botNames.get("alpha")).toBe("New");

    const cleanupPromise = closeTrackedFeishuHttpServer("alpha", replacementServer.server);
    await Promise.resolve();
    replacementServer.finishClose();
    await cleanupPromise;
  });

  it("preserves replacement identity written before the replacement HTTP server is tracked", async () => {
    const oldServer = createHttpServerMock();

    httpServers.set("alpha", oldServer.server);
    setFeishuBotIdentityState("alpha", { botOpenId: "ou_old", botName: "Old" });

    const stopPromise = closeTrackedFeishuHttpServer("alpha", oldServer.server);
    await Promise.resolve();

    setFeishuBotIdentityState("alpha", { botOpenId: "ou_new", botName: "New" });

    oldServer.finishClose();
    await stopPromise;

    expect(httpServers.has("alpha")).toBe(false);
    expect(botOpenIds.get("alpha")).toBe("ou_new");
    expect(botNames.get("alpha")).toBe("New");
  });

  it("forces targeted HTTP server cleanup after the close timeout", async () => {
    vi.useFakeTimers();
    const { server, close, closeAllConnections } = createHttpServerMock();

    httpServers.set("alpha", server);
    botOpenIds.set("alpha", "ou_alpha");
    botNames.set("alpha", "Alpha");

    const stopPromise = closeTrackedFeishuHttpServer("alpha", server);
    await Promise.resolve();

    expect(close).toHaveBeenCalledTimes(1);
    expect(httpServers.get("alpha")).toBe(server);

    await vi.advanceTimersByTimeAsync(FEISHU_HTTP_SERVER_CLOSE_TIMEOUT_MS - 1);
    expect(closeAllConnections).not.toHaveBeenCalled();
    expect(httpServers.get("alpha")).toBe(server);

    await vi.advanceTimersByTimeAsync(1);
    await stopPromise;

    expect(closeAllConnections).toHaveBeenCalledTimes(1);
    expect(httpServers.has("alpha")).toBe(false);
    expect(botOpenIds.has("alpha")).toBe(false);
    expect(botNames.has("alpha")).toBe(false);
  });
});
