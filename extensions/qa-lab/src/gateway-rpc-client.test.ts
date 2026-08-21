// Qa Lab tests cover gateway rpc client plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type GatewayRequestOptions = {
  expectFinal?: boolean;
  onSent?: () => void;
  timeoutMs?: number;
};

type GatewayReconnectPausedInfo = {
  code: number;
  detailCode?: string;
  reason: string;
};

const gatewayRpcMock = vi.hoisted(() => {
  const request = vi.fn(
    async (_method: string, _params: unknown, _options: GatewayRequestOptions) => ({ ok: true }),
  );
  const stopAndWait = vi.fn(async () => {});
  const clients: Array<{ options: Record<string, unknown> }> = [];
  class GatewayClient {
    options: Record<string, unknown>;
    request = request;
    stopAndWait = stopAndWait;

    constructor(options: Record<string, unknown>) {
      this.options = options;
      clients.push(this);
    }
  }
  const connectImmediately = async (client: GatewayClient) => {
    (client.options.onHelloOk as () => void)();
    return { ready: true, aborted: false };
  };
  const startGatewayClientWhenEventLoopReady = vi.fn(connectImmediately);
  return {
    GatewayClient,
    clients,
    request,
    startGatewayClientWhenEventLoopReady,
    stopAndWait,
    reset() {
      clients.length = 0;
      request.mockReset().mockResolvedValue({ ok: true });
      stopAndWait.mockReset().mockResolvedValue(undefined);
      startGatewayClientWhenEventLoopReady.mockReset().mockImplementation(connectImmediately);
    },
  };
});

vi.mock("openclaw/plugin-sdk/gateway-runtime", () => ({
  GatewayClient: gatewayRpcMock.GatewayClient,
  startGatewayClientWhenEventLoopReady: gatewayRpcMock.startGatewayClientWhenEventLoopReady,
}));

import { startQaGatewayRpcClient } from "./gateway-rpc-client.js";

function gatewayClientCallback(name: "onClose" | "onHelloOk") {
  const callback = gatewayRpcMock.clients[0]?.options[name];
  if (typeof callback !== "function") {
    throw new Error(`expected Gateway client ${name} callback`);
  }
  return callback as () => void;
}

function pauseGatewayReconnect(info: GatewayReconnectPausedInfo) {
  const callback = gatewayRpcMock.clients[0]?.options.onReconnectPaused;
  if (typeof callback !== "function") {
    throw new Error("expected Gateway client onReconnectPaused callback");
  }
  (callback as (info: GatewayReconnectPausedInfo) => void)(info);
}

