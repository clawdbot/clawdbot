import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  resolveHeartbeatDeliveryTarget,
  resolveOutboundTarget,
  resolveSessionDeliveryTarget,
} from "./targets.js";
import type { SessionDeliveryTarget } from "./targets.js";
import {
  installResolveOutboundTargetPluginRegistryHooks,
  runResolveOutboundTargetCoreTests,
} from "./targets.shared-test.js";
import {
  createForumTargetTestPlugin,
  createGenericTargetTestPlugin,
  createTargetsTestRegistry,
} from "./targets.test-helpers.js";

const mocks = vi.hoisted(() => ({
  normalizeDeliverableOutboundChannel: vi.fn(),
  resolveOutboundChannelPlugin: vi.fn(),
}));

vi.mock("./channel-resolution.js", () => ({
  normalizeDeliverableOutboundChannel: mocks.normalizeDeliverableOutboundChannel,
  resolveOutboundChannelPlugin: mocks.resolveOutboundChannelPlugin,
}));

runResolveOutboundTargetCoreTests();

beforeEach(() => {
  mocks.normalizeDeliverableOutboundChannel.mockReset();
  mocks.normalizeDeliverableOutboundChannel.mockImplementation((value?: string | null) => {
    const normalized = typeof value === "string" ? value.trim().toLowerCase() : undefined;
    return ["alpha", "beta", "forum"].includes(String(normalized)) ? normalized : undefined;
  });
  mocks.resolveOutboundChannelPlugin.mockReset();
  mocks.resolveOutboundChannelPlugin.mockImplementation(
    ({ channel }: { channel: string }) =>
      getActivePluginRegistry()?.channels.find((entry) => entry?.plugin?.id === channel)?.plugin,
  );
  setActivePluginRegistry(
    createTargetsTestRegistry([
      createGenericTargetTestPlugin("alpha", "Alpha"),
      createGenericTargetTestPlugin("beta", "Beta"),
      createForumTargetTestPlugin(),
    ]),
  );
});

describe("resolveOutboundTarget defaultTo config fallback", () => {
  installResolveOutboundTargetPluginRegistryHooks();
  const alphaDefaultCfg: OpenClawConfig = {
    channels: { alpha: { defaultTo: "Alpha:Room One", allowFrom: ["*"] } },
  };

  it("uses plugin defaultTo when no explicit target is provided", () => {
    const res = resolveOutboundTarget({
      channel: "alpha",
      to: undefined,
      cfg: alphaDefaultCfg,
      mode: "implicit",
    });
    expect(res).toEqual({ ok: true, to: "room-one" });
  });

  it("uses a second plugin defaultTo when no explicit target is provided", () => {
    const cfg: OpenClawConfig = {
      channels: { beta: { defaultTo: "Beta:Default Room" } },
    };
    const res = resolveOutboundTarget({
      channel: "beta",
      to: "",
      cfg,
      mode: "implicit",
    });
    expect(res).toEqual({ ok: true, to: "default-room" });
  });

  it("explicit --reply-to overrides defaultTo", () => {
    const res = resolveOutboundTarget({
      channel: "alpha",
      to: "Alpha:Override Room",
      cfg: alphaDefaultCfg,
      mode: "explicit",
    });
    expect(res).toEqual({ ok: true, to: "override-room" });
  });

  it("still errors when no defaultTo and no explicit target", () => {
    const cfg: OpenClawConfig = {
      channels: { alpha: { allowFrom: ["room-one"] } },
    };
    const res = resolveOutboundTarget({
      channel: "alpha",
      to: "",
      cfg,
      mode: "implicit",
    });
    expect(res.ok).toBe(false);
  });

  it("falls back to the active registry when the cached channel map is stale", () => {
    const registry = createTargetsTestRegistry([]);
    setActivePluginRegistry(registry, "stale-registry-test");

    // Warm the cached channel map before mutating the registry in place.
    expect(resolveOutboundTarget({ channel: "alpha", to: "room-one", mode: "explicit" }).ok).toBe(
      false,
    );

    registry.channels.push({
      pluginId: "alpha",
      plugin: createGenericTargetTestPlugin("alpha", "Alpha"),
      source: "test",
    });

    expect(resolveOutboundTarget({ channel: "alpha", to: "room-one", mode: "explicit" })).toEqual({
      ok: true,
      to: "room-one",
    });
  });
});

