import { getEventListeners, once } from "node:events";
import type { AddressInfo } from "node:net";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { WS_COMPRESSION_THRESHOLD_BYTES } from "./server-constants.js";
import { GatewayClientRegistry } from "./server/client-registry.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { TerminalOutputController } from "./terminal/output-flow-control.js";

const sendError = vi.hoisted(() => vi.fn());
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "gateway/broadcast" ? { ...logger, error: sendError } : logger;
    },
  };
});

function clientFor(connId: string, socket: WebSocket): GatewayWsClient {
  return {
    connId,
    socket,
    connect: { role: "operator", scopes: ["operator.read"] } as GatewayWsClient["connect"],
    usesSharedGatewayAuth: false,
  };
}

function controlledPeer(connId: string) {
  const callbacks: Array<(error?: Error) => void> = [];
  const frames: Array<{ seq: number; payload: unknown }> = [];
  const socket: {
    readyState: WebSocket["readyState"];
    bufferedAmount: number;
    close: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn<(wire: string, callback: (error?: Error) => void) => void>>;
  } = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    close: vi.fn(),
    terminate: vi.fn(),
    send: vi.fn((wire: string, callback: (error?: Error) => void) => {
      frames.push(JSON.parse(wire));
      callbacks.push(callback);
    }),
  };
  return { client: clientFor(connId, socket as unknown as WebSocket), socket, callbacks, frames };
}

const liveText = (group: AbortSignal) => ({
  group,
  coalesce: { key: "text", merge: (_previous: unknown, next: unknown) => next },
});

