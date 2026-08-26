// Covers broadcast frame-serialization failure: an unserializable payload must
// not consume per-client seqs (which would fire every client's gap detector and
// cause a synchronized reconnect storm) and must leave a server-side record.
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { setVerbose } from "../global-state.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import type { GatewayWsClient } from "./server/ws-types.js";

const warnSpy = vi.hoisted(() => vi.fn());

vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      if (subsystem !== "gateway/broadcast") {
        return logger;
      }
      return { ...logger, error: warnSpy };
    },
  };
});

type RecordingSocket = {
  readyState: number;
  bufferedAmount: number;
  close: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  frames: Array<{ event: string; seq: number }>;
};

function makeClient(connId: string): { client: GatewayWsClient; socket: RecordingSocket } {
  const frames: Array<{ event: string; seq: number }> = [];
  const socket: RecordingSocket = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    close: vi.fn(),
    send: vi.fn((payload: string) => {
      const frame = JSON.parse(payload) as { event: string; seq: number };
      frames.push({ event: frame.event, seq: frame.seq });
    }),
    frames,
  };
  return {
    client: {
      socket: socket as unknown as GatewayWsClient["socket"],
      connect: { role: "operator", scopes: ["operator.read"] } as GatewayWsClient["connect"],
      connId,
      usesSharedGatewayAuth: false,
    },
    socket,
  };
}

afterEach(() => {
  setVerbose(false);
  setLoggerOverride(null);
  resetLogger();
});

describe("broadcast serialization failures", () => {
  it.each([
    { state: "closing", readyState: WebSocket.CLOSING },
    { state: "closed", readyState: WebSocket.CLOSED },
  ])("skips $state sockets without disrupting healthy broadcast sequences", ({ readyState }) => {
    const retired = makeClient("retired");
    const healthy = makeClient("healthy");
    const clients = new Set([retired.client, healthy.client]);
    const { broadcast, broadcastToConnIds } = createGatewayBroadcaster({ clients });

    retired.socket.readyState = readyState;
    broadcast("skills.changed", { reason: "first" });
    broadcastToConnIds("skills.changed", { reason: "second" }, new Set(["healthy", "retired"]));

    expect(retired.socket.send).not.toHaveBeenCalled();
    expect(clients.has(retired.client)).toBe(true);
    expect(healthy.socket.frames).toEqual([
      { event: "skills.changed", seq: 1 },
      { event: "skills.changed", seq: 2 },
    ]);
  });

  it("keeps a real healthy peer delivering while rejecting closing and failed peers", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    const connectPeer = async () => {
      const accepted = once(server, "connection");
      const peer = new WebSocket(`ws://127.0.0.1:${address.port}`);
      await once(peer, "open");
      const [socket] = (await accepted) as [WebSocket];
      return { peer, socket };
    };
    const retired = await connectPeer();
    const broken = await connectPeer();
    const healthy = await connectPeer();
    const delivered: Array<{ event: string; seq: number }> = [];
    healthy.peer.on("message", (data: RawData) => {
      delivered.push(JSON.parse(rawDataToString(data)) as { event: string; seq: number });
    });
    const makeRealClient = (connId: string, socket: WebSocket): GatewayWsClient => ({
      connId,
      socket,
      connect: { role: "operator", scopes: ["operator.read"] } as GatewayWsClient["connect"],
      usesSharedGatewayAuth: false,
    });
    const retiredClient = makeRealClient("real-retired", retired.socket);
    const brokenClient = makeRealClient("real-broken", broken.socket);
    const healthyClient = makeRealClient("real-healthy", healthy.socket);
    const clients = new Set([retiredClient, brokenClient, healthyClient]);
    const { broadcast, broadcastToConnIds } = createGatewayBroadcaster({ clients });

    try {
      warnSpy.mockClear();
      const brokenPeerClosed = vi.fn();
      broken.peer.once("close", brokenPeerClosed);
      vi.spyOn(broken.socket, "send").mockImplementationOnce(() => {
        throw new Error("injected synchronous send failure");
      });
      retired.socket.close(1000, "retiring peer");
      expect(retired.socket.readyState).toBe(WebSocket.CLOSING);
      const bufferedAtClose = retired.socket.bufferedAmount;

      broadcast("chat", {
        state: "final",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      });
      broadcastToConnIds("skills.changed", { reason: "targeted" }, new Set(["real-healthy"]));
      await vi.waitFor(() => expect(delivered).toHaveLength(2));
      await vi.waitFor(() => expect(brokenPeerClosed).toHaveBeenCalledOnce());

      expect(retired.socket.bufferedAmount).toBe(bufferedAtClose);
      expect(clients.has(retiredClient)).toBe(true);
      expect(delivered.map(({ event, seq }) => ({ event, seq }))).toEqual([
        { event: "chat", seq: 1 },
        { event: "skills.changed", seq: 2 },
      ]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("real-broken: injected synchronous send failure"),
        { event: "chat" },
      );

      let callbackError: Error | undefined;
      retired.socket.send("dependency-callback-proof", (error) => {
        callbackError = error;
      });
      expect(callbackError).toBeUndefined();
      await vi.waitFor(() => expect(callbackError).toBeInstanceOf(Error));
    } finally {
      retired.peer.terminate();
      broken.peer.terminate();
      healthy.peer.terminate();
      for (const activeSocket of server.clients) {
        activeSocket.terminate();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("drops the event without consuming seqs when the payload cannot serialize", () => {
    warnSpy.mockClear();
    const first = makeClient("first");
    const second = makeClient("second");
    const clients = new Set([first.client, second.client]);
    const { broadcast } = createGatewayBroadcaster({ clients });

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    broadcast("skills.changed", circular);

    // Neither socket saw the bad frame, and the failure is recorded once.
    expect(first.socket.send).not.toHaveBeenCalled();
    expect(second.socket.send).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("skills.changed");

    // The next good broadcast starts at seq 1 for every client: the dropped
    // event consumed no seq, so no gap detector fires.
    broadcast("skills.changed", { reason: "recovered" });
    expect(first.socket.frames).toEqual([{ event: "skills.changed", seq: 1 }]);
    expect(second.socket.frames).toEqual([{ event: "skills.changed", seq: 1 }]);
  });

  it("does not inspect agent log summaries for an ineligible outbound broadcast", () => {
    setVerbose(true);
    setLoggerOverride({ level: "silent", consoleLevel: "info" });
    const filtered = makeClient("filtered");
    filtered.client.connect.scopes = [];
    const { broadcast } = createGatewayBroadcaster({ clients: new Set([filtered.client]) });
    let dataReads = 0;
    const payload = {
      runId: "run-1",
      stream: "assistant",
      get data() {
        dataReads += 1;
        return { text: "not delivered" };
      },
    };

    broadcast("agent", payload);

    expect(filtered.socket.send).not.toHaveBeenCalled();
    expect(dataReads).toBe(0);
  });
});
