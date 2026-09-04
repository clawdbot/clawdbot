import { getEventListeners } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { createSessionMessageSubscriberRegistry } from "./server-chat-state.js";
import { MAX_BUFFERED_BYTES } from "./server-constants.js";
import { GatewayClientRegistry } from "./server/client-registry.js";
import type { GatewayWsClient } from "./server/ws-types.js";

type TextPayload = { sessionKey: string; text: string; delta?: string };
type Frame = { type: "event"; event: string; seq: number; payload: TextPayload };
type PeerSocket = {
  readyState: number;
  bufferedAmount: number;
  close: () => void;
  terminate: () => void;
  send: (wire: string, callback?: (error?: Error) => void) => void;
};

function createPeer(connId: string, completeImmediately = false) {
  const callbacks: Array<(error?: Error) => void> = [];
  const frames: Frame[] = [];
  const socket: PeerSocket = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    close: vi.fn(),
    terminate: vi.fn(),
    send: vi.fn((wire: string, callback?: (error?: Error) => void) => {
      frames.push(JSON.parse(wire) as Frame);
      if (completeImmediately) {
        callback?.();
      } else if (callback) {
        callbacks.push(callback);
      }
    }),
  };
  const client: GatewayWsClient = {
    connId,
    socket: socket as unknown as GatewayWsClient["socket"],
    connect: { role: "operator", scopes: ["operator.read"] } as GatewayWsClient["connect"],
    usesSharedGatewayAuth: false,
  };
  return { client, socket, frames, complete: (error?: Error) => callbacks.shift()?.(error) };
}

function createBufferedPeer(connId: string, bufferedAmount: number) {
  const peer = createPeer(connId);
  const send = peer.socket.send;
  peer.socket.bufferedAmount = bufferedAmount;
  peer.socket.send = (wire, callback) => {
    const bytes = Buffer.byteLength(wire);
    peer.socket.bufferedAmount += bytes + (bytes < 126 ? 2 : bytes < 65536 ? 4 : 10);
    send(wire, callback);
  };
  return peer;
}

const mergeText = (previous: unknown, next: unknown): TextPayload => ({
  ...(next as TextPayload),
  delta: ((previous as TextPayload).delta ?? "") + ((next as TextPayload).delta ?? ""),
});
const replaceText = (_previous: unknown, next: unknown) => next;
const text = (value: string, delta?: string): TextPayload => ({
  sessionKey: "agent:main:stream",
  text: value,
  ...(delta === undefined ? {} : { delta }),
});

