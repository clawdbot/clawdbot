import type { EventFrame } from "@openclaw/gateway-protocol";
import { afterEach, describe, expect, test, vi } from "vitest";
import { GatewayProtocolClient, type GatewayProtocolSocketHandlers } from "./protocol-client.js";

type SyntheticConnection = {
  handlers: GatewayProtocolSocketHandlers;
  close: (code?: number, reason?: string) => void;
};

function createSequenceClient(): {
  client: GatewayProtocolClient<Record<string, never>>;
  connections: SyntheticConnection[];
  onEvent: ReturnType<typeof vi.fn<(event: EventFrame) => void>>;
  onGap: ReturnType<typeof vi.fn<(info: { expected: number; received: number }) => void>>;
} {
  const connections: SyntheticConnection[] = [];
  const onEvent = vi.fn<(event: EventFrame) => void>();
  const onGap = vi.fn<(info: { expected: number; received: number }) => void>();
  const client = new GatewayProtocolClient<Record<string, never>>({
    createSocket: (handlers) => {
      let open = true;
      const close = (code = 1000, reason = "") => {
        open = false;
        handlers.close(code, reason);
      };
      connections.push({ handlers, close });
      return {
        isOpen: () => open,
        send: () => {},
        close,
      };
    },
    createRequestId: () => "request-1",
    buildConnectPlan: () => ({}),
    buildConnectParams: (plan) => plan,
    resolveClose: () => ({ retry: true, notify: true }),
    onEvent,
    onGap,
    handshake: { mode: "require-challenge", timeoutMs: 100 },
    reconnect: { initialMs: 10, multiplier: 2, maxMs: 100 },
  });
  return { client, connections, onEvent, onGap };
}

function sendEvent(connection: SyntheticConnection, seq: number): void {
  connection.handlers.message(
    JSON.stringify({ type: "event", event: "board.changed", payload: {}, seq }),
  );
}

describe("GatewayProtocolClient event sequences", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("establishes a fresh baseline after an automatic reconnect", async () => {
    vi.useFakeTimers();
    const { client, connections, onEvent, onGap } = createSequenceClient();
    client.start();
    const firstConnection = connections[0];
    if (!firstConnection) {
      throw new Error("synthetic protocol connection missing");
    }
    sendEvent(firstConnection, 1);

    firstConnection.close(1012, "service restart");
    await vi.advanceTimersByTimeAsync(10);
    const replacementConnection = connections[1];
    if (!replacementConnection) {
      throw new Error("synthetic replacement connection missing");
    }
    sendEvent(replacementConnection, 3);

    expect(onGap).not.toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledTimes(2);

    sendEvent(replacementConnection, 5);

    expect(onGap).toHaveBeenCalledExactlyOnceWith({ expected: 4, received: 5 });
    expect(onEvent).toHaveBeenCalledTimes(3);
    client.stop();
  });

  test("resets on restart without admitting retired socket frames", () => {
    const { client, connections, onEvent, onGap } = createSequenceClient();
    client.start();
    const firstConnection = connections[0];
    if (!firstConnection) {
      throw new Error("synthetic protocol connection missing");
    }
    sendEvent(firstConnection, 1);

    client.stop();
    client.start();
    const replacementConnection = connections[1];
    if (!replacementConnection) {
      throw new Error("synthetic replacement connection missing");
    }
    sendEvent(firstConnection, 10);
    sendEvent(replacementConnection, 3);

    expect(onGap).not.toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledTimes(2);

    sendEvent(replacementConnection, 5);

    expect(onGap).toHaveBeenCalledExactlyOnceWith({ expected: 4, received: 5 });
    expect(onEvent).toHaveBeenCalledTimes(3);
    client.stop();
  });
});
