import { beforeEach, describe, expect, it, vi } from "vitest";
import { matrixPlugin } from "../../channel.js";
import {
  __testing as sessionBindingTesting,
  createTestRegistry,
  registerSessionBindingAdapter,
  resolveAgentRoute,
  setActivePluginRegistry,
  type OpenClawConfig,
} from "../../test-support/monitor-route-test-support.js";
import { resolveMatrixInboundRoute } from "./route.js";

const baseCfg = {
  session: { mainKey: "main" },
  agents: {
    list: [{ id: "main" }, { id: "sender-agent" }, { id: "room-agent" }, { id: "acp-agent" }],
  },
} satisfies OpenClawConfig;

type RouteBinding = NonNullable<OpenClawConfig["bindings"]>[number];
type RoutePeer = NonNullable<RouteBinding["match"]["peer"]>;

function matrixBinding(
  agentId: string,
  peer?: RoutePeer,
  type?: RouteBinding["type"],
): RouteBinding {
  return {
    ...(type ? { type } : {}),
    agentId,
    match: {
      channel: "matrix",
      accountId: "ops",
      ...(peer ? { peer } : {}),
    },
  } as RouteBinding;
}

function senderPeer(id = "@alice:example.org"): RoutePeer {
  return { kind: "direct", id };
}

function dmRoomPeer(id = "!dm:example.org"): RoutePeer {
  return { kind: "channel", id };
}

function resolveDmRoute(
  cfg: OpenClawConfig,
  opts: {
    dmSessionScope?: "per-user" | "per-room";
  } = {},
) {
  return resolveMatrixInboundRoute({
    cfg,
    accountId: "ops",
    roomId: "!dm:example.org",
    senderId: "@alice:example.org",
    isDirectMessage: true,
    dmSessionScope: opts.dmSessionScope,
    resolveAgentRoute,
  });
}

