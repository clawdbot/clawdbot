import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayProtocolClient, type GatewayProtocolSocketHandlers } from "./protocol-client.js";
import { DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS } from "./timeouts.js";

type HandshakeConnection = {
  handlers: GatewayProtocolSocketHandlers;
  send: ReturnType<typeof vi.fn<(data: string) => void>>;
  close: ReturnType<typeof vi.fn<(code?: number, reason?: string) => void>>;
};

function createHandshakeClient(
  buildConnectPlan: () => Record<string, never> | Promise<Record<string, never>> = () => ({}),
) {
  const connections: HandshakeConnection[] = [];
  let nextRequestId = 0;
  const client = new GatewayProtocolClient<Record<string, never>>({
    createSocket: (handlers) => {
      let open = true;
      const send = vi.fn<(data: string) => void>();
      const close = vi.fn<(code?: number, reason?: string) => void>((code, reason) => {
        open = false;
        handlers.close(code ?? 1000, reason ?? "");
      });
      connections.push({ handlers, send, close });
      return { isOpen: () => open, send, close };
    },
    createRequestId: () => `request-${++nextRequestId}`,
    buildConnectPlan,
    buildConnectParams: (plan) => plan,
    resolveClose: () => ({ retry: true, notify: true }),
    handshake: { mode: "require-challenge", timeoutMs: 100 },
    reconnect: { initialMs: 10, multiplier: 2, maxMs: 100 },
  });
  return { client, connections };
}

function receiveConnectChallenge(connection: HandshakeConnection, ts = 1_800_000_000_000): void {
  connection.handlers.open();
  connection.handlers.message(
    JSON.stringify({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "synthetic-nonce", ts },
    }),
  );
}

describe("GatewayProtocolClient connect handshake", () => {
  afterEach(() => vi.useRealTimers());

  it("reconnects when an open Gateway never responds to connect", async () => {
    vi.useFakeTimers();
    const { client, connections } = createHandshakeClient();
    client.start();
    const connection = connections[0];
    expect(connection).toBeDefined();
    if (!connection) {
      return;
    }
    receiveConnectChallenge(connection);
    expect(connection.send).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);

    expect(connection.close).toHaveBeenCalledWith(4000, "connect timeout");
    await vi.advanceTimersByTimeAsync(10);
    expect(connections).toHaveLength(2);
    client.stop();
  });

  it("passes the Gateway challenge timestamp into connect planning", () => {
    const buildConnectPlan = vi.fn(() => ({}));
    const { client, connections } = createHandshakeClient(buildConnectPlan);
    client.start();
    const connection = connections[0];
    expect(connection).toBeDefined();
    if (!connection) {
      return;
    }

    receiveConnectChallenge(connection, 1_700_000_000_123);

    expect(buildConnectPlan).toHaveBeenCalledWith({
      nonce: "synthetic-nonce",
      challengeTs: 1_700_000_000_123,
      generation: 1,
    });
    client.stop();
  });

  it("marks omitted and malformed challenge timestamps as invalid", () => {
    const buildConnectPlan = vi.fn(() => ({}));
    const { client, connections } = createHandshakeClient(buildConnectPlan);
    client.start();
    const first = connections[0];
    expect(first).toBeDefined();
    if (!first) {
      return;
    }
    first.handlers.open();
    first.handlers.message(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "legacy-nonce" },
      }),
    );
    expect(buildConnectPlan).toHaveBeenLastCalledWith({
      nonce: "legacy-nonce",
      challengeTs: null,
      generation: 1,
    });

    client.stop();
    const secondClient = createHandshakeClient(buildConnectPlan);
    secondClient.client.start();
    const second = secondClient.connections[0];
    expect(second).toBeDefined();
    if (!second) {
      return;
    }
    second.handlers.open();
    second.handlers.message(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "malformed-nonce", ts: "not-a-number" },
      }),
    );
    expect(buildConnectPlan).toHaveBeenLastCalledWith({
      nonce: "malformed-nonce",
      challengeTs: null,
      generation: 1,
    });
    secondClient.client.stop();
  });

  it("retires device preparation that outlives the connect handshake", async () => {
    vi.useFakeTimers();
    let resolvePlan: (plan: Record<string, never>) => void = () => undefined;
    const plan = new Promise<Record<string, never>>((resolve) => {
      resolvePlan = resolve;
    });
    const { client, connections } = createHandshakeClient(() => plan);
    client.start();
    const connection = connections[0];
    expect(connection).toBeDefined();
    if (!connection) {
      return;
    }
    receiveConnectChallenge(connection);
    expect(connection.send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);

    expect(connection.close).toHaveBeenCalledWith(4000, "connect timeout");
    resolvePlan({});
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.send).not.toHaveBeenCalled();
    client.stop();
  });
});
