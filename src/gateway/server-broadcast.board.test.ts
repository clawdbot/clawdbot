import { describe, expect, it, vi } from "vitest";
import { createGatewayBroadcaster } from "./server-broadcast.js";
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
});