describe("resolveMatrixInboundRoute", () => {
  beforeEach(() => {
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "matrix", source: "test", plugin: matrixPlugin }]),
    );
  });

  it("prefers sender-bound DM routing over DM room fallback bindings", () => {
    const cfg = {
      ...baseCfg,
      bindings: [
        matrixBinding("room-agent", dmRoomPeer()),
        matrixBinding("sender-agent", senderPeer()),
      ],
    } satisfies OpenClawConfig;

    const { route, configuredBinding } = resolveDmRoute(cfg);

    expect(configuredBinding).toBeNull();
    expect(route.agentId).toBe("sender-agent");
    expect(route.matchedBy).toBe("binding.peer");
    expect(route.sessionKey).toBe("agent:sender-agent:main");
  });

  it("uses the DM room as a parent-peer fallback before account-level bindings", () => {
    const cfg = {
      ...baseCfg,
      bindings: [matrixBinding("acp-agent"), matrixBinding("room-agent", dmRoomPeer())],
    } satisfies OpenClawConfig;

    const { route, configuredBinding } = resolveDmRoute(cfg);

    expect(configuredBinding).toBeNull();
    expect(route.agentId).toBe("room-agent");
    expect(route.matchedBy).toBe("binding.peer.parent");
    expect(route.sessionKey).toBe("agent:room-agent:main");
  });

  it("can isolate Matrix DMs per room without changing agent selection", () => {
    const cfg = {
      ...baseCfg,
      bindings: [matrixBinding("sender-agent", senderPeer())],
    } satisfies OpenClawConfig;

    const { route, configuredBinding } = resolveDmRoute(cfg, {
      dmSessionScope: "per-room",
    });

    expect(configuredBinding).toBeNull();
    expect(route.agentId).toBe("sender-agent");
    expect(route.matchedBy).toBe("binding.peer");
    expect(route.sessionKey).toBe("agent:sender-agent:matrix:channel:!dm:example.org");
    expect(route.mainSessionKey).toBe("agent:sender-agent:main");
    expect(route.lastRoutePolicy).toBe("session");
  });

  it("lets configured ACP room bindings override DM parent-peer routing", () => {
    const cfg = {
      ...baseCfg,
      bindings: [
        matrixBinding("room-agent", dmRoomPeer()),
        matrixBinding("acp-agent", dmRoomPeer(), "acp"),
      ],
    } satisfies OpenClawConfig;

    const { route, configuredBinding } = resolveDmRoute(cfg);

    expect(configuredBinding?.spec.agentId).toBe("acp-agent");
    expect(route.agentId).toBe("acp-agent");
    expect(route.matchedBy).toBe("binding.channel");
    expect(route.sessionKey).toContain("agent:acp-agent:acp:binding:matrix:ops:");
    expect(route.lastRoutePolicy).toBe("session");
  });

  it("keeps configured ACP room bindings ahead of per-room DM session scope", () => {
    const cfg = {
      ...baseCfg,
      bindings: [
        matrixBinding("room-agent", dmRoomPeer()),
        matrixBinding("acp-agent", dmRoomPeer(), "acp"),
      ],
    } satisfies OpenClawConfig;

    const { route, configuredBinding } = resolveDmRoute(cfg, {
      dmSessionScope: "per-room",
    });

    expect(configuredBinding?.spec.agentId).toBe("acp-agent");
    expect(route.agentId).toBe("acp-agent");
    expect(route.matchedBy).toBe("binding.channel");
    expect(route.sessionKey).toContain("agent:acp-agent:acp:binding:matrix:ops:");
    expect(route.sessionKey).not.toBe("agent:acp-agent:matrix:channel:!dm:example.org");
    expect(route.lastRoutePolicy).toBe("session");
  });

  it("lets runtime conversation bindings override both sender and room route matches", () => {
    const touch = vi.fn();
    registerSessionBindingAdapter({
      channel: "matrix",
      accountId: "ops",
      listBySession: () => [],
      resolveByConversation: (ref) =>
        ref.conversationId === "!dm:example.org"
          ? {
              bindingId: "ops:!dm:example.org",
              targetSessionKey: "agent:bound:session-1",
              targetKind: "session",
              conversation: {
                channel: "matrix",
                accountId: "ops",
                conversationId: "!dm:example.org",
              },
              status: "active",
              boundAt: Date.now(),
              metadata: { boundBy: "user-1" },
            }
          : null,
      touch,
    });

    const cfg = {
      ...baseCfg,
      bindings: [
        matrixBinding("sender-agent", senderPeer()),
        matrixBinding("room-agent", dmRoomPeer()),
      ],
    } satisfies OpenClawConfig;

    const { route, configuredBinding, runtimeBindingId } = resolveDmRoute(cfg);

    expect(configuredBinding).toBeNull();
    expect(runtimeBindingId).toBe("ops:!dm:example.org");
    expect(route.agentId).toBe("bound");
    expect(route.matchedBy).toBe("binding.channel");
    expect(route.sessionKey).toBe("agent:bound:session-1");
    expect(route.lastRoutePolicy).toBe("session");
    expect(touch).not.toHaveBeenCalled();
  });
});

describe("resolveMatrixInboundRoute thread-isolated sessions", () => {
  beforeEach(() => {
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "matrix", source: "test", plugin: matrixPlugin }]),
    );
  });

  it("scopes session key to thread when a thread id is provided", () => {
    const { route } = resolveMatrixInboundRoute({
      cfg: baseCfg as never,
      accountId: "ops",
      roomId: "!room:example.org",
      senderId: "@alice:example.org",
      isDirectMessage: false,
      threadId: "$thread-root",
      resolveAgentRoute,
    });

    expect(route.sessionKey).toContain(":thread:$thread-root");
    expect(route.mainSessionKey).not.toContain(":thread:");
    expect(route.lastRoutePolicy).toBe("session");
  });

  it("preserves mixed-case matrix thread ids in session keys", () => {
    const { route } = resolveMatrixInboundRoute({
      cfg: baseCfg as never,
      accountId: "ops",
      roomId: "!room:example.org",
      senderId: "@alice:example.org",
      isDirectMessage: false,
      threadId: "$AbC123:example.org",
      resolveAgentRoute,
    });

    expect(route.sessionKey).toContain(":thread:$AbC123:example.org");
  });

  it("does not scope session key when thread id is absent", () => {
    const { route } = resolveMatrixInboundRoute({
      cfg: baseCfg as never,
      accountId: "ops",
      roomId: "!room:example.org",
      senderId: "@alice:example.org",
      isDirectMessage: false,
      resolveAgentRoute,
    });

    expect(route.sessionKey).not.toContain(":thread:");
  });
});