describe("connection live-text delivery", () => {
  it("coalesces each blocked peer independently and flushes only the terminal's group", () => {
    const slow = createPeer("slow");
    const fast = createPeer("fast", true);
    const onBroadcast = vi.fn();
    const { broadcast } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([slow.client, fast.client]),
      onBroadcast,
    });
    const group = new AbortController().signal;
    const other = new AbortController().signal;
    const agent = { liveText: { group, coalesce: { key: "agent", merge: mergeText } } };
    const chat = { liveText: { group, coalesce: { key: "chat", merge: replaceText } } };
    broadcast("agent", text("A", "A"), agent);
    broadcast("agent", text("AB", "B"), agent);
    broadcast("chat", text("AB"), chat);
    broadcast("agent", text("ABC", "C"), agent);
    broadcast("chat", text("ABC"), chat);
    broadcast("agent", text("X", "X"), {
      liveText: { group: other, coalesce: { key: "agent", merge: mergeText } },
    });
    broadcast("agent", text("ABCD", "D"), agent);

    expect(slow.frames).toHaveLength(1);
    expect(fast.frames).toHaveLength(7);
    broadcast("agent", text("tool boundary"), { liveText: { group } });
    broadcast("chat", text("ABCD final"), { liveText: { group } });
    expect(slow.frames.map(({ event, seq, payload }) => ({ event, seq, ...payload }))).toEqual([
      { event: "agent", seq: 1, ...text("A", "A") },
      { event: "chat", seq: 2, ...text("ABC") },
      { event: "agent", seq: 3, ...text("ABCD", "BCD") },
      { event: "agent", seq: 4, ...text("tool boundary") },
      { event: "chat", seq: 5, ...text("ABCD final") },
    ]);
    expect(onBroadcast).toHaveBeenCalledTimes(9);
    expect(fast.frames.map(({ seq }) => seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);

    for (let i = 0; i < 4; i += 1) {
      slow.complete();
    }
    expect(slow.frames).toHaveLength(5);
    slow.complete();
    expect(slow.frames.at(-1)).toEqual({
      type: "event",
      event: "agent",
      seq: 6,
      payload: text("X", "X"),
    });
    slow.complete();
    broadcast("chat", text("next run"), { liveText: { group: new AbortController().signal } });
    expect(slow.frames.at(-1)?.seq).toBe(7);
  });

  it.each([
    "owner",
    "membership",
    "invalidated",
    "socket",
    "replacement socket",
    "scope",
    "subscription",
    "visibility",
    "throwing visibility",
  ] as const)("rechecks current %s before a pending send", (revoked) => {
    const peer = createPeer("subscriber");
    peer.client.connect.caps = [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS];
    const clients = new GatewayClientRegistry([peer.client]);
    const subscribers = createSessionMessageSubscriberRegistry();
    subscribers.subscribe(peer.client.connId, "agent:main:stream");
    let current = true;
    let visible = true;
    const { broadcast } = createGatewayBroadcaster({
      clients,
      sessionMessageSubscribers: subscribers,
      canReceiveSessionEvent: () => {
        if (!visible && revoked === "throwing visibility") {
          throw new Error("permission retired");
        }
        return visible;
      },
    });
    const opts = {
      liveText: {
        group: new AbortController().signal,
        isCurrent: () => current,
        coalesce: { key: "text", merge: mergeText },
      },
    };
    broadcast("agent", text("A", "A"), opts);
    broadcast("agent", text("AB", "B"), opts);
    expect(peer.frames).toHaveLength(1);
    if (revoked === "owner") {
      current = false;
    }
    if (revoked === "membership") {
      clients.delete(peer.client);
    }
    if (revoked === "invalidated") {
      peer.client.invalidated = true;
    }
    if (revoked === "socket") {
      peer.socket.readyState = WebSocket.CLOSED;
    }
    if (revoked === "replacement socket") {
      peer.client.socket = createPeer("replacement").client.socket;
    }
    if (revoked === "scope") {
      peer.client.connect.scopes = [];
    }
    if (revoked === "subscription") {
      subscribers.unsubscribe(peer.client.connId, "agent:main:stream");
    }
    if (revoked === "visibility" || revoked === "throwing visibility") {
      visible = false;
    }
    expect(() => peer.complete()).not.toThrow();
    expect(peer.frames).toHaveLength(1);
  });

  it("releases a retired group's reservations before a held writer admits its successor", () => {
    const first = createBufferedPeer("retirement-0", MAX_BUFFERED_BYTES - 16384);
    const peers = [
      first,
      ...Array.from({ length: 31 }, (_, index) =>
        createBufferedPeer(`retirement-${index + 1}`, MAX_BUFFERED_BYTES - 16384),
      ),
    ];
    const { broadcast, getBufferedAmount } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry(peers.map((peer) => peer.client)),
    });
    const retired = new AbortController();
    const sibling = new AbortController();
    const coalesce = { key: "text", merge: replaceText };
    broadcast("tick", {});
    broadcast("chat", text("retired".repeat(1024)), {
      liveText: { group: retired.signal, coalesce },
    });
    const retiredBytes = getBufferedAmount(first.client.connId)! - first.socket.bufferedAmount;
    broadcast("chat", text("sibling".repeat(256)), {
      liveText: { group: sibling.signal, coalesce },
    });
    broadcast("tick", { text: "written".repeat(1200) });
    const before = getBufferedAmount(first.client.connId)!;
    expect(before).toBeGreaterThan(MAX_BUFFERED_BYTES);
    expect(first.socket.bufferedAmount).toBeLessThan(MAX_BUFFERED_BYTES);

    retired.abort();
    for (const peer of peers) {
      expect(getBufferedAmount(peer.client.connId)).toBe(before - retiredBytes);
      expect(getBufferedAmount(peer.client.connId)).toBeGreaterThan(peer.socket.bufferedAmount);
    }
    // A captured retired group still carries its abort terminal, but no old progress.
    broadcast("chat", text("aborted"), { liveText: { group: retired.signal } });
    broadcast("chat", text("stale"), { liveText: { group: retired.signal, coalesce } });
    broadcast("chat", text("successor final"));
    for (const peer of peers) {
      expect(peer.frames.map(({ seq }) => seq)).toEqual([1, 2, 3, 4]);
      peer.socket.bufferedAmount = 0;
      for (let index = 0; index < 5; index += 1) {
        peer.complete();
      }
      expect(peer.frames.slice(2).map(({ payload }) => payload.text)).toEqual([
        "aborted",
        "successor final",
        "sibling".repeat(256),
      ]);
      expect(peer.frames.map(({ seq }) => seq)).toEqual([1, 2, 3, 4, 5]);
      expect(peer.socket.close).not.toHaveBeenCalled();
      expect(peer.socket.terminate).not.toHaveBeenCalled();
    }
    sibling.abort();
  });

  it.each(["drain", "send error", "socket replacement"] as const)(
    "detaches retirement callbacks after %s releases the queue",
    (release) => {
      const peer = createPeer("cleanup");
      const { broadcast, getBufferedAmount } = createGatewayBroadcaster({
        clients: new GatewayClientRegistry([peer.client]),
      });
      const owner = new AbortController();
      broadcast("tick", {});
      broadcast("chat", text("pending"), {
        liveText: { group: owner.signal, coalesce: { key: "text", merge: replaceText } },
      });
      expect(getBufferedAmount(peer.client.connId)).toBeGreaterThan(0);
      if (release === "socket replacement") {
        peer.client.socket = createPeer("replacement").client.socket;
      } else {
        peer.complete(release === "send error" ? new Error("connection closed") : undefined);
      }
      expect(getBufferedAmount(peer.client.connId)).toBe(0);
      expect(getEventListeners(owner.signal, "abort")).toHaveLength(0);
      owner.abort();
      peer.complete();
      expect(peer.frames).toHaveLength(release === "drain" ? 2 : 1);
    },
  );

  it("does not merge a revoked owner's pending delta into its replacement", () => {
    const peer = createPeer("replacement");
    const { broadcast } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([peer.client]),
    });
    const group = new AbortController().signal;
    const coalesce = { key: "agent", merge: mergeText };
    let current = true;
    const original = { liveText: { group, coalesce, isCurrent: () => current } };
    broadcast("agent", text("A", "A"), original);
    broadcast("agent", text("AB", "B"), original);
    expect(peer.frames).toHaveLength(1);
    current = false;
    broadcast("agent", text("fresh", "fresh"), {
      liveText: { group, coalesce, isCurrent: () => true },
    });
    peer.complete();
    expect(peer.frames.at(-1)).toEqual({
      type: "event",
      event: "agent",
      seq: 2,
      payload: text("fresh", "fresh"),
    });
  });

  it("rechecks an ordinary targeted subscriber after unsubscribe", () => {
    const peer = createPeer("ordinary-subscriber");
    const subscribers = createSessionMessageSubscriberRegistry();
    subscribers.subscribe(peer.client.connId, "agent:main:stream");
    const { broadcastToConnIds } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([peer.client]),
      sessionMessageSubscribers: subscribers,
    });
    const recipients = new Set([peer.client.connId]);
    const opts = {
      sessionSubscriptionVerified: true,
      liveText: {
        group: new AbortController().signal,
        coalesce: { key: "agent", merge: mergeText },
      },
    };
    broadcastToConnIds("agent", text("A", "A"), recipients, opts);
    broadcastToConnIds("agent", text("AB", "B"), recipients, opts);
    expect(peer.frames).toHaveLength(1);
    subscribers.unsubscribe(peer.client.connId, "agent:main:stream");
    peer.complete();
    expect(peer.frames).toHaveLength(1);
  });

  it("shares transport capacity with pending replacements before either queue fills", () => {
    const peer = createBufferedPeer("shared-budget", MAX_BUFFERED_BYTES - 8192);
    const { broadcast } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([peer.client]),
    });
    const group = new AbortController().signal;
    const opts = { liveText: { group, coalesce: { key: "first", merge: replaceText } } };
    broadcast("tick", {});
    broadcast("chat", text("A".repeat(4096)), opts);
    broadcast("chat", text("B".repeat(4096)), opts);
    expect(peer.frames).toHaveLength(1);

    broadcast("chat", text("C".repeat(4096)), {
      liveText: { group, coalesce: { key: "second", merge: replaceText } },
    });

    expect(peer.frames.map(({ seq }) => seq)).toEqual([1, 2, 3]);
    expect(peer.frames.slice(1).map(({ payload }) => payload.text)).toEqual([
      "B".repeat(4096),
      "C".repeat(4096),
    ]);
    expect(peer.socket.close).not.toHaveBeenCalled();
  });

  it("reports current pending replacement pressure and resets it for a replacement socket", () => {
    const peer = createBufferedPeer("pressure", 1024);
    const { broadcast, getBufferedAmount } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([peer.client]),
    });
    const opts = {
      liveText: {
        group: new AbortController().signal,
        coalesce: { key: "text", merge: replaceText },
      },
    };
    broadcast("tick", {});
    broadcast("chat", text("A".repeat(4096)), opts);
    const large = getBufferedAmount(peer.client.connId)!;
    expect(large).toBeGreaterThan(peer.socket.bufferedAmount);
    broadcast("chat", text("B".repeat(2048)), opts);
    expect(getBufferedAmount(peer.client.connId)).toBeLessThan(large);
    expect(getBufferedAmount(peer.client.connId)).toBeGreaterThan(peer.socket.bufferedAmount);
    expect(peer.frames).toHaveLength(1);

    const replacement = createBufferedPeer("replacement", 128);
    peer.client.socket = replacement.client.socket;
    expect(getBufferedAmount(peer.client.connId)).toBe(128);
    peer.complete();
    expect(peer.frames).toHaveLength(1);
    expect(replacement.frames).toHaveLength(0);
    expect(getBufferedAmount(peer.client.connId)).toBe(128);
  });

  it.each([0, 1])(
    "reserves complete pending frames at the byte limit (overflow=%s)",
    (overflow) => {
      const peer = createBufferedPeer("frame-budget", 0);
      const { broadcast, getBufferedAmount } = createGatewayBroadcaster({
        clients: new GatewayClientRegistry([peer.client]),
      });
      const group = new AbortController().signal;
      const payloads = [text('first "🦞"'), text("second\n\\")];
      const stateVersion = { presence: 7, health: 3 };
      const reservedBytes = payloads.reduce(
        (total, payload) =>
          total +
          10 +
          Buffer.byteLength(
            JSON.stringify({
              type: "event",
              event: "chat",
              payload,
              seq: Number.MAX_SAFE_INTEGER,
              stateVersion,
            }),
          ),
        0,
      );
      broadcast("tick", {});
      peer.socket.bufferedAmount = MAX_BUFFERED_BYTES - reservedBytes + overflow;
      payloads.forEach((payload, index) => {
        broadcast("chat", payload, {
          stateVersion,
          liveText: { group, coalesce: { key: String(index), merge: replaceText } },
        });
      });

      expect(peer.frames).toHaveLength(overflow ? 3 : 1);
      expect(getBufferedAmount(peer.client.connId)).toBeLessThanOrEqual(MAX_BUFFERED_BYTES);
      if (!overflow) {
        expect(getBufferedAmount(peer.client.connId)).toBe(MAX_BUFFERED_BYTES);
      }
      peer.socket.bufferedAmount = 0;
      for (let i = 0; i < 3; i += 1) {
        peer.complete();
      }
      broadcast("chat", text("final"), { liveText: { group } });
      peer.complete();
      expect(peer.frames.map(({ seq }) => seq)).toEqual([1, 2, 3, 4]);
      expect(peer.frames.slice(1).map(({ payload }) => payload)).toEqual([
        ...payloads,
        text("final"),
      ]);
      expect(peer.socket.close).not.toHaveBeenCalled();
      expect(peer.socket.terminate).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "applies slow-consumer policy to sibling pending bytes after an ordinary write (droppable=%s)",
    (dropIfSlow) => {
      const peer = createBufferedPeer("sibling-pressure", MAX_BUFFERED_BYTES - 8192);
      const { broadcast } = createGatewayBroadcaster({
        clients: new GatewayClientRegistry([peer.client]),
      });
      broadcast("tick", {});
      broadcast("chat", text("A".repeat(4096)), {
        liveText: {
          group: new AbortController().signal,
          coalesce: { key: "text", merge: replaceText },
        },
      });
      broadcast("tick", { text: "B".repeat(4096) });
      expect(peer.frames).toHaveLength(2);
      expect(peer.socket.bufferedAmount).toBeLessThan(MAX_BUFFERED_BYTES);

      broadcast("tick", { marker: "over shared budget" }, { dropIfSlow });

      expect(peer.frames).toHaveLength(2);
      if (dropIfSlow) {
        expect(peer.socket.close).not.toHaveBeenCalled();
        expect(peer.socket.terminate).not.toHaveBeenCalled();
        peer.socket.bufferedAmount = 0;
        peer.complete();
        peer.complete();
        expect(peer.frames.at(-1)).toMatchObject({ seq: 4, payload: text("A".repeat(4096)) });
      } else {
        expect(peer.socket.close).toHaveBeenCalledWith(1008, "slow consumer");
        expect(peer.socket.terminate).toHaveBeenCalledOnce();
      }
    },
  );

  it.each([false, true])(
    "preserves slow-consumer closure with nonzero transport backlog (coalesce=%s)",
    (coalesce) => {
      const peer = createBufferedPeer("backlogged", MAX_BUFFERED_BYTES - 4096);
      const { broadcast } = createGatewayBroadcaster({
        clients: new GatewayClientRegistry([peer.client]),
      });
      const group = new AbortController().signal;
      const payload = text("x".repeat(3072));
      broadcast("tick", {});
      for (const key of ["first", "second"]) {
        broadcast(
          "agent",
          payload,
          coalesce ? { liveText: { group, coalesce: { key, merge: replaceText } } } : undefined,
        );
      }
      broadcast("chat", text("final"), coalesce ? { liveText: { group } } : undefined);

      expect(peer.frames.map(({ event, seq }) => ({ event, seq }))).toEqual([
        { event: "tick", seq: 1 },
        { event: "agent", seq: 2 },
        { event: "agent", seq: 3 },
      ]);
      expect(peer.socket.bufferedAmount).toBeGreaterThan(MAX_BUFFERED_BYTES);
      expect(peer.socket.close).toHaveBeenCalledExactlyOnceWith(1008, "slow consumer");
      expect(peer.socket.terminate).toHaveBeenCalledOnce();
    },
  );

  it("flushes the affected group instead of retaining more than the existing byte limit", () => {
    const peer = createPeer("bounded");
    const { broadcast } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([peer.client]),
    });
    const group = new AbortController().signal;
    const payload = text("x".repeat(MAX_BUFFERED_BYTES / 2));
    broadcast("tick", {});
    broadcast("chat", payload, {
      liveText: { group, coalesce: { key: "first", merge: replaceText } },
    });
    expect(peer.frames).toHaveLength(1);
    broadcast("chat", payload, {
      liveText: { group, coalesce: { key: "second", merge: replaceText } },
    });
    expect(peer.frames.map(({ seq }) => seq)).toEqual([1, 2, 3]);
    expect(peer.socket.close).not.toHaveBeenCalled();
    for (let i = 0; i < 3; i += 1) {
      peer.complete();
    }
    expect(peer.frames).toHaveLength(3);
  });
});