describe("resolveSessionDeliveryTarget", () => {
  const expectImplicitRoute = (
    resolved: SessionDeliveryTarget,
    params: {
      channel?: SessionDeliveryTarget["channel"];
      to?: string;
      lastChannel?: SessionDeliveryTarget["lastChannel"];
      lastTo?: string;
    },
  ) => {
    expect(resolved).toEqual({
      channel: params.channel,
      to: params.to,
      accountId: undefined,
      threadId: undefined,
      threadIdExplicit: false,
      mode: "implicit",
      lastChannel: params.lastChannel,
      lastTo: params.lastTo,
      lastAccountId: undefined,
      lastThreadId: undefined,
    });
  };

  const expectTopicParsedFromExplicitTo = (
    entry: Parameters<typeof resolveSessionDeliveryTarget>[0]["entry"],
  ) => {
    const resolved = resolveSessionDeliveryTarget({
      entry,
      requestedChannel: "last",
      explicitTo: "room:ops:topic:1008013",
    });
    expect(resolved.to).toBe("room:ops");
    expect(resolved.threadId).toBe(1008013);
  };

  it("derives implicit delivery from the last route", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-1",
        updatedAt: 1,
        lastChannel: " alpha ",
        lastTo: " Room One ",
        lastAccountId: " acct-1 ",
      },
      requestedChannel: "last",
    });

    expect(resolved).toEqual({
      channel: "alpha",
      to: "Room One",
      accountId: "acct-1",
      threadId: undefined,
      threadIdExplicit: false,
      mode: "implicit",
      lastChannel: "alpha",
      lastTo: "Room One",
      lastAccountId: "acct-1",
      lastThreadId: undefined,
    });
  });

  it("prefers explicit targets without reusing lastTo", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-2",
        updatedAt: 1,
        lastChannel: "alpha",
        lastTo: "room-one",
      },
      requestedChannel: "beta",
    });

    expectImplicitRoute(resolved, {
      channel: "beta",
      to: undefined,
      lastChannel: "alpha",
      lastTo: "room-one",
    });
  });

  it("uses an explicit provider-prefixed target before last-session channel fallback", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-prefixed",
        updatedAt: 1,
        lastChannel: "alpha",
        lastTo: "room-one",
      },
      requestedChannel: "last",
      explicitTo: "beta:room-two",
    });

    expect(resolved.channel).toBe("beta");
    expect(resolved.to).toBe("beta:room-two");
    expect(resolved.lastChannel).toBe("alpha");
  });

  it("keeps target-kind prefixes on the selected last-session channel", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-target-kind",
        updatedAt: 1,
        lastChannel: "alpha",
        lastTo: "room-one",
      },
      requestedChannel: "last",
      explicitTo: "channel:room-two",
    });

    expect(resolved.channel).toBe("alpha");
    expect(resolved.to).toBe("channel:room-two");
  });

  it("allows mismatched lastTo when configured", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-3",
        updatedAt: 1,
        lastChannel: "alpha",
        lastTo: "room-one",
      },
      requestedChannel: "beta",
      allowMismatchedLastTo: true,
    });

    expectImplicitRoute(resolved, {
      channel: "beta",
      to: "room-one",
      lastChannel: "alpha",
      lastTo: "room-one",
    });
  });

  it("passes through explicitThreadId when provided", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-thread",
        updatedAt: 1,
        lastChannel: "forum",
        lastTo: "room:ops",
        lastThreadId: 999,
      },
      requestedChannel: "last",
      explicitThreadId: 42,
    });

    expect(resolved.threadId).toBe(42);
    expect(resolved.channel).toBe("forum");
    expect(resolved.to).toBe("room:ops");
  });

  it("uses session lastThreadId when no explicitThreadId", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-thread-2",
        updatedAt: 1,
        lastChannel: "forum",
        lastTo: "room:ops",
        lastThreadId: 999,
      },
      requestedChannel: "last",
    });

    expect(resolved.threadId).toBe(999);
  });

  it("does not inherit lastThreadId in heartbeat mode", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-heartbeat-thread",
        updatedAt: 1,
        lastChannel: "alpha",
        lastTo: "room-one",
        lastThreadId: "thread-1",
      },
      requestedChannel: "last",
      mode: "heartbeat",
    });

    expect(resolved.threadId).toBeUndefined();
  });

  it("falls back to a provided channel when requested is unsupported", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-4",
        updatedAt: 1,
        lastChannel: "alpha",
        lastTo: "room-one",
      },
      requestedChannel: "webchat",
      fallbackChannel: "beta",
    });

    expectImplicitRoute(resolved, {
      channel: "beta",
      to: undefined,
      lastChannel: "alpha",
      lastTo: "room-one",
    });
  });

  it("parses plugin-owned explicit targets into threadId", () => {
    expectTopicParsedFromExplicitTo({
      sessionId: "sess-topic",
      updatedAt: 1,
      lastChannel: "forum",
      lastTo: "room:ops",
    });
  });

  it("parses plugin-owned explicit targets even when lastTo is absent", () => {
    expectTopicParsedFromExplicitTo({
      sessionId: "sess-no-last",
      updatedAt: 1,
      lastChannel: "forum",
    });
  });

  it("skips plugin-owned target parsing for other channels", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-alpha",
        updatedAt: 1,
        lastChannel: "alpha",
        lastTo: "room-one",
      },
      requestedChannel: "last",
      explicitTo: "room-one:topic:999",
    });

    expect(resolved.to).toBe("room-one:topic:999");
    expect(resolved.threadId).toBeUndefined();
  });

  it("skips plugin-owned target parsing when the requested channel differs from lastChannel", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-cross",
        updatedAt: 1,
        lastChannel: "forum",
        lastTo: "room:ops",
      },
      requestedChannel: "alpha",
      explicitTo: "room-one:topic:999",
    });

    expect(resolved.to).toBe("room-one:topic:999");
    expect(resolved.threadId).toBeUndefined();
  });

  it("keeps raw plugin-owned targets when the plugin registry is unavailable", () => {
    setActivePluginRegistry(createTargetsTestRegistry([]));

    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-no-registry",
        updatedAt: 1,
        lastChannel: "forum",
        lastTo: "room:ops",
      },
      requestedChannel: "last",
      explicitTo: "room:ops:topic:1008013",
    });

    expect(resolved.to).toBe("room:ops:topic:1008013");
    expect(resolved.threadId).toBeUndefined();
  });

  it("explicitThreadId takes priority over :topic: parsed value", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-priority",
        updatedAt: 1,
        lastChannel: "forum",
        lastTo: "room:ops",
      },
      requestedChannel: "last",
      explicitTo: "room:ops:topic:1008013",
      explicitThreadId: 42,
    });

    expect(resolved.threadId).toBe(42);
    expect(resolved.to).toBe("room:ops");
  });

  const resolveHeartbeatTarget = (entry: SessionEntry, directPolicy?: "allow" | "block") =>
    resolveHeartbeatDeliveryTarget({
      cfg: {},
      entry,
      heartbeat: {
        target: "last",
        ...(directPolicy ? { directPolicy } : {}),
      },
    });

  const expectHeartbeatTarget = (params: {
    name: string;
    entry: SessionEntry;
    directPolicy?: "allow" | "block";
    expectedChannel: string;
    expectedTo?: string;
    expectedReason?: string;
    expectedThreadId?: string | number;
  }) => {
    const resolved = resolveHeartbeatTarget(params.entry, params.directPolicy);
    expect(resolved.channel, params.name).toBe(params.expectedChannel);
    expect(resolved.to, params.name).toBe(params.expectedTo);
    expect(resolved.reason, params.name).toBe(params.expectedReason);
    expect(resolved.threadId, params.name).toBe(params.expectedThreadId);
  };

  it.each([
    {
      name: "allows heartbeat delivery to direct targets by default and drops inherited thread ids",
      entry: {
        sessionId: "sess-heartbeat-alpha-direct",
        updatedAt: 1,
        lastChannel: "alpha",
        lastTo: "user:one",
        lastThreadId: "thread-1",
      },
      expectedChannel: "alpha",
      expectedTo: "user:one",
    },
    {
      name: "blocks heartbeat delivery to direct targets when directPolicy is block",
      entry: {
        sessionId: "sess-heartbeat-alpha-direct-blocked",
        updatedAt: 1,
        lastChannel: "alpha",
        lastTo: "user:one",
        lastThreadId: "thread-1",
      },
      directPolicy: "block" as const,
      expectedChannel: "none",
      expectedReason: "dm-blocked",
    },
    {
      name: "allows heartbeat delivery to plugin-classified direct chats by default",
      entry: {
        sessionId: "sess-heartbeat-forum-direct",
        updatedAt: 1,
        lastChannel: "forum",
        lastTo: "dm:one",
      },
      expectedChannel: "forum",
      expectedTo: "dm:one",
    },
    {
      name: "blocks heartbeat delivery to plugin-classified direct chats when directPolicy is block",
      entry: {
        sessionId: "sess-heartbeat-forum-direct-blocked",
        updatedAt: 1,
        lastChannel: "forum",
        lastTo: "dm:one",
      },
      directPolicy: "block" as const,
      expectedChannel: "none",
      expectedReason: "dm-blocked",
    },
    {
      name: "keeps heartbeat delivery to plugin-classified groups",
      entry: {
        sessionId: "sess-heartbeat-forum-group",
        updatedAt: 1,
        lastChannel: "forum",
        lastTo: "room:ops",
      },
      expectedChannel: "forum",
      expectedTo: "room:ops",
    },
    {
      name: "allows heartbeat delivery to unknown-shape targets when session chatType is direct",
      entry: {
        sessionId: "sess-heartbeat-beta-direct",
        updatedAt: 1,
        lastChannel: "beta",
        lastTo: "unknown-shape",
        chatType: "direct",
      },
      expectedChannel: "beta",
      expectedTo: "unknown-shape",
    },
    {
      name: "keeps heartbeat delivery to generic group targets",
      entry: {
        sessionId: "sess-heartbeat-alpha-group",
        updatedAt: 1,
        lastChannel: "alpha",
        lastTo: "group:ops",
      },
      expectedChannel: "alpha",
      expectedTo: "group:ops",
    },
    {
      name: "uses session chatType hints when target parsing cannot classify a direct chat",
      entry: {
        sessionId: "sess-heartbeat-alpha-unknown-direct",
        updatedAt: 1,
        lastChannel: "alpha",
        lastTo: "chat-guid-unknown-shape",
        chatType: "direct",
      },
      expectedChannel: "alpha",
      expectedTo: "chat-guid-unknown-shape",
    },
    {
      name: "blocks session chatType direct hints when directPolicy is block",
      entry: {
        sessionId: "sess-heartbeat-alpha-unknown-direct-blocked",
        updatedAt: 1,
        lastChannel: "alpha",
        lastTo: "chat-guid-unknown-shape",
        chatType: "direct",
      },
      directPolicy: "block" as const,
      expectedChannel: "none",
      expectedReason: "dm-blocked",
    },
  ] satisfies Array<{
    name: string;
    entry: NonNullable<Parameters<typeof resolveHeartbeatDeliveryTarget>[0]["entry"]>;
    directPolicy?: "allow" | "block";
    expectedChannel: string;
    expectedTo?: string;
    expectedReason?: string;
  }>)("$name", ({ name, entry, directPolicy, expectedChannel, expectedTo, expectedReason }) => {
    expectHeartbeatTarget({
      name,
      entry,
      directPolicy,
      expectedChannel,
      expectedTo,
      expectedReason,
    });
  });

  it("allows heartbeat delivery to core direct target prefixes by default", () => {
    const cfg: OpenClawConfig = {};
    const resolved = resolveHeartbeatDeliveryTarget({
      cfg,
      entry: {
        sessionId: "sess-heartbeat-core-direct-prefix",
        updatedAt: 1,
        lastChannel: "alpha",
        lastTo: "user:12345",
      },
      heartbeat: {
        target: "last",
      },
    });

    expect(resolved.channel).toBe("alpha");
    expect(resolved.to).toBe("user:12345");
  });

  it("keeps heartbeat delivery to core channel target prefixes", () => {
    const cfg: OpenClawConfig = {};
    const resolved = resolveHeartbeatDeliveryTarget({
      cfg,
      entry: {
        sessionId: "sess-heartbeat-core-channel-prefix",
        updatedAt: 1,
        lastChannel: "alpha",
        lastTo: "channel:999",
      },
      heartbeat: {
        target: "last",
      },
    });

    expect(resolved.channel).toBe("alpha");
    expect(resolved.to).toBe("channel:999");
  });

  it("keeps explicit threadId in heartbeat mode", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-heartbeat-explicit-thread",
        updatedAt: 1,
        lastChannel: "forum",
        lastTo: "room:ops",
        lastThreadId: 999,
      },
      requestedChannel: "last",
      mode: "heartbeat",
      explicitThreadId: 42,
    });

    expect(resolved.channel).toBe("forum");
    expect(resolved.to).toBe("room:ops");
    expect(resolved.threadId).toBe(42);
    expect(resolved.threadIdExplicit).toBe(true);
  });

  it("parses explicit heartbeat plugin targets into threadId", () => {
    const cfg: OpenClawConfig = {};
    const resolved = resolveHeartbeatDeliveryTarget({
      cfg,
      heartbeat: {
        target: "forum",
        to: "room:ops:topic:1008013",
      },
    });

    expect(resolved.channel).toBe("forum");
    expect(resolved.to).toBe("room:ops");
    expect(resolved.threadId).toBe(1008013);
  });

  it("preserves route threadId for heartbeat target=last on plugin-owned group sessions", () => {
    const cfg: OpenClawConfig = {};
    const resolved = resolveHeartbeatDeliveryTarget({
      cfg,
      entry: {
        sessionId: "sess-heartbeat-forum-topic",
        updatedAt: 1,
        lastChannel: "forum",
        lastTo: "room:ops",
        lastThreadId: 1122,
        chatType: "group",
      },
      heartbeat: {
        target: "last",
      },
    });

    expect(resolved.channel).toBe("forum");
    expect(resolved.to).toBe("room:ops");
    expect(resolved.threadId).toBe(1122);
  });

  it("reuses route threadId when only deliveryContext carries it", () => {
    const cfg: OpenClawConfig = {};
    const resolved = resolveHeartbeatDeliveryTarget({
      cfg,
      entry: {
        sessionId: "sess-heartbeat-forum-topic-context-only",
        updatedAt: 1,
        deliveryContext: {
          channel: "forum",
          to: "room:ops",
          threadId: 1122,
        },
        chatType: "group",
      },
      heartbeat: {
        target: "last",
      },
    });

    expect(resolved.channel).toBe("forum");
    expect(resolved.to).toBe("room:ops");
    expect(resolved.threadId).toBe(1122);
  });

  it("does not inherit stale threadId for direct-chat heartbeat routes", () => {
    const cfg: OpenClawConfig = {};
    const resolved = resolveHeartbeatDeliveryTarget({
      cfg,
      entry: {
        sessionId: "sess-heartbeat-forum-direct-stale-thread",
        updatedAt: 1,
        lastChannel: "forum",
        lastTo: "dm:one",
        lastThreadId: 1122,
        chatType: "direct",
      },
      heartbeat: {
        target: "last",
      },
    });

    expect(resolved.channel).toBe("forum");
    expect(resolved.to).toBe("dm:one");
    expect(resolved.threadId).toBeUndefined();
  });

  it("prefers turn-scoped routing over mutable session routing for target=last", () => {
    const resolved = resolveHeartbeatDeliveryTarget({
      cfg: {},
      entry: {
        sessionId: "sess-heartbeat-turn-source",
        updatedAt: 1,
        lastChannel: "alpha",
        lastTo: "wrong-room",
      },
      heartbeat: {
        target: "last",
      },
      turnSource: {
        channel: "forum",
        to: "room:ops",
        threadId: 42,
      },
    });

    expect(resolved.channel).toBe("forum");
    expect(resolved.to).toBe("room:ops");
    expect(resolved.threadId).toBe(42);
  });

  it("merges partial turn-scoped metadata with the stored session route for target=last", () => {
    const resolved = resolveHeartbeatDeliveryTarget({
      cfg: {},
      entry: {
        sessionId: "sess-heartbeat-turn-source-partial",
        updatedAt: 1,
        lastChannel: "forum",
        lastTo: "room:ops",
      },
      heartbeat: {
        target: "last",
      },
      turnSource: {
        threadId: 42,
      },
    });

    expect(resolved.channel).toBe("forum");
    expect(resolved.to).toBe("room:ops");
    expect(resolved.threadId).toBe(42);
  });
});

