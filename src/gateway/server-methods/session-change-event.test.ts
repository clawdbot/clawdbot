import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBroadcastToConnIdsFn } from "../server-broadcast-types.js";

const sessionRow = vi.hoisted(() => ({
  key: "agent:main:main",
  kind: "direct",
  sessionId: "sess-main",
  status: "done",
  updatedAt: 1,
  label: "Renamed chat",
}));
const loadGatewaySessionRowMock = vi.hoisted(() => vi.fn(() => sessionRow));

vi.mock("../session-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session-utils.js")>();
  return { ...actual, loadGatewaySessionRow: loadGatewaySessionRowMock };
});

const { emitSessionsChanged } = await import("./session-change-event.js");
const { createGatewayBroadcaster } = await import("../server-broadcast.js");
const { subscribePluginSessionsChanged } = await import("../../plugins/gateway-events.js");

type SessionsChangedContext = Parameters<typeof emitSessionsChanged>[0];

const titleChange = { sessionKey: "agent:main:main", reason: "chat.title" };
const pluginNotice = {
  sessionKey: "agent:main:main",
  label: "Renamed chat",
  reason: "chat.title",
};

function createContext(
  broadcastToConnIds: GatewayBroadcastToConnIdsFn,
  connIds: readonly string[] = [],
): SessionsChangedContext {
  return {
    broadcastToConnIds,
    chatAbortControllers: new Map(),
    getRuntimeConfig: () => ({}),
    getSessionEventSubscriberConnIds: () => new Set(connIds),
  };
}

describe("emitSessionsChanged", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("publishes session changes to plugins without websocket subscribers", async () => {
    const received = vi.fn();
    const unsubscribe = subscribePluginSessionsChanged(received);
    const { broadcastToConnIds } = createGatewayBroadcaster({ clients: new Set() });

    try {
      emitSessionsChanged(createContext(broadcastToConnIds), titleChange);
      await Promise.resolve();
      expect(received).toHaveBeenCalledWith(pluginNotice);
    } finally {
      unsubscribe();
    }
  });

  it("keeps publishing to plugins while websocket subscribers are connected", async () => {
    const received = vi.fn();
    const unsubscribe = subscribePluginSessionsChanged(received);
    const { broadcastToConnIds } = createGatewayBroadcaster({ clients: new Set() });

    try {
      emitSessionsChanged(createContext(broadcastToConnIds, ["conn-1"]), titleChange);
      await Promise.resolve();
      expect(received).toHaveBeenCalledWith(pluginNotice);
    } finally {
      unsubscribe();
    }
  });

  it("still targets websocket subscribers when no plugin subscribes", () => {
    const broadcastToConnIds = vi.fn();

    emitSessionsChanged(createContext(broadcastToConnIds, ["conn-1"]), titleChange);

    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.changed",
      expect.objectContaining(titleChange),
      new Set(["conn-1"]),
      expect.objectContaining({ dropIfSlow: true }),
    );
  });

  it("skips the session row load when no websocket or plugin subscriber listens", () => {
    const broadcastToConnIds = vi.fn();

    emitSessionsChanged(createContext(broadcastToConnIds), titleChange);

    expect(broadcastToConnIds).not.toHaveBeenCalled();
    expect(loadGatewaySessionRowMock).not.toHaveBeenCalled();
  });
});
