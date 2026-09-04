import assert from "node:assert/strict";
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
  delayClose = false,
) {
  const connections: HandshakeConnection[] = [];
  const onHello = vi.fn();
  const onConnectHello = vi.fn();
  const onClose = vi.fn();
  const onTiming = vi.fn();
  let nextRequestId = 0;
  const client = new GatewayProtocolClient<Record<string, never>>({
    createSocket: (handlers) => {
      let open = true;
      const send = vi.fn<(data: string) => void>();
      const close = vi.fn<(code?: number, reason?: string) => void>((code, reason) => {
        open = false;
        if (!delayClose) {
          handlers.close(code ?? 1000, reason ?? "");
        }
      });
      connections.push({ handlers, send, close });
      return { isOpen: () => open, send, close };
    },
    createRequestId: () => `request-${++nextRequestId}`,
    buildConnectPlan,
    buildConnectParams: (plan) => plan,
    resolveClose: () => ({ retry: true, notify: true }),
    onHello,
    onConnectHello,
    onClose,
    onTiming,
    handshake: { mode: "require-challenge", timeoutMs: 100 },
    reconnect: { initialMs: 10, multiplier: 2, maxMs: 100 },
  });
  return { client, connections, onHello, onConnectHello, onClose, onTiming };
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

function receiveHello(connection: HandshakeConnection): void {
  const sent = connection.send.mock.calls[0];
  assert(sent);
  const request = JSON.parse(sent[0]) as { id: string };
  connection.handlers.message(
    JSON.stringify({ type: "res", id: request.id, ok: true, payload: { type: "hello-ok" } }),
  );
}

describe("GatewayProtocolClient connect handshake", () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    { retryable: true, retryAfterMs: 90_000, delayMs: 90_000 },
    { retryable: false, retryAfterMs: 90_000, delayMs: 10 },
    { retryable: true, retryAfterMs: 1, delayMs: 10 },
    { retryable: true, retryAfterMs: 0, delayMs: 10 },
    { retryable: true, retryAfterMs: undefined, delayMs: 10 },
  ])(
    "treats usable retry hints as floors while advancing backoff: %j",
    async ({ retryable, retryAfterMs, delayMs }) => {
      vi.useFakeTimers();
      const { client, connections } = createHandshakeClient();
      try {
        client.start();
        const first = connections[0];
        assert(first);
        receiveConnectChallenge(first);
        const sent = first.send.mock.calls[0];
        assert(sent);
        const request = JSON.parse(sent[0]) as { id: string };
        first.handlers.message(
          JSON.stringify({
            type: "res",
            id: request.id,
            ok: false,
            error: {
              code: "UNAVAILABLE",
              message: "temporarily unavailable",
              retryable,
              retryAfterMs,
            },
          }),
        );
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(delayMs - 1);
        expect(connections).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(connections).toHaveLength(2);

        const second = connections[1];
        assert(second);
        second.close(1006, "transport unavailable");
        await vi.advanceTimersByTimeAsync(19);
        expect(connections).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(connections).toHaveLength(3);
      } finally {
        client.stop();
      }
    },
  );

  it.each(["before response", "before publication"])(
    "rejects hello when the connect deadline closes the transport %s",
    async (closingOrder) => {
      vi.useFakeTimers();
      const { client, connections, onHello, onConnectHello, onClose, onTiming } =
        createHandshakeClient(undefined, true);
      try {
        client.start();
        const first = connections[0];
        assert(first);
        first.close(1012, "restart");
        first.handlers.close(1012, "restart");
        await vi.advanceTimersByTimeAsync(10);
        const connection = connections[1];
        assert(connection);
        receiveConnectChallenge(connection);
        const pending = client.request("status").catch((error: unknown) => error);

        if (closingOrder === "before publication") {
          receiveHello(connection);
        }
        // Advance synchronously so an already-resolved response publishes only
        // after the deadline has moved the transport into its closing window.
        vi.advanceTimersByTime(DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);
        expect(connection.close).toHaveBeenCalledExactlyOnceWith(4000, "connect timeout");
        if (closingOrder === "before response") {
          receiveHello(connection);
        }
        await vi.advanceTimersByTimeAsync(0);

        expect(client.connected).toBe(false);
        expect(client.connecting).toBe(true);
        expect(onHello).not.toHaveBeenCalled();
        expect(onConnectHello).not.toHaveBeenCalled();
        expect(onTiming.mock.calls.some(([timing]) => timing.phase === "hello")).toBe(false);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(client.hasPendingRequests).toBe(true);
        const onSent = vi.fn();
        await expect(client.request("status", undefined, { onSent })).rejects.toThrow(
          "gateway not connected",
        );
        expect(onSent).not.toHaveBeenCalled();

        connection.handlers.close(4000, "connect timeout");
        await expect(pending).resolves.toEqual(new Error("gateway closed (4000): connect timeout"));
        expect(client.hasPendingRequests).toBe(false);
        expect(onClose).toHaveBeenLastCalledWith(
          expect.objectContaining({ helloReceived: false, connectRequestSent: true }),
          { retry: true, notify: true },
        );
        // An unusable hello must not reset the second retry's exponential delay.
        await vi.advanceTimersByTimeAsync(10);
        expect(connections).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(10);
        const replacement = connections[2];
        assert(replacement);
        receiveConnectChallenge(replacement);
        receiveHello(replacement);
        await vi.advanceTimersByTimeAsync(0);
        expect(onHello).toHaveBeenCalledExactlyOnceWith({ type: "hello-ok" });
        expect(onConnectHello).toHaveBeenCalledOnce();
        expect(client.connecting).toBe(false);
        expect(client.connected).toBe(true);
        await vi.advanceTimersByTimeAsync(DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);
        expect(replacement.close).not.toHaveBeenCalled();
        replacement.close(1012, "restart");
        replacement.handlers.close(1012, "restart");
        await vi.advanceTimersByTimeAsync(10);
        expect(connections).toHaveLength(4);
      } finally {
        client.stop();
      }
    },
  );

  it.each([false, true])("suppresses a resolved hello after stop (restart=%s)", async (restart) => {
    vi.useFakeTimers();
    const { client, connections, onHello, onConnectHello } = createHandshakeClient();
    try {
      client.start();
      const connection = connections[0];
      assert(connection);
      receiveConnectChallenge(connection);
      receiveHello(connection);
      client.stop();
      if (restart) {
        client.start();
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(onHello).not.toHaveBeenCalled();
      expect(onConnectHello).not.toHaveBeenCalled();
      if (restart) {
        const replacement = connections[1];
        assert(replacement);
        receiveConnectChallenge(replacement);
        receiveHello(replacement);
        await vi.advanceTimersByTimeAsync(0);
        expect(onHello).toHaveBeenCalledOnce();
      }
    } finally {
      client.stop();
    }
  });

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
