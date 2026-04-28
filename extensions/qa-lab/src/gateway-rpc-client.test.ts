import { beforeEach, describe, expect, it, vi } from "vitest";

const gatewayRpcMock = vi.hoisted(() => {
  const callGatewayFromCli = vi.fn(async () => ({ ok: true }));
  return {
    callGatewayFromCli,
    reset() {
      callGatewayFromCli.mockReset().mockResolvedValue({ ok: true });
    },
  };
});

vi.mock("openclaw/plugin-sdk/gateway-runtime", () => ({
  callGatewayFromCli: gatewayRpcMock.callGatewayFromCli,
}));

import { startQaGatewayRpcClient } from "./gateway-rpc-client.js";

describe("startQaGatewayRpcClient", () => {
  beforeEach(() => {
    gatewayRpcMock.reset();
  });

  it("calls the in-process gateway cli helper without mutating process.env", async () => {
    const originalHome = process.env.OPENCLAW_HOME;
    delete process.env.OPENCLAW_HOME;

    gatewayRpcMock.callGatewayFromCli.mockImplementationOnce(async () => {
      expect(process.env.OPENCLAW_HOME).toBeUndefined();
      return { ok: true };
    });

    const client = await startQaGatewayRpcClient({
      wsUrl: "ws://127.0.0.1:18789",
      token: "qa-token",
      logs: () => "qa logs",
    });

    await expect(
      client.request("agent.run", { prompt: "hi" }, { expectFinal: true, timeoutMs: 45_000 }),
    ).resolves.toEqual({ ok: true });

    expect(gatewayRpcMock.callGatewayFromCli).toHaveBeenCalledWith(
      "agent.run",
      {
        url: "ws://127.0.0.1:18789",
        token: "qa-token",
        timeout: "45000",
        expectFinal: true,
        json: true,
      },
      { prompt: "hi" },
      {
        expectFinal: true,
        progress: false,
      },
    );

    expect(process.env.OPENCLAW_HOME).toBe(originalHome);
  });

  it("wraps request failures with gateway logs", async () => {
    gatewayRpcMock.callGatewayFromCli.mockRejectedValueOnce(new Error("gateway not connected"));
    const client = await startQaGatewayRpcClient({
      wsUrl: "ws://127.0.0.1:18789",
      token: "qa-token",
      logs: () => "OPENCLAW_GATEWAY_TOKEN=secret-token\nAuthorization: Bearer secret+/token=123456",
    });

    await expect(client.request("health")).rejects.toThrow(
      "gateway not connected\nGateway logs:\nOPENCLAW_GATEWAY_TOKEN=<redacted>\nAuthorization: Bearer <redacted>",
    );
  });

  it("rejects new requests after stop", async () => {
    const client = await startQaGatewayRpcClient({
      wsUrl: "ws://127.0.0.1:18789",
      token: "qa-token",
      logs: () => "url=http://127.0.0.1:18789/#token=abc123",
    });

    await client.stop();

    await expect(client.request("health")).rejects.toThrow(
      "gateway rpc client already stopped\nGateway logs:\nurl=http://127.0.0.1:18789/#token=<redacted>",
    );
  });

  it("does not serialize requests across different gateway clients", async () => {
    let resolveFirst: ((value: { ok: boolean }) => void) | null = null;
    gatewayRpcMock.callGatewayFromCli
      .mockImplementationOnce(
        async () =>
          await new Promise<{ ok: boolean }>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({ ok: true });

    const firstClient = await startQaGatewayRpcClient({
      wsUrl: "ws://127.0.0.1:18789",
      token: "qa-token-a",
      logs: () => "qa logs a",
    });
    const secondClient = await startQaGatewayRpcClient({
      wsUrl: "ws://127.0.0.1:28789",
      token: "qa-token-b",
      logs: () => "qa logs b",
    });

    const firstRequest = firstClient.request("health");
    await Promise.resolve();

    await expect(secondClient.request("status")).resolves.toEqual({ ok: true });
    expect(gatewayRpcMock.callGatewayFromCli).toHaveBeenNthCalledWith(
      2,
      "status",
      {
        url: "ws://127.0.0.1:28789",
        token: "qa-token-b",
        timeout: "20000",
        expectFinal: undefined,
        json: true,
      },
      {},
      {
        expectFinal: undefined,
        progress: false,
      },
    );

    expect(resolveFirst).not.toBeNull();
    resolveFirst!({ ok: true });
    await expect(firstRequest).resolves.toEqual({ ok: true });
  });

  it("still serializes requests within the same gateway client", async () => {
    let releaseFirst: (() => void) | null = null;
    gatewayRpcMock.callGatewayFromCli
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

    expect(gatewayRpcMock.callGatewayFromCli).toHaveBeenCalledTimes(1);

    expect(releaseFirst).not.toBeNull();
    releaseFirst!();

    await expect(firstRequest).resolves.toEqual({ ok: true });
    await expect(secondRequest).resolves.toEqual({ ok: true });
    expect(gatewayRpcMock.callGatewayFromCli).toHaveBeenCalledTimes(2);
  });
});
