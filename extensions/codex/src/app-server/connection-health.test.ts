import type { OpenClawPluginServiceContext } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerRpcError, type CodexAppServerClient } from "./client.js";
import { createCodexAppServerConnectionHealthService } from "./connection-health.js";

const sharedClientMocks = vi.hoisted(() => ({
  getLeasedSharedCodexAppServerClient: vi.fn(),
  releaseLeasedSharedCodexAppServerClient: vi.fn(),
}));
const diagnosticMocks = vi.hoisted(() => ({ emitTrustedDiagnosticEvent: vi.fn() }));

vi.mock("./shared-client.js", () => sharedClientMocks);
vi.mock("openclaw/plugin-sdk/diagnostic-runtime", () => diagnosticMocks);

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
    expect(client.request).toHaveBeenCalledWith(
      "account/read",
      { refreshToken: false },
      expect.objectContaining({ timeoutMs: 10_000, signal: expect.any(AbortSignal) }),
    );

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
    expect(first.request).toHaveBeenCalled();
    expect(second.request).toHaveBeenCalled();

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
    expect(client.request).toHaveBeenCalled();

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

    expect(ctx.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("configuration is invalid"),
    );
    expect(sharedClientMocks.getLeasedSharedCodexAppServerClient).not.toHaveBeenCalled();

    await vi.waitFor(() => {
      expect(diagnosticMocks.emitTrustedDiagnosticEvent).toHaveBeenLastCalledWith({
        type: "model.auth.clear",
      });
    });

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

  it("actively proves a ChatGPT account ready without starting a model", async () => {
    const client = createClient(async (method) =>
      method === "account/read"
        ? { account: { type: "chatgpt" }, requiresOpenaiAuth: true }
        : { rateLimits: {} },
    );
    sharedClientMocks.getLeasedSharedCodexAppServerClient.mockResolvedValueOnce(client.client);
    const ctx = createServiceContext();
    const service = createService(ctx);

    await service.start(ctx);
    await vi.waitFor(() => {
      expect(diagnosticMocks.emitTrustedDiagnosticEvent).toHaveBeenCalledWith({
        type: "model.auth.state",
        state: "ready",
        authMode: "subscription",
        reason: "ready",
      });
    });
    expect(client.request).toHaveBeenNthCalledWith(
      1,
      "account/read",
      { refreshToken: false },
      expect.anything(),
    );
    expect(client.request).toHaveBeenNthCalledWith(
      2,
      "account/rateLimits/read",
      undefined,
      expect.anything(),
    );
    await service.stop?.(ctx);
  });

  it("reports a missing ChatGPT account before user traffic", async () => {
    const client = createClient(async () => ({ account: null, requiresOpenaiAuth: true }));
    sharedClientMocks.getLeasedSharedCodexAppServerClient.mockResolvedValueOnce(client.client);
    const ctx = createServiceContext();
    const service = createService(ctx);

    await service.start(ctx);
    await vi.waitFor(() => {
      expect(diagnosticMocks.emitTrustedDiagnosticEvent).toHaveBeenCalledWith({
        type: "model.auth.state",
        state: "not_ready",
        authMode: "subscription",
        reason: "missing_account",
      });
    });
    expect(client.request).toHaveBeenCalledTimes(1);
    await service.stop?.(ctx);
  });

  it("does not mark non-OpenAI routes as logged out without an active proof", async () => {
    const client = createClient(async () => ({ account: null, requiresOpenaiAuth: false }));
    sharedClientMocks.getLeasedSharedCodexAppServerClient.mockResolvedValueOnce(client.client);
    const ctx = createServiceContext();
    const service = createService(ctx);

    await service.start(ctx);
    await vi.waitFor(() => {
      expect(diagnosticMocks.emitTrustedDiagnosticEvent).toHaveBeenCalledWith({
        type: "model.auth.state",
        state: "unknown",
        authMode: "unknown",
        reason: "unsupported_auth_mode",
      });
    });
    expect(client.request).toHaveBeenCalledTimes(1);
    await service.stop?.(ctx);
  });

  it("reports route mismatches without spending the wrong auth mode", async () => {
    const cases = [
      {
        account: { type: "apiKey" },
        requiresOpenaiAuth: true,
        expectedAuthMode: "subscription",
      },
      {
        account: { type: "chatgpt" },
        requiresOpenaiAuth: false,
        expectedAuthMode: "api_key",
      },
    ] as const;

    for (const testCase of cases) {
      diagnosticMocks.emitTrustedDiagnosticEvent.mockClear();
      const client = createClient(async () => ({
        account: testCase.account,
        requiresOpenaiAuth: testCase.requiresOpenaiAuth,
      }));
      sharedClientMocks.getLeasedSharedCodexAppServerClient.mockResolvedValueOnce(client.client);
      const ctx = createServiceContext();
      const service = createService(ctx);

      await service.start(ctx);
      await vi.waitFor(() => {
        expect(diagnosticMocks.emitTrustedDiagnosticEvent).toHaveBeenCalledWith({
          type: "model.auth.state",
          state: "not_ready",
          authMode: testCase.expectedAuthMode,
          reason: "route_mismatch",
        });
      });
      expect(client.request).toHaveBeenCalledTimes(1);
      await service.stop?.(ctx);
    }
  });

  it("uses the packaged RPC error shape to classify only definite auth failures", async () => {
    const fixtures = [
      {
        error: new CodexAppServerRpcError(
          {
            code: -32603,
            message: "request failed",
            data: { error: { statusCode: 401, action: "relogin" } },
          },
          "account/rateLimits/read",
        ),
        expectedState: "not_ready",
        expectedReason: "unauthenticated",
      },
      {
        error: new CodexAppServerRpcError(
          { code: -32603, message: "request failed", data: { statusCode: 503 } },
          "account/rateLimits/read",
        ),
        expectedState: "unknown",
        expectedReason: "probe_error",
      },
    ] as const;

    for (const fixture of fixtures) {
      diagnosticMocks.emitTrustedDiagnosticEvent.mockClear();
      const client = createClient(async (method) => {
        if (method === "account/read") {
          return { account: { type: "chatgpt" }, requiresOpenaiAuth: true };
        }
        throw fixture.error;
      });
      sharedClientMocks.getLeasedSharedCodexAppServerClient.mockResolvedValueOnce(client.client);
      const ctx = createServiceContext();
      const service = createService(ctx);
      await service.start(ctx);
      await vi.waitFor(() =>
        expect(diagnosticMocks.emitTrustedDiagnosticEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "model.auth.state",
            state: fixture.expectedState,
            reason: fixture.expectedReason,
          }),
        ),
      );
      await service.stop?.(ctx);
    }
  });

  it("repeats serially and reports recovery", async () => {
    let reads = 0;
    const client = createClient(async (method) => {
      if (method === "account/read") {
        reads += 1;
        return reads === 1
          ? { account: null, requiresOpenaiAuth: true }
          : { account: { type: "chatgpt" }, requiresOpenaiAuth: true };
      }
      return { rateLimits: {} };
    });
    sharedClientMocks.getLeasedSharedCodexAppServerClient.mockResolvedValueOnce(client.client);
    const ctx = createServiceContext();
    const service = createService(ctx, { modelAuthProbeIntervalMs: 5, random: () => 0.5 });

    await service.start(ctx);
    await vi.waitFor(() => {
      expect(diagnosticMocks.emitTrustedDiagnosticEvent).toHaveBeenCalledWith(
        expect.objectContaining({ state: "not_ready", reason: "missing_account" }),
      );
      expect(diagnosticMocks.emitTrustedDiagnosticEvent).toHaveBeenCalledWith(
        expect.objectContaining({ state: "ready", reason: "ready" }),
      );
    });
    await service.stop?.(ctx);
  });

  it("does not overlap probes and aborts the in-flight request on stop", async () => {
    let activeRequests = 0;
    let maxActiveRequests = 0;
    const client = createClient(
      async (_method, _params, requestOptions) =>
        await new Promise((_resolve, reject) => {
          activeRequests += 1;
          maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
          requestOptions?.signal?.addEventListener(
            "abort",
            () => {
              activeRequests -= 1;
              reject(new Error("test request aborted"));
            },
            { once: true },
          );
        }),
    );
    sharedClientMocks.getLeasedSharedCodexAppServerClient.mockResolvedValueOnce(client.client);
    const ctx = createServiceContext();
    const service = createService(ctx, { modelAuthProbeIntervalMs: 1, random: () => 0.5 });

    await service.start(ctx);
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledOnce());
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    expect(client.request).toHaveBeenCalledOnce();

    diagnosticMocks.emitTrustedDiagnosticEvent.mockClear();
    await service.stop?.(ctx);
    expect(maxActiveRequests).toBe(1);
    expect(activeRequests).toBe(0);
    expect(diagnosticMocks.emitTrustedDiagnosticEvent).toHaveBeenCalledOnce();
    expect(diagnosticMocks.emitTrustedDiagnosticEvent).toHaveBeenLastCalledWith({
      type: "model.auth.clear",
    });
  });

  it("clears auth state on stop and repopulates it after restart", async () => {
    const first = createClient(async (method) =>
      method === "account/read"
        ? { account: { type: "chatgpt" }, requiresOpenaiAuth: true }
        : { rateLimits: {} },
    );
    const second = createClient(async (method) =>
      method === "account/read"
        ? { account: { type: "chatgpt" }, requiresOpenaiAuth: true }
        : { rateLimits: {} },
    );
    sharedClientMocks.getLeasedSharedCodexAppServerClient
      .mockResolvedValueOnce(first.client)
      .mockResolvedValueOnce(second.client);
    const ctx = createServiceContext();
    const service = createService(ctx);

    await service.start(ctx);
    await vi.waitFor(() =>
      expect(diagnosticMocks.emitTrustedDiagnosticEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "model.auth.state", state: "ready" }),
      ),
    );
    await service.stop?.(ctx);
    expect(diagnosticMocks.emitTrustedDiagnosticEvent).toHaveBeenLastCalledWith({
      type: "model.auth.clear",
    });

    diagnosticMocks.emitTrustedDiagnosticEvent.mockClear();
    await service.start(ctx);
    await vi.waitFor(() =>
      expect(diagnosticMocks.emitTrustedDiagnosticEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "model.auth.state", state: "ready" }),
      ),
    );
    expect(diagnosticMocks.emitTrustedDiagnosticEvent).not.toHaveBeenCalledWith({
      type: "model.auth.clear",
    });
    await service.stop?.(ctx);
  });
});

function createService(
  ctx: OpenClawPluginServiceContext,
  testOptions: { modelAuthProbeIntervalMs?: number; random?: () => number } = {},
) {
  return createCodexAppServerConnectionHealthService({
    getPluginConfig: () => ({
      appServer: { transport: "websocket", url: "ws://127.0.0.1:39175" },
    }),
    getRuntimeConfig: () => ctx.config,
    ...testOptions,
  });
}

function createClient(
  requestImpl: (
    method: string,
    params?: unknown,
    requestOptions?: { timeoutMs?: number; signal?: AbortSignal },
  ) => Promise<unknown> = async () => ({ account: null }),
) {
  const handlers = new Set<(client: CodexAppServerClient) => void>();
  const request = vi.fn(requestImpl);
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
