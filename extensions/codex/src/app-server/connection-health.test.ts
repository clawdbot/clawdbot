import type { OpenClawPluginServiceContext } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import { createCodexAppServerConnectionHealthService } from "./connection-health.js";

const sharedClientMocks = vi.hoisted(() => ({
  getLeasedSharedCodexAppServerClient: vi.fn(),
  releaseLeasedSharedCodexAppServerClient: vi.fn(),
}));

vi.mock("./shared-client.js", () => sharedClientMocks);

describe("Codex remote WebSocket connection health", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("opens the remote app-server before the first model request", async () => {
    const client = createClient();
    sharedClientMocks.getLeasedSharedCodexAppServerClient.mockResolvedValueOnce(client.client);
    const ctx = createServiceContext();
    const service = createCodexAppServerConnectionHealthService({
      getPluginConfig: () => ({
        appServer: { transport: "websocket", url: "ws://127.0.0.1:39175" },
      }),
      getRuntimeConfig: () => ctx.config,
    });

    await service.start(ctx);

    await vi.waitFor(() => {
      expect(sharedClientMocks.getLeasedSharedCodexAppServerClient).toHaveBeenCalledOnce();
      expect(client.addCloseHandler).toHaveBeenCalledOnce();
    });
    expect(client.request).not.toHaveBeenCalled();

    await service.stop?.(ctx);

    expect(sharedClientMocks.releaseLeasedSharedCodexAppServerClient).toHaveBeenCalledWith(
      client.client,
    );
  });

  it("reconnects after the shared remote app-server connection closes", async () => {
    const first = createClient();
    const second = createClient();
    sharedClientMocks.getLeasedSharedCodexAppServerClient
      .mockResolvedValueOnce(first.client)
      .mockResolvedValueOnce(second.client);
    const ctx = createServiceContext();
    const service = createCodexAppServerConnectionHealthService({
      getPluginConfig: () => ({
        appServer: { transport: "websocket", url: "ws://127.0.0.1:39175" },
      }),
      getRuntimeConfig: () => ctx.config,
    });

    await service.start(ctx);
    await vi.waitFor(() => expect(first.addCloseHandler).toHaveBeenCalledOnce());

    first.close();

    await vi.waitFor(
      () => {
        expect(sharedClientMocks.getLeasedSharedCodexAppServerClient).toHaveBeenCalledTimes(2);
        expect(second.addCloseHandler).toHaveBeenCalledOnce();
      },
      { timeout: 3_000 },
    );
    expect(first.request).not.toHaveBeenCalled();
    expect(second.request).not.toHaveBeenCalled();

    await service.stop?.(ctx);

    expect(sharedClientMocks.releaseLeasedSharedCodexAppServerClient).toHaveBeenCalledTimes(2);
  });

  it("retries a transient remote connection failure without starting a model", async () => {
    const client = createClient();
    sharedClientMocks.getLeasedSharedCodexAppServerClient
      .mockRejectedValueOnce(new Error("Opening handshake has timed out"))
      .mockResolvedValueOnce(client.client);
    const ctx = createServiceContext();
    const service = createCodexAppServerConnectionHealthService({
      getPluginConfig: () => ({
        appServer: { transport: "websocket", url: "ws://127.0.0.1:39175" },
      }),
      getRuntimeConfig: () => ctx.config,
    });

    await service.start(ctx);

    await vi.waitFor(
      () => {
        expect(sharedClientMocks.getLeasedSharedCodexAppServerClient).toHaveBeenCalledTimes(2);
        expect(client.addCloseHandler).toHaveBeenCalledOnce();
      },
      { timeout: 3_000 },
    );
    expect(client.request).not.toHaveBeenCalled();

    await service.stop?.(ctx);

    expect(sharedClientMocks.releaseLeasedSharedCodexAppServerClient).toHaveBeenCalledOnce();
  });

  it.each([401, 403])("does not retry an HTTP %i authentication failure", async (statusCode) => {
    sharedClientMocks.getLeasedSharedCodexAppServerClient.mockRejectedValueOnce(
      new Error(`Unexpected server response: ${statusCode}`),
    );
    const ctx = createServiceContext();
    const service = createCodexAppServerConnectionHealthService({
      getPluginConfig: () => ({
        appServer: { transport: "websocket", url: "ws://127.0.0.1:39175" },
      }),
      getRuntimeConfig: () => ctx.config,
    });

    await service.start(ctx);

    await vi.waitFor(() => {
      expect(ctx.logger.error).toHaveBeenCalledWith(
        expect.stringContaining(`Unexpected server response: ${statusCode}`),
      );
    });
    expect(sharedClientMocks.getLeasedSharedCodexAppServerClient).toHaveBeenCalledOnce();

    await service.stop?.(ctx);

    expect(sharedClientMocks.releaseLeasedSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("does not retry an invalid remote app-server configuration", async () => {
    const ctx = createServiceContext();
    const service = createCodexAppServerConnectionHealthService({
      getPluginConfig: () => ({ appServer: { transport: "websocket" } }),
      getRuntimeConfig: () => ctx.config,
    });

    await service.start(ctx);

    await vi.waitFor(() => {
      expect(ctx.logger.error).toHaveBeenCalledWith(
        expect.stringContaining("configuration is invalid"),
      );
    });
    expect(sharedClientMocks.getLeasedSharedCodexAppServerClient).not.toHaveBeenCalled();

    await service.stop?.(ctx);
  });

  it("does not connect or start a model for local transports", async () => {
    const ctx = createServiceContext();
    const service = createCodexAppServerConnectionHealthService({
      getPluginConfig: () => ({ appServer: { transport: "stdio" } }),
      getRuntimeConfig: () => ctx.config,
    });

    await service.start(ctx);
    await service.stop?.(ctx);

    expect(sharedClientMocks.getLeasedSharedCodexAppServerClient).not.toHaveBeenCalled();
  });
});

function createClient() {
  const handlers = new Set<(client: CodexAppServerClient) => void>();
  const request = vi.fn();
  const addCloseHandler = vi.fn((handler: (client: CodexAppServerClient) => void) => {
    handlers.add(handler);
    return () => handlers.delete(handler);
  });
  const client = { addCloseHandler, request } as unknown as CodexAppServerClient;

  return {
    client,
    request,
    addCloseHandler,
    close() {
      for (const handler of handlers) {
        handler(client);
      }
    },
  };
}

function createServiceContext(): OpenClawPluginServiceContext {
  return {
    config: {},
    stateDir: "/tmp/openclaw-codex-connection-health-test",
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
}
