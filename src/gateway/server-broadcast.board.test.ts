import { describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
} from "../../packages/gateway-protocol/src/client-info.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import {
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "./server-chat-state.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { createSessionObserverAudience } from "./session-observer-audience.js";
import { resolveSessionSubscriptionKeys } from "./session-subscription-keys.js";

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

describe("skills event scope guards", () => {
  it("delivers skill invalidations only to read-capable operators", () => {
    const pairing = makeClient("pairing", "operator", ["operator.pairing"]);
    const node = makeClient("node", "node", ["operator.read"]);
    const read = makeClient("read", "operator", ["operator.read"]);
    const write = makeClient("write", "operator", ["operator.write"]);
    const admin = makeClient("admin", "operator", ["operator.admin"]);
    const clients = new Set([pairing, node, read, write, admin].map((entry) => entry.client));
    const { broadcast } = createGatewayBroadcaster({ clients });

    broadcast("skills.changed", { reason: "remote-node" });

    expect(pairing.socket.events).toEqual([]);
    expect(node.socket.events).toEqual([]);
    expect(read.socket.events).toEqual(["skills.changed"]);
    expect(write.socket.events).toEqual(["skills.changed"]);
    expect(admin.socket.events).toEqual(["skills.changed"]);
  });
});

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
  it("uses the payload session scope for observer subscription filtering", () => {
    const subscribed = makeClient("subscribed", "operator", ["operator.read"]);
    const otherSession = makeClient("other-session", "operator", ["operator.read"]);
    const unsubscribed = makeClient("unsubscribed", "operator", ["operator.read"]);
    for (const entry of [subscribed, otherSession, unsubscribed]) {
      entry.client.connect.caps = [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS];
    }
    const sessionMessageSubscribers = createSessionMessageSubscriberRegistry();
    sessionMessageSubscribers.subscribe(subscribed.client.connId, "agent:main:main");
    sessionMessageSubscribers.subscribe(otherSession.client.connId, "agent:main:other");
    const { broadcast } = createGatewayBroadcaster({
      clients: new Set([subscribed.client, otherSession.client, unsubscribed.client]),
      sessionMessageSubscribers,
    });

    broadcast(
      "session.observer",
      { sessionKey: "agent:main:main", revision: 1 },
      { dropIfSlow: true },
    );

    expect(subscribed.socket.events).toEqual(["session.observer"]);
    expect(otherSession.socket.events).toEqual([]);
    expect(unsubscribed.socket.events).toEqual([]);
  });

  it("delivers prepared global observer audiences exactly once", () => {
    const main = makeClient("main", "operator", ["operator.read"]);
    const legacy = makeClient("legacy", "operator", ["operator.read"]);
    const both = makeClient("both", "operator", ["operator.read"]);
    const work = makeClient("work", "operator", ["operator.read"]);
    const workRaw = makeClient("work-raw", "operator", ["operator.read"]);
    for (const entry of [main, legacy, both, work, workRaw]) {
      entry.client.connect.caps = [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS];
    }
    const subscribers = createSessionMessageSubscriberRegistry();
    subscribers.subscribe(main.client.connId, "agent:main:global");
    subscribers.subscribe(legacy.client.connId, "global");
    subscribers.subscribe(both.client.connId, "agent:main:global");
    subscribers.subscribe(both.client.connId, "global");
    subscribers.subscribe(work.client.connId, "agent:work:global");
    subscribers.subscribe(workRaw.client.connId, "global");
    const audience = createSessionObserverAudience({
      subscribers,
      isVisible: () => true,
      getDefaultAgentId: () => "main",
    });
    const { broadcastToConnIds } = createGatewayBroadcaster({
      clients: new Set([main.client, legacy.client, both.client, work.client, workRaw.client]),
      sessionMessageSubscribers: subscribers,
    });

    for (const agentId of ["main", "work"]) {
      const sessionKeys = resolveSessionSubscriptionKeys(" GLOBAL ", agentId, "MAIN");
      const recipients = audience.recipients("global", agentId);
      broadcastToConnIds("session.observer", { sessionKey: "global", agentId }, recipients, {
        sessionKeys,
        agentId,
      });
    }

    expect(main.socket.events).toEqual(["session.observer"]);
    expect(legacy.socket.events).toEqual(["session.observer"]);
    expect(both.socket.events).toEqual(["session.observer"]);
    expect(work.socket.events).toEqual(["session.observer"]);
    expect(workRaw.socket.events).toEqual(["session.observer"]);
  });

  it("preserves event-only recipients selected by the critical observer audience", () => {
    const message = makeClient("message", "operator", ["operator.read"]);
    const eventOnly = makeClient("event-only", "operator", ["operator.read"]);
    const unrelated = makeClient("unrelated", "operator", ["operator.read"]);
    for (const entry of [message, eventOnly, unrelated]) {
      entry.client.connect.caps = [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS];
    }
    const subscribers = createSessionMessageSubscriberRegistry();
    const sessionEventSubscribers = createSessionEventSubscriberRegistry();
    subscribers.subscribe(message.client.connId, "agent:main:global");
    sessionEventSubscribers.subscribe(eventOnly.client.connId);
    const audience = createSessionObserverAudience({
      subscribers,
      sessionEventSubscribers,
      isVisible: () => true,
      getDefaultAgentId: () => "main",
    });
    const { broadcastToConnIds } = createGatewayBroadcaster({
      clients: new Set([message.client, eventOnly.client, unrelated.client]),
      sessionMessageSubscribers: subscribers,
    });

    const recipients = audience.criticalRecipients("global", "main");
    broadcastToConnIds(
      "session.observer",
      { sessionKey: "global", agentId: "main" },
      recipients,
      audience.deliveryOptions("global", "main"),
    );

    expect(message.socket.events).toEqual(["session.observer"]);
    expect(eventOnly.socket.events).toEqual(["session.observer"]);
    expect(unrelated.socket.events).toEqual([]);
  });

  it.each(["agent", "chat", "chat.side_result"])(
    "keeps global %s events scoped to their owning agent",
    (event) => {
      const work = makeClient("work", "operator", ["operator.read"]);
      const main = makeClient("main", "operator", ["operator.read"]);
      const bareGlobal = makeClient("bare-global", "operator", ["operator.read"]);
      for (const entry of [work, main, bareGlobal]) {
        entry.client.connect.caps = [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS];
      }
      const subscribers = createSessionMessageSubscriberRegistry();
      subscribers.subscribe(work.client.connId, "agent:work:global");
      subscribers.subscribe(main.client.connId, "agent:main:global");
      subscribers.subscribe(bareGlobal.client.connId, "global");
      const { broadcast } = createGatewayBroadcaster({
        clients: new Set([work.client, main.client, bareGlobal.client]),
        sessionMessageSubscribers: subscribers,
      });

      broadcast(
        event,
        { sessionKey: "global", agentId: "work" },
        {
          sessionKeys: resolveSessionSubscriptionKeys("global", "work", "main"),
          agentId: "work",
        },
      );

      expect(work.socket.events).toEqual([event]);
      expect(main.socket.events).toEqual([]);
      expect(bareGlobal.socket.events).toEqual([]);
    },
  );

  it("subscription-gates Browser Copilot without relying on the capability bit", () => {
    const subscribed = makeClient("subscribed", "operator", ["operator.read"]);
    const unrelated = makeClient("unrelated", "operator", ["operator.read"]);
    for (const entry of [subscribed, unrelated]) {
      entry.client.connect.client = { id: GATEWAY_CLIENT_IDS.BROWSER_COPILOT } as never;
      entry.client.connect.caps = [];
    }
    const subscribers = createSessionMessageSubscriberRegistry();
    subscribers.subscribe(subscribed.client.connId, "agent:work:global");
    subscribers.subscribe(unrelated.client.connId, "agent:other:global");
    const { broadcast } = createGatewayBroadcaster({
      clients: new Set([subscribed.client, unrelated.client]),
      sessionMessageSubscribers: subscribers,
    });

    broadcast(
      "chat",
      { sessionKey: "global", agentId: "work" },
      {
        sessionKeys: ["agent:work:global"],
        agentId: "work",
      },
    );

    expect(subscribed.socket.events).toEqual(["chat"]);
    expect(unrelated.socket.events).toEqual([]);
  });

  it.each([
    { sessionKey: "agent:work:global", agentId: "work" },
    { sessionKey: "agent:work:other", agentId: "work" },
    { sessionKey: "global", agentId: undefined },
  ])("preserves exact subscription keys for $sessionKey", ({ sessionKey, agentId }) => {
    const subscribed = makeClient("subscribed", "operator", ["operator.read"]);
    const unrelated = makeClient("unrelated", "operator", ["operator.read"]);
    subscribed.client.connect.caps = [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS];
    unrelated.client.connect.caps = [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS];
    const subscribers = createSessionMessageSubscriberRegistry();
    subscribers.subscribe(subscribed.client.connId, sessionKey);
    subscribers.subscribe(unrelated.client.connId, "agent:other:global");
    const { broadcast } = createGatewayBroadcaster({
      clients: new Set([subscribed.client, unrelated.client]),
      sessionMessageSubscribers: subscribers,
    });

    broadcast("chat", { sessionKey, ...(agentId ? { agentId } : {}) });

    expect(subscribed.socket.events).toEqual(["chat"]);
    expect(unrelated.socket.events).toEqual([]);
  });

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