describe("broadcast transport retirement", () => {
  it("settles a compressed queue failure once while healthy peers keep ordered delivery", async () => {
    const server = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      perMessageDeflate: {
        serverNoContextTakeover: true,
        clientNoContextTakeover: true,
        threshold: WS_COMPRESSION_THRESHOLD_BYTES,
      },
    });
    await once(server, "listening");
    const peers: WebSocket[] = [];
    try {
      const connect = async () => {
        const accepted = once(server, "connection");
        const peer = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
        peers.push(peer);
        await once(peer, "open");
        const [socket] = (await accepted) as [WebSocket];
        expect(socket.extensions).toBe("permessage-deflate");
        return { peer, socket };
      };
      const broken = await connect();
      const healthy = await connect();
      const clients = new GatewayClientRegistry([
        clientFor("compressed-broken", broken.socket),
        clientFor("compressed-healthy", healthy.socket),
      ]);
      const { broadcast, getBufferedAmount } = createGatewayBroadcaster({ clients });
      const received: Array<{ seq: number; payload: { index: number } }> = [];
      healthy.peer.on("message", (data) => received.push(JSON.parse(rawDataToString(data))));
      const owner = new AbortController();
      sendError.mockClear();
      const terminate = vi.spyOn(broken.socket, "terminate");
      const payload = "x".repeat(WS_COMPRESSION_THRESHOLD_BYTES * 2);
      for (let index = 0; index < 165; index += 1) {
        broadcast("skills.changed", { index, payload });
      }
      broadcast("chat", { text: "pending" }, { liveText: liveText(owner.signal) });
      expect(getEventListeners(owner.signal, "abort")).toHaveLength(2);
      const closed = once(broken.peer, "close");
      broken.socket.terminate();
      await closed;
      await vi.waitFor(() => expect(received).toHaveLength(166));
      expect(received.map(({ seq }) => seq)).toEqual(
        Array.from({ length: 166 }, (_, index) => index + 1),
      );
      expect(received.slice(0, 165).map(({ payload: value }) => value.index)).toEqual(
        Array.from({ length: 165 }, (_, index) => index),
      );
      expect(sendError).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("The socket was closed while data was being compressed"),
        { event: "skills.changed" },
      );
      expect(terminate).toHaveBeenCalledTimes(2); // External close and one delivery retirement.
      expect(getEventListeners(owner.signal, "abort")).toHaveLength(0);
      expect(broken.socket.bufferedAmount).toBeGreaterThan(0);
      expect(getBufferedAmount("compressed-broken")).toBeUndefined();
    } finally {
      peers.forEach((peer) => peer.terminate());
      for (const socket of server.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("keeps failed delivery terminal through late callbacks and permits a replacement socket", () => {
    const retired = controlledPeer("replacement");
    const replacement = controlledPeer("replacement");
    const { broadcast, getBufferedAmount } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([retired.client]),
    });
    const owner = new AbortController();
    sendError.mockClear();
    broadcast("tick", {});
    broadcast("tick", {});
    broadcast("tick", {});
    broadcast("chat", { text: "old pending" }, { liveText: liveText(owner.signal) });
    retired.callbacks[0]!(new Error("transport failed"));
    // A transport may invoke callbacks synchronously before changing readyState.
    broadcast("chat", { text: "after failure" }, { liveText: liveText(owner.signal) });
    retired.callbacks[1]!();
    retired.callbacks[0]!(new Error("duplicate callback"));
    expect(retired.frames).toHaveLength(3);
    expect(retired.socket.terminate).toHaveBeenCalledOnce();
    expect(getBufferedAmount("replacement")).toBeUndefined();
    expect(getEventListeners(owner.signal, "abort")).toHaveLength(0);
    expect(sendError).toHaveBeenCalledOnce();

    retired.client.socket = replacement.client.socket;
    broadcast("chat", { text: "new socket" });
    broadcast("chat", { text: "new pending" }, { liveText: liveText(owner.signal) });
    retired.callbacks[2]!(new Error("late old failure"));
    replacement.callbacks[0]!();
    expect(replacement.frames).toEqual([
      { type: "event", event: "chat", seq: 4, payload: { text: "new socket" } },
      { type: "event", event: "chat", seq: 5, payload: { text: "new pending" } },
    ]);
    expect(replacement.socket.terminate).not.toHaveBeenCalled();
    replacement.callbacks[1]!();
    expect(getEventListeners(owner.signal, "abort")).toHaveLength(0);
  });

  it.each(["failed", "closing", "invalidated"] as const)(
    "does not hold healthy terminal viewers paused for a %s peer's stale bytes",
    (retirement) => {
      const stale = controlledPeer("stale-pressure");
      const healthy = controlledPeer("healthy-pressure");
      const clients = new GatewayClientRegistry([stale.client, healthy.client]);
      const { broadcast, getBufferedAmount } = createGatewayBroadcaster({ clients });
      broadcast("tick", {});
      stale.socket.bufferedAmount = 4 * 1024 * 1024;
      const backend = { pause: vi.fn(), resume: vi.fn() };
      const output = new TerminalOutputController({
        backend,
        getConnIds: () => [stale.client.connId, healthy.client.connId],
        getBufferedAmount,
        record: vi.fn(),
        emit: vi.fn(),
      });
      try {
        output.reconcileRecipients();
        expect(backend.pause).toHaveBeenCalledOnce();
        if (retirement === "failed") {
          stale.callbacks[0]!(new Error("compression lost socket"));
        } else if (retirement === "closing") {
          stale.socket.readyState = WebSocket.CLOSING;
        } else {
          stale.client.invalidated = true;
        }
        expect(clients.has(stale.client)).toBe(true);
        output.reconcileRecipients();
        expect(backend.resume).toHaveBeenCalledOnce();
        expect(getBufferedAmount(stale.client.connId)).toBeUndefined();
      } finally {
        output.dispose();
      }
    },
  );

  it.each(["callback", "throw"])(
    "stops a terminal barrier when its pending flush fails by synchronous %s",
    (failure) => {
      const peer = controlledPeer("barrier");
      const { broadcast } = createGatewayBroadcaster({
        clients: new GatewayClientRegistry([peer.client]),
      });
      const owner = new AbortController();
      broadcast("tick", {});
      broadcast("chat", { text: "pending" }, { liveText: liveText(owner.signal) });
      sendError.mockClear();
      peer.socket.send.mockImplementationOnce((_wire, callback) => {
        const error = new Error("flush failed");
        if (failure === "throw") {
          throw error;
        }
        callback(error);
      });

      broadcast("chat", { text: "terminal" }, { liveText: { group: owner.signal } });
      peer.callbacks[0]!();

      expect(peer.socket.send).toHaveBeenCalledTimes(2);
      expect(peer.frames).toHaveLength(1);
      expect(peer.socket.terminate).toHaveBeenCalledOnce();
      expect(sendError).toHaveBeenCalledOnce();
      expect(getEventListeners(owner.signal, "abort")).toHaveLength(0);
    },
  );
});
