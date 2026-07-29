import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GatewayProtocolClient,
  type GatewayProtocolSocket,
  type GatewayProtocolSocketHandlers,
} from "./protocol-client.js";

type SeqHarness = {
  client: GatewayProtocolClient<Record<string, never>>;
  createSocket: ReturnType<
    typeof vi.fn<(handlers: GatewayProtocolSocketHandlers) => GatewayProtocolSocket>
  >;
  onGap: ReturnType<typeof vi.fn<(info: { expected: number; received: number }) => void>>;
  handlers: () => GatewayProtocolSocketHandlers;
};

// Build a client whose transport is a mock socket. Each connect() captures the
// generation's handlers so the test can drive real event frames and a real
// close-triggered reconnect through the production message/gap path.
function createSeqHarness(): SeqHarness {
  let latest: GatewayProtocolSocketHandlers | null = null;
  const onGap = vi.fn<(info: { expected: number; received: number }) => void>();
  const createSocket = vi.fn<(handlers: GatewayProtocolSocketHandlers) => GatewayProtocolSocket>(
    (handlers) => {
      latest = handlers;
      return { isOpen: () => true, send: vi.fn(), close: vi.fn() };
    },
  );
  const client = new GatewayProtocolClient<Record<string, never>>({
    createSocket,
    createRequestId: () => "request-1",
    buildConnectPlan: () => ({}),
    buildConnectParams: (plan) => plan,
    resolveClose: () => ({ retry: true, notify: true }),
    onConnectError: vi.fn(),
    onGap,
    handshake: { mode: "require-challenge", timeoutMs: 100 },
    reconnect: { initialMs: 10, multiplier: 2, maxMs: 100 },
  });
  return {
    client,
    createSocket,
    onGap,
    handlers: () => {
      if (!latest) {
        throw new Error("socket handlers not captured");
      }
      return latest;
    },
  };
}

function event(seq: number): string {
  return JSON.stringify({ type: "event", event: "tick", seq });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("GatewayProtocolClient outer event sequence across reconnects", () => {
  it("does not report a false gap when a new connection starts a fresh sequence", async () => {
    vi.useFakeTimers();
    const { client, createSocket, onGap, handlers } = createSeqHarness();

    client.start();
    // First connection reaches seq 5.
    handlers().message(event(5));
    expect(onGap).not.toHaveBeenCalled();

    // Retire the socket; the client schedules a reconnect and opens a new one.
    handlers().close(1006, "boom");
    await vi.advanceTimersByTimeAsync(10);
    expect(createSocket).toHaveBeenCalledTimes(2);

    // The replacement connection's outer sequence resets on the server, so its
    // first event is unrelated to the retired connection's seq 5.
    handlers().message(event(7));

    expect(onGap).not.toHaveBeenCalled();
    client.stop();
  });

  it("still reports a real gap within a single connection", async () => {
    vi.useFakeTimers();
    const { client, onGap, handlers } = createSeqHarness();

    client.start();
    handlers().message(event(0));
    handlers().message(event(2));

    expect(onGap).toHaveBeenCalledExactlyOnceWith({ expected: 1, received: 2 });
    client.stop();
  });
});
