import { describe, expect, it, vi } from "vitest";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { createSessionMessageSubscriberRegistry } from "./server-chat-state.js";
import type { GatewayWsClient } from "./server/ws-types.js";

type RecordingSocket = {
  bufferedAmount: number;
  close: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  events: string[];
};

function makeClient(
  connId: string,
  role: "node" | "operator",
  scopes: string[],
): { client: GatewayWsClient; socket: RecordingSocket } {
  const events: string[] = [];
  const socket: RecordingSocket = {
    bufferedAmount: 0,
    close: vi.fn(),
    send: vi.fn((payload: string) => {
      events.push((JSON.parse(payload) as { event: string }).event);
    }),
    events,
  };
  return {
    client: {
      socket: socket as unknown as GatewayWsClient["socket"],
      connect: { role, scopes } as GatewayWsClient["connect"],
      connId,
      usesSharedGatewayAuth: false,
    },
    socket,
  };
}

describe("board event scope guards", () => {
  it("delivers board events only to read-capable operators", () => {
    const pairing = makeClient("pairing", "operator", ["operator.pairing"]);
    const node = makeClient("node", "node", ["operator.read"]);
    const read = makeClient("read", "operator", ["operator.read"]);
    const write = makeClient("write", "operator", ["operator.write"]);
    const admin = makeClient("admin", "operator", ["operator.admin"]);
    const clients = new Set([pairing, node, read, write, admin].map((entry) => entry.client));
    const { broadcast } = createGatewayBroadcaster({ clients });

    broadcast("board.changed", { sessionKey: "agent:main:main", revision: 1 });
    broadcast("board.command", {
      sessionKey: "agent:main:main",
      command: { kind: "focus_tab", tabId: "main" },
    });

    expect(pairing.socket.events).toEqual([]);
    expect(node.socket.events).toEqual([]);
    expect(read.socket.events).toEqual(["board.changed", "board.command"]);
    expect(write.socket.events).toEqual(["board.changed", "board.command"]);
    expect(admin.socket.events).toEqual(["board.changed", "board.command"]);
  });

  it("applies session visibility filtering from the event payload key", () => {
    const hidden = makeClient("hidden", "operator", ["operator.read"]);
    const visible = makeClient("visible", "operator", ["operator.read"]);
    const canReceiveSessionEvent = vi.fn(
      (client: GatewayWsClient, sessionKeys: readonly string[], agentId?: string) => {
        expect(sessionKeys).toEqual(["global"]);
        expect(agentId).toBe("work");
        return client.connId === "visible";
      },
    );
    const { broadcast } = createGatewayBroadcaster({
      clients: new Set([hidden.client, visible.client]),
      canReceiveSessionEvent,
    });

    broadcast("board.changed", {
      request: { sessionKey: "global", agentId: "work" },
      revision: 1,
    });

    expect(hidden.socket.events).toEqual([]);
    expect(visible.socket.events).toEqual(["board.changed"]);
    expect(canReceiveSessionEvent).toHaveBeenCalledTimes(2);
  });
});

describe("collaboration event scope guards", () => {
  it("guards suggestion and typing events and forwards payloads to visibility filtering", () => {
    const pairing = makeClient("pairing", "operator", ["operator.pairing"]);
    const reader = makeClient("reader", "operator", ["operator.read"]);
    const unrelated = makeClient("unrelated", "operator", ["operator.read"]);
    const sessionMessageSubscribers = createSessionMessageSubscriberRegistry();
    sessionMessageSubscribers.subscribe("reader", "agent:main:main");
    const canReceiveSessionEvent = vi.fn(
      (
        _client: GatewayWsClient,
        sessionKeys: readonly string[],
        agentId: string | undefined,
        event: string | undefined,
        payload: unknown,
      ) => {
        expect(sessionKeys).toEqual(["agent:main:main"]);
        expect(agentId).toBe("main");
        expect(payload).toBeDefined();
        return event === "session.typing";
      },
    );
    const { broadcast } = createGatewayBroadcaster({
      clients: new Set([pairing.client, reader.client, unrelated.client]),
      canReceiveSessionEvent,
      sessionMessageSubscribers,
    });

    broadcast("session.suggestion", {
      suggestion: { sessionKey: "agent:main:main", agentId: "main" },
    });
    broadcast(
      "session.typing",
      {
        sessionKey: "agent:main:main",
        agentId: "main",
        typing: true,
      },
      { sessionKeys: ["agent:main:main"], agentId: "main" },
    );

    expect(pairing.socket.events).toEqual([]);
    expect(reader.socket.events).toEqual(["session.typing"]);
    expect(unrelated.socket.events).toEqual([]);
    expect(canReceiveSessionEvent).toHaveBeenCalledTimes(4);
  });
});
