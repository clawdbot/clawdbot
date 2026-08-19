// Gateway Client tests cover negotiated request-frame payload enforcement.
import type { HelloOk } from "@openclaw/gateway-protocol";
import { describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { GatewayClient } from "./client.js";
import type { GatewayProtocolSocket } from "./protocol-client.js";

type ProtocolHarness = {
  socket: GatewayProtocolSocket | null;
  hasPendingRequests: boolean;
  stopped: boolean;
  generation: number;
  reconnectSupervisor: { reset(initialMs?: number): void };
  handleMessage: (socket: GatewayProtocolSocket, generation: number, raw: string) => void;
};

type PayloadHarness = {
  handleConnectHello: (
    hello: { auth?: HelloOk["auth"]; policy?: Partial<HelloOk["policy"]> },
    assembled: unknown,
  ) => void;
  maxPayloadBytes: number | undefined;
};

function protocolHarness(client: GatewayClient): ProtocolHarness {
  return (client as unknown as { protocol: ProtocolHarness }).protocol;
}

function payloadHarness(client: GatewayClient): PayloadHarness {
  return client as unknown as PayloadHarness;
}

function installSyntheticSocket(
  client: GatewayClient,
  send: (data: string) => unknown,
  close: (code?: number, reason?: string) => unknown,
): void {
  const socket: GatewayProtocolSocket = {
    isOpen: () => true,
    send: (data) => send(data),
    close: (code, reason) => close(code, reason),
  };
  Object.assign(protocolHarness(client), { socket, stopped: false, generation: 1 });
  (client as unknown as { ws: unknown }).ws = {
    readyState: WebSocket.OPEN,
    send,
    close,
    terminate: vi.fn(),
  };
}

function createOpenGatewayClient(requestTimeoutMs: number): {
  client: GatewayClient;
  send: ReturnType<typeof vi.fn>;
} {
  const client = new GatewayClient({
    requestTimeoutMs,
  });
  const send = vi.fn();
  installSyntheticSocket(client, send, vi.fn());
  return { client, send };
}

function getPendingCount(client: GatewayClient): number {
  return protocolHarness(client).hasPendingRequests ? 1 : 0;
}

function handleGatewayMessage(client: GatewayClient, payload: Record<string, unknown>): void {
  const protocol = protocolHarness(client);
  if (!protocol.socket) {
    throw new Error("synthetic protocol socket missing");
  }
  protocol.handleMessage(protocol.socket, protocol.generation, JSON.stringify(payload));
}

describe("GatewayClient", () => {
  test("rejects oversized pre-auth connect frames before sending", async () => {
    const { client, send } = createOpenGatewayClient(25);
    await expect(client.request("connect", { pathEnv: "x".repeat(70 * 1024) })).rejects.toThrow(
      "gateway request connect exceeds pre-auth max payload",
    );
    expect(send).not.toHaveBeenCalled();
    expect(getPendingCount(client)).toBe(0);

    const request = client.request("connect", { pathEnv: "x".repeat(1024) });
    const frame = JSON.parse(String(send.mock.calls[0]?.[0])) as {
      id: string;
      method: string;
    };
    expect(frame.method).toBe("connect");
    handleGatewayMessage(client, {
      type: "res",
      id: frame.id,
      ok: true,
      payload: { type: "hello-ok", protocol: 4, auth: { role: "operator", scopes: [] } },
    });
    await expect(request).resolves.toMatchObject({ type: "hello-ok" });
    client.stop();
  });

  test("keeps the default request payload limit for an invalid policy", async () => {
    const { client, send } = createOpenGatewayClient(25);
    const harness = payloadHarness(client);
    harness.handleConnectHello({ auth: { role: "operator", scopes: [] } }, {});
    harness.handleConnectHello(
      {
        auth: { role: "operator", scopes: [] },
        policy: { maxPayload: 0, maxBufferedBytes: 256, tickIntervalMs: 30_000 },
      },
      {},
    );

    const request = client.request<{ status: string }>("node.invoke", {
      jsonl: "x".repeat(128),
    });
    const frame = JSON.parse(String(send.mock.calls[0]?.[0])) as { id: string };
    handleGatewayMessage(client, {
      type: "res",
      id: frame.id,
      ok: true,
      payload: { status: "ok" },
    });

    await expect(request).resolves.toEqual({ status: "ok" });
    expect(harness.maxPayloadBytes).toBe(25 * 1024 * 1024);
    expect(send).toHaveBeenCalledTimes(1);
    client.stop();
  });

  test("keeps the default request payload limit for a fractional policy", async () => {
    const { client, send } = createOpenGatewayClient(25);
    const harness = payloadHarness(client);
    harness.handleConnectHello(
      {
        auth: { role: "operator", scopes: [] },
        policy: { maxPayload: 0.5, maxBufferedBytes: 256, tickIntervalMs: 30_000 },
      },
      {},
    );

    const request = client.request<{ status: string }>("node.invoke", {
      jsonl: "x".repeat(128),
    });
    const frame = JSON.parse(String(send.mock.calls[0]?.[0])) as { id: string };
    handleGatewayMessage(client, {
      type: "res",
      id: frame.id,
      ok: true,
      payload: { status: "ok" },
    });

    await expect(request).resolves.toEqual({ status: "ok" });
    expect(harness.maxPayloadBytes).toBe(25 * 1024 * 1024);
    expect(send).toHaveBeenCalledTimes(1);
    client.stop();
  });

  test("does not add a post-auth request limit for a policyless Gateway", async () => {
    const { client, send } = createOpenGatewayClient(25);
    const harness = payloadHarness(client);
    harness.handleConnectHello(
      {
        auth: { role: "operator", scopes: [] },
        policy: { maxPayload: 128, maxBufferedBytes: 256, tickIntervalMs: 30_000 },
      },
      {},
    );
    expect(harness.maxPayloadBytes).toBe(128);

    harness.handleConnectHello({ auth: { role: "operator", scopes: [] } }, {});

    const request = client.request<{ status: string }>("node.invoke", {
      jsonl: "x".repeat(128),
    });
    const frame = JSON.parse(String(send.mock.calls[0]?.[0])) as { id: string };
    handleGatewayMessage(client, {
      type: "res",
      id: frame.id,
      ok: true,
      payload: { status: "ok" },
    });

    await expect(request).resolves.toEqual({ status: "ok" });
    expect(harness.maxPayloadBytes).toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
    client.stop();
  });

  test("enforces the latest negotiated request payload before sending", async () => {
    const { client, send } = createOpenGatewayClient(25);
    const harness = payloadHarness(client);
    harness.handleConnectHello(
      {
        auth: { role: "operator", scopes: [] },
        policy: { maxPayload: 128, maxBufferedBytes: 256, tickIntervalMs: 30_000 },
      },
      {},
    );

    await expect(client.request("node.invoke", { jsonl: "x".repeat(128) })).rejects.toThrow(
      "gateway request node.invoke exceeds negotiated max payload",
    );
    expect(harness.maxPayloadBytes).toBe(128);
    expect(send).not.toHaveBeenCalled();
    expect(getPendingCount(client)).toBe(0);

    harness.handleConnectHello(
      {
        auth: { role: "operator", scopes: [] },
        policy: { maxPayload: 512, maxBufferedBytes: 1_024, tickIntervalMs: 30_000 },
      },
      {},
    );
    const request = client.request<{ status: string }>("node.invoke", {
      jsonl: "x".repeat(128),
    });
    const frame = JSON.parse(String(send.mock.calls[0]?.[0])) as { id: string };
    handleGatewayMessage(client, {
      type: "res",
      id: frame.id,
      ok: true,
      payload: { status: "ok" },
    });

    await expect(request).resolves.toEqual({ status: "ok" });
    expect(harness.maxPayloadBytes).toBe(512);
    expect(send).toHaveBeenCalledTimes(1);
    client.stop();
  });
});
