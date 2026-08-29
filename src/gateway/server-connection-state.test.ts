import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createGatewayConnectionState } from "./server-connection-state.js";
import type { GatewayWsClient } from "./server/ws-types.js";

type ConnectionIdReads = { count: number };

function makeClient(
  connId: string,
  reads: ConnectionIdReads,
  sendOrder?: string[],
): {
  client: GatewayWsClient;
  socket: { readyState: number };
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn(() => sendOrder?.push(connId));
  const socket = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    close: vi.fn(),
    send,
  };
  const client = {
    socket: socket as unknown as GatewayWsClient["socket"],
    connect: {
      role: "operator",
      scopes: ["operator.read"],
    } as GatewayWsClient["connect"],
    usesSharedGatewayAuth: false,
  } as GatewayWsClient;
  Object.defineProperty(client, "connId", {
    enumerable: true,
    get: () => {
      reads.count += 1;
      return connId;
    },
  });
  return { client, socket, send };
}

describe("gateway connection state", () => {
  it("bounds targeted delivery and connection lookups to the requested connection", () => {
    const state = createGatewayConnectionState({ cfg: {} as OpenClawConfig });
    const reads = { count: 0 };
    for (let index = 0; index < 256; index += 1) {
      state.clients.add(makeClient(`other-${index}`, reads).client);
    }
    const target = makeClient("target", reads);
    state.clients.add(target.client);
    reads.count = 0;

    state.broadcastToConnIds("tick", { ts: 1 }, new Set(["target"]));

    expect(target.send).toHaveBeenCalledTimes(1);
    expect(reads.count).toBe(0);

    target.socket.readyState = WebSocket.CLOSING;
    state.broadcastToConnIds("tick", { ts: 2 }, new Set(["target"]));

    expect(target.send).toHaveBeenCalledTimes(1);

    reads.count = 0;
    expect(state.getBufferedAmount("target")).toBe(0);
    expect(state.isConnectionActive("target")).toBe(true);
    expect(reads.count).toBe(0);

    state.clients.delete(target.client);
    reads.count = 0;
    state.broadcastToConnIds("tick", { ts: 3 }, new Set(["target"]));

    expect(target.send).toHaveBeenCalledTimes(1);
    expect(state.getBufferedAmount("target")).toBeUndefined();
    expect(state.isConnectionActive("target")).toBe(false);
    expect(reads.count).toBe(0);

    state.clients.add(target.client);
    state.clients.clear();
    reads.count = 0;

    expect(state.getBufferedAmount("target")).toBeUndefined();
    expect(state.isConnectionActive("target")).toBe(false);
    expect(reads.count).toBe(0);
  });

  it("preserves connection insertion order for targeted fanout", () => {
    const state = createGatewayConnectionState({ cfg: {} as OpenClawConfig });
    const reads = { count: 0 };
    const sendOrder: string[] = [];
    state.clients.add(makeClient("first", reads, sendOrder).client);
    state.clients.add(makeClient("unrelated", reads, sendOrder).client);
    state.clients.add(makeClient("last", reads, sendOrder).client);

    state.broadcastToConnIds("tick", { ts: 1 }, new Set(["last", "first"]));

    expect(sendOrder).toEqual(["first", "last"]);
  });
});