describe("resolveSessionDeliveryTarget — cross-channel reply guard (#24152)", () => {
  it("uses turnSourceChannel over session lastChannel when provided", () => {
    // Simulate: one channel originated the turn, but another channel
    // concurrently updated the shared session route.
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-shared",
        updatedAt: 1,
        lastChannel: "beta",
        lastTo: "wrong-room",
      },
      requestedChannel: "last",
      turnSourceChannel: "alpha",
      turnSourceTo: "room-one",
    });

    expect(resolved.channel).toBe("alpha");
    expect(resolved.to).toBe("room-one");
  });

  it("falls back to session lastChannel when turnSourceChannel is not set", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-normal",
        updatedAt: 1,
        lastChannel: "alpha",
        lastTo: "room-one",
      },
      requestedChannel: "last",
    });

    expect(resolved.channel).toBe("alpha");
    expect(resolved.to).toBe("room-one");
  });

  it("respects explicit requestedChannel over turnSourceChannel", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-explicit",
        updatedAt: 1,
        lastChannel: "beta",
        lastTo: "wrong-room",
      },
      requestedChannel: "forum",
      explicitTo: "room:ops",
      turnSourceChannel: "alpha",
      turnSourceTo: "room-one",
    });

    // Explicit requestedChannel is not "last", so it takes priority.
    expect(resolved.channel).toBe("forum");
  });

  it("preserves turnSourceAccountId and turnSourceThreadId", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-meta",
        updatedAt: 1,
        lastChannel: "beta",
        lastTo: "wrong-room",
        lastAccountId: "wrong-account",
      },
      requestedChannel: "last",
      turnSourceChannel: "forum",
      turnSourceTo: "room:ops",
      turnSourceAccountId: "bot-123",
      turnSourceThreadId: 42,
    });

    expect(resolved.channel).toBe("forum");
    expect(resolved.to).toBe("room:ops");
    expect(resolved.accountId).toBe("bot-123");
    expect(resolved.threadId).toBe(42);
  });

  it("does not fall back to session target metadata when turnSourceChannel is set", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-no-fallback",
        updatedAt: 1,
        lastChannel: "beta",
        lastTo: "wrong-room",
        lastAccountId: "wrong-account",
        lastThreadId: "thread-1",
      },
      requestedChannel: "last",
      turnSourceChannel: "alpha",
    });

    expect(resolved.channel).toBe("alpha");
    expect(resolved.to).toBeUndefined();
    expect(resolved.accountId).toBeUndefined();
    expect(resolved.threadId).toBeUndefined();
    expect(resolved.lastTo).toBeUndefined();
    expect(resolved.lastAccountId).toBeUndefined();
    expect(resolved.lastThreadId).toBeUndefined();
  });

  it("falls back to session lastThreadId when turnSourceChannel matches session channel and no explicit turnSourceThreadId", () => {
    // Regression: topic replies were landing in the root chat instead of the topic
    // because turnSourceThreadId was undefined even though the session had it.
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-forum-topic",
        updatedAt: 1,
        lastChannel: "forum",
        lastTo: "room:ops",
        lastThreadId: 1122,
      },
      requestedChannel: "last",
      turnSourceChannel: "forum",
      turnSourceTo: "room:ops",
    });

    expect(resolved.channel).toBe("forum");
    expect(resolved.to).toBe("room:ops");
    expect(resolved.threadId).toBe(1122);
  });

  it("keeps topic thread routing when turnSourceTo uses the plugin-owned topic target", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-forum-topic-scoped",
        updatedAt: 1,
        lastChannel: "forum",
        lastTo: "forum:room:ops:topic:1122",
        lastThreadId: 1122,
      },
      requestedChannel: "last",
      turnSourceChannel: "forum",
      turnSourceTo: "forum:room:ops:topic:1122",
    });

    expect(resolved.channel).toBe("forum");
    expect(resolved.to).toBe("forum:room:ops:topic:1122");
    expect(resolved.threadId).toBe(1122);
  });

  it("matches bare stored routes against topic-scoped turn routes via plugin grammar", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-forum-topic-mixed-shape",
        updatedAt: 1,
        lastChannel: "forum",
        lastTo: "room:ops",
        lastThreadId: 1122,
      },
      requestedChannel: "last",
      turnSourceChannel: "forum",
      turnSourceTo: "forum:room:ops:topic:1122",
    });

    expect(resolved.channel).toBe("forum");
    expect(resolved.to).toBe("forum:room:ops:topic:1122");
    expect(resolved.threadId).toBe(1122);
  });

  it("does not fall back to session lastThreadId when turnSourceChannel differs from session channel", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-cross-channel-no-thread",
        updatedAt: 1,
        lastChannel: "alpha",
        lastTo: "room-one",
        lastThreadId: "thread-1",
      },
      requestedChannel: "last",
      turnSourceChannel: "forum",
      turnSourceTo: "room:ops",
    });

    expect(resolved.channel).toBe("forum");
    expect(resolved.threadId).toBeUndefined();
  });

  it("prefers explicit turnSourceThreadId over session lastThreadId on same channel", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-explicit-thread-override",
        updatedAt: 1,
        lastChannel: "forum",
        lastTo: "room:ops",
        lastThreadId: 1122,
      },
      requestedChannel: "last",
      turnSourceChannel: "forum",
      turnSourceTo: "room:ops",
      turnSourceThreadId: 9999,
    });

    expect(resolved.channel).toBe("forum");
    expect(resolved.to).toBe("room:ops");
    expect(resolved.threadId).toBe(9999);
  });

  it("drops session threadId when turnSourceTo differs from session to (shared-session race)", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-shared-race",
        updatedAt: 1,
        lastChannel: "forum",
        lastTo: "room:ops",
        lastThreadId: 1122,
      },
      requestedChannel: "last",
      turnSourceChannel: "forum",
      turnSourceTo: "room:other",
    });

    expect(resolved.channel).toBe("forum");
    expect(resolved.to).toBe("room:other");
    expect(resolved.threadId).toBeUndefined();
  });

  it("uses explicitTo even when turnSourceTo is omitted", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-explicit-to",
        updatedAt: 1,
        lastChannel: "beta",
        lastTo: "wrong-room",
      },
      requestedChannel: "last",
      explicitTo: "room-one",
      turnSourceChannel: "alpha",
    });

    expect(resolved.channel).toBe("alpha");
    expect(resolved.to).toBe("room-one");
  });

  it("still allows mismatched lastTo only from turn-scoped metadata", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-mismatch-turn",
        updatedAt: 1,
        lastChannel: "alpha",
        lastTo: "wrong-room",
      },
      requestedChannel: "beta",
      allowMismatchedLastTo: true,
      turnSourceChannel: "alpha",
      turnSourceTo: "room-one",
    });

    expect(resolved.channel).toBe("beta");
    expect(resolved.to).toBe("room-one");
  });
});