describe("startQaGatewayRpcClient", () => {
  beforeEach(() => gatewayRpcMock.reset());
  afterEach(() => vi.useRealTimers());

  it("starts one authenticated backend operator client and forwards request options", async () => {
    const client = await startQaGatewayRpcClient({
      wsUrl: "ws://127.0.0.1:18789",
      token: "qa-token",
      logs: () => "qa logs",
    });

    await expect(
      client.request("agent.run", { prompt: "hi" }, { expectFinal: true, timeoutMs: 45_000 }),
    ).resolves.toEqual({ ok: true });

    expect(gatewayRpcMock.clients).toHaveLength(1);
    expect(gatewayRpcMock.clients[0]?.options).toMatchObject({
      url: "ws://127.0.0.1:18789",
      token: "qa-token",
      requestTimeoutMs: 20_000,
      clientName: "gateway-client",
      deviceIdentity: null,
      mode: "backend",
      scopes: ["operator.admin"],
    });
    expect(gatewayRpcMock.startGatewayClientWhenEventLoopReady).toHaveBeenCalledWith(
      gatewayRpcMock.clients[0],
      { timeoutMs: 20_000 },
    );
    expect(gatewayRpcMock.request).toHaveBeenCalledWith(
      "agent.run",
      { prompt: "hi" },
      expect.objectContaining({ expectFinal: true, timeoutMs: expect.any(Number) }),
    );
    const requestOptions = gatewayRpcMock.request.mock.calls[0]?.[2] as { timeoutMs: number };
    expect(requestOptions.timeoutMs).toBeGreaterThanOrEqual(44_900);
    expect(requestOptions.timeoutMs).toBeLessThanOrEqual(45_000);
  });

  it("can request a narrower operator scope for authorization-sensitive probes", async () => {
    const client = await startQaGatewayRpcClient({
      wsUrl: "ws://127.0.0.1:18789",
      token: "qa-token",
      logs: () => "qa logs",
      scopes: ["operator.write"],
    });

    expect(gatewayRpcMock.clients[0]?.options.scopes).toEqual(["operator.write"]);
    await client.stop();
  });

  it("dispatches concurrent requests over the same client", async () => {
    let releaseFirst: (() => void) | undefined;
    gatewayRpcMock.request
      .mockImplementationOnce(
        async () =>
          await new Promise<{ ok: boolean }>((resolve) => {
            releaseFirst = () => resolve({ ok: true });
          }),
      )
      .mockResolvedValueOnce({ ok: true });
    const client = await startQaGatewayRpcClient({
      wsUrl: "ws://127.0.0.1:18789",
      token: "qa-token",
      logs: () => "qa logs",
    });

    const firstRequest = client.request("health");
    await Promise.resolve();
    const secondRequest = client.request("status");
    await Promise.resolve();

    await vi.waitFor(() => expect(gatewayRpcMock.request).toHaveBeenCalledTimes(2));
    await expect(secondRequest).resolves.toEqual({ ok: true });
    if (!releaseFirst) {
      throw new Error("expected first request to be held");
    }
    releaseFirst();
    await expect(firstRequest).resolves.toEqual({ ok: true });
  });

  it("clamps request timeout to the remaining absolute deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const client = await startQaGatewayRpcClient({
      wsUrl: "ws://127.0.0.1:18789",
      token: "qa-token",
      logs: () => "qa logs",
    });

    await client.request("status", {}, { deadlineMs: 1_250, timeoutMs: 5_000 });

    expect(gatewayRpcMock.request).toHaveBeenCalledWith(
      "status",
      {},
      expect.objectContaining({
        expectFinal: undefined,
        timeoutMs: 250,
      }),
    );
  });

  it("bounds startup when readiness completes but the Gateway never sends hello", async () => {
    vi.useFakeTimers();
    gatewayRpcMock.startGatewayClientWhenEventLoopReady.mockResolvedValueOnce({
      ready: true,
      aborted: false,
    });

    const startup = startQaGatewayRpcClient({
      wsUrl: "ws://127.0.0.1:18789",
      token: "qa-token",
      logs: () => "qa logs",
    });
    const rejection = expect(startup).rejects.toThrow(
      "gateway request deadline exceeded\nGateway logs:\nqa logs",
    );
    await vi.advanceTimersByTimeAsync(20_000);

    await rejection;
    expect(gatewayRpcMock.stopAndWait).toHaveBeenCalledOnce();
  });

  it("waits for reconnect before dispatching a request", async () => {
    const client = await startQaGatewayRpcClient({
      wsUrl: "ws://127.0.0.1:18789",
      token: "qa-token",
      logs: () => "qa logs",
    });
    gatewayClientCallback("onClose")();

    const request = client.request("status", {}, { timeoutMs: 5_000 });
    await Promise.resolve();
    expect(gatewayRpcMock.request).not.toHaveBeenCalled();

    gatewayClientCallback("onHelloOk")();
    await expect(request).resolves.toEqual({ ok: true });
    expect(gatewayRpcMock.request).toHaveBeenCalledOnce();
  });

  it("applies the request deadline while waiting for reconnect", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const client = await startQaGatewayRpcClient({
      wsUrl: "ws://127.0.0.1:18789",
      token: "qa-token",
      logs: () => "qa logs",
    });
    gatewayClientCallback("onClose")();

    const request = client.request("status", {}, { deadlineMs: 1_250, timeoutMs: 5_000 });
    const rejection = expect(request).rejects.toThrow("gateway request deadline exceeded");
    await vi.advanceTimersByTimeAsync(250);

    await rejection;
    expect(gatewayRpcMock.request).not.toHaveBeenCalled();
  });

  it("preserves a terminal reconnect failure through the following close", async () => {
    const client = await startQaGatewayRpcClient({
      wsUrl: "ws://127.0.0.1:18789",
      token: "qa-token",
      logs: () => "qa logs",
    });

    pauseGatewayReconnect({
      code: 1008,
      detailCode: "AUTH_FAILED",
      reason: "authentication failed",
    });
    gatewayClientCallback("onClose")();

    await expect(client.request("status")).rejects.toThrow(
      "gateway reconnect paused (1008): authentication failed [AUTH_FAILED]",
    );
    expect(gatewayRpcMock.request).not.toHaveBeenCalled();
  });

  it("does not retry a sent request whose Gateway error says it is not connected", async () => {
    gatewayRpcMock.request.mockImplementationOnce(async (_method, _params, options) => {
      options.onSent?.();
      throw new Error("gateway not connected");
    });
    const client = await startQaGatewayRpcClient({
      wsUrl: "ws://127.0.0.1:18789",
      token: "qa-token",
      logs: () => "qa logs",
    });

    await expect(client.request("agent.run")).rejects.toThrow("gateway not connected");
    expect(gatewayRpcMock.request).toHaveBeenCalledOnce();
  });

  it("wraps normalized request failures with redacted gateway logs", async () => {
    gatewayRpcMock.request.mockRejectedValueOnce("gateway rejected request");
    const client = await startQaGatewayRpcClient({
      wsUrl: "ws://127.0.0.1:18789",
      token: "qa-token",
      logs: () => "OPENCLAW_GATEWAY_TOKEN=secret-token",
    });

    await expect(client.request("health")).rejects.toMatchObject({
      cause: expect.objectContaining({ message: "gateway rejected request" }),
      message: "gateway rejected request\nGateway logs:\nOPENCLAW_GATEWAY_TOKEN=<redacted>",
    });
  });

  it("stops the transport and rejects later requests", async () => {
    const client = await startQaGatewayRpcClient({
      wsUrl: "ws://127.0.0.1:18789",
      token: "qa-token",
      logs: () => "qa logs",
    });

    await client.stop();

    expect(gatewayRpcMock.stopAndWait).toHaveBeenCalledOnce();
    await expect(client.request("health")).rejects.toThrow(
      "gateway rpc client already stopped\nGateway logs:\nqa logs",
    );
  });

  it("rejects a request waiting for reconnect when stopped", async () => {
    const client = await startQaGatewayRpcClient({
      wsUrl: "ws://127.0.0.1:18789",
      token: "qa-token",
      logs: () => "qa logs",
    });
    gatewayClientCallback("onClose")();
    const request = client.request("health");

    await client.stop();

    await expect(request).rejects.toThrow("gateway rpc client stopped\nGateway logs:\nqa logs");
  });

  it("does not create a new reconnect waiter after stop races a pre-dispatch rejection", async () => {
    let rejectRequest!: (error: Error) => void;
    gatewayRpcMock.request.mockImplementationOnce(
      async () =>
        await new Promise((_resolve, reject) => {
          rejectRequest = reject;
        }),
    );
    const client = await startQaGatewayRpcClient({
      wsUrl: "ws://127.0.0.1:18789",
      token: "qa-token",
      logs: () => "qa logs",
    });
    const request = client.request("agent.run");
    await vi.waitFor(() => expect(gatewayRpcMock.request).toHaveBeenCalledOnce());

    await client.stop();
    rejectRequest(new Error("gateway not connected"));

    await expect(request).rejects.toThrow("gateway rpc client already stopped");
    expect(gatewayRpcMock.request).toHaveBeenCalledOnce();
  });
});
