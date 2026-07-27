// Covers outbound direct target resolution, heartbeat target derivation,
// heartbeat sender context, and route-aware heartbeat refinements.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { ChannelRouteRef } from "../../plugin-sdk/channel-route.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../../plugins/runtime.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { normalizeLegacySessionEntryDelivery } from "../state-migrations.legacy-session-store.js";
import {
  resolveHeartbeatDeliveryTarget as resolveCanonicalHeartbeatDeliveryTarget,
  resolveHeartbeatDeliveryTargetWithSessionRoute as resolveCanonicalHeartbeatDeliveryTargetWithSessionRoute,
  resolveOutboundTarget,
  resolveSessionDeliveryTarget as resolveCanonicalSessionDeliveryTarget,
} from "./targets.js";
import type { SessionDeliveryTarget } from "./targets.js";
import {
  installResolveOutboundTargetPluginRegistryHooks,
  runResolveOutboundTargetCoreTests,
} from "./targets.shared-test.js";
import {
  createForumTargetTestPlugin,
  createGenericTargetTestPlugin,
  createTestChannelPlugin,
  createTargetsTestRegistry,
} from "./targets.test-helpers.js";

const mocks = vi.hoisted(() => ({
  normalizeDeliverableOutboundChannel: vi.fn(),
  resolveOutboundChannelPlugin: vi.fn(),
}));

type LegacyDeliveryFixture = SessionEntry & {
  route?: ChannelRouteRef;
  deliveryContext?: DeliveryContext;
  origin?: { provider?: string; accountId?: string; threadId?: string | number };
  channel?: string;
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
};

function resolveSessionDeliveryTarget(
  params: Omit<Parameters<typeof resolveCanonicalSessionDeliveryTarget>[0], "entry"> & {
    entry?: LegacyDeliveryFixture;
  },
) {
  return resolveCanonicalSessionDeliveryTarget({
    ...params,
    entry: params.entry ? normalizeLegacySessionEntryDelivery(params.entry) : undefined,
  });
}

function resolveHeartbeatDeliveryTarget(
  params: Omit<Parameters<typeof resolveCanonicalHeartbeatDeliveryTarget>[0], "entry"> & {
    entry?: LegacyDeliveryFixture;
  },
) {
  return resolveCanonicalHeartbeatDeliveryTarget({
    ...params,
    entry: params.entry ? normalizeLegacySessionEntryDelivery(params.entry) : undefined,
  });
}

async function resolveHeartbeatDeliveryTargetWithSessionRoute(
  params: Omit<
    Parameters<typeof resolveCanonicalHeartbeatDeliveryTargetWithSessionRoute>[0],
    "entry"
  > & { entry?: LegacyDeliveryFixture },
) {
  return await resolveCanonicalHeartbeatDeliveryTargetWithSessionRoute({
    ...params,
    entry: params.entry ? normalizeLegacySessionEntryDelivery(params.entry) : undefined,
  });
}

vi.mock("./channel-resolution.js", () => ({
  normalizeDeliverableOutboundChannel: mocks.normalizeDeliverableOutboundChannel,
  resolveOutboundChannelPlugin: mocks.resolveOutboundChannelPlugin,
}));

runResolveOutboundTargetCoreTests();

beforeEach(() => {
  mocks.normalizeDeliverableOutboundChannel.mockReset();
  mocks.normalizeDeliverableOutboundChannel.mockImplementation((value?: string | null) => {
    const normalized = typeof value === "string" ? value.trim().toLowerCase() : undefined;
    return ["alpha", "beta", "forum", "telegram"].includes(String(normalized))
      ? normalized
      : undefined;
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

  it("passes bootstrap opt-in to channel plugin resolution", () => {
    const cfg: OpenClawConfig = {
      channels: { alpha: { defaultTo: "Alpha:Room One" } },
    };

    const res = resolveOutboundTarget({
      channel: "alpha",
      to: "Alpha:Override Room",
      cfg,
      mode: "explicit",
      allowBootstrap: true,
    });

    expect(res).toEqual({ ok: true, to: "override-room" });
    expect(mocks.resolveOutboundChannelPlugin).toHaveBeenCalledWith({
      channel: "alpha",
      cfg,
      allowBootstrap: true,
    });
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
      mode: "implicit",
      lastChannel: params.lastChannel,
      lastTo: params.lastTo,
      lastAccountId: undefined,
      lastThreadId: undefined,
    });
  };

  const expectTopicTargetKeptRaw = (
    entry: Parameters<typeof resolveSessionDeliveryTarget>[0]["entry"],
  ) => {
    const resolved = resolveSessionDeliveryTarget({
      entry,
      requestedChannel: "last",
      explicitTo: "room:ops:topic:1008013",
    });
    expect(resolved.to).toBe("room:ops:topic:1008013");
    expect(resolved.threadId).toBeUndefined();
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

  it("keeps parser-only explicit target compatibility during the migration window", () => {
    const alpha = createGenericTargetTestPlugin("alpha", "Alpha");
    setActivePluginRegistry(
      createTargetsTestRegistry([
        {
          ...alpha,
          messaging: {
            targetPrefixes: ["alpha"],
            parseExplicitTarget: ({ raw }) =>
              raw === "alpha:room-a:topic:77"
                ? { to: "room-a", threadId: 77, chatType: "group" as const }
                : null,
          },
        },
      ]),
    );

    const resolved = resolveSessionDeliveryTarget({
      requestedChannel: "alpha",
      explicitTo: "alpha:room-a:topic:77",
    });

    expect(resolved.to).toBe("room-a");
    expect(resolved.threadId).toBe(77);
  });

  it("keeps parser-only session target thread compatibility during the migration window", () => {
    const alpha = createGenericTargetTestPlugin("alpha", "Alpha");
    setActivePluginRegistry(
      createTargetsTestRegistry([
        {
          ...alpha,
          messaging: {
            targetPrefixes: ["alpha"],
            parseExplicitTarget: ({ raw }) =>
              raw === "alpha:room-a:topic:77"
                ? { to: "room-a", threadId: 77, chatType: "group" as const }
                : null,
          },
        },
      ]),
    );

    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-parser",
        updatedAt: 1,
        lastChannel: "alpha",
        lastTo: "alpha:room-a:topic:77",
      },
      requestedChannel: "last",
    });

    expect(resolved.to).toBe("room-a");
    expect(resolved.threadId).toBe(77);
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

  it("keeps plugin-owned explicit targets raw for route resolution", () => {
    expectTopicTargetKeptRaw({
      sessionId: "sess-topic",
      updatedAt: 1,
      lastChannel: "forum",
      lastTo: "room:ops",
    });
  });

  it("keeps plugin-owned explicit targets raw when lastTo is absent", () => {
    expectTopicTargetKeptRaw({
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
    expect(resolved.to).toBe("room:ops:topic:1008013");
  });

  it("delivers an origin-carrying event when no heartbeat target is configured", () => {
    // A wake/cron event that explicitly carried its origin delivery context
    // names its own destination; the reply must not be dropped just because
    // the deployment never configured agents.defaults.heartbeat.
    const resolved = resolveHeartbeatDeliveryTarget({
      cfg: {},
      entry: {
        sessionId: "sess-origin-no-config",
        updatedAt: 1,
        lastChannel: "alpha",
        lastTo: "chat:one",
      },
      turnSource: { channel: "alpha", to: "chat:one", threadId: "77" },
    });
    expect(resolved.channel).toBe("alpha");
    expect(resolved.to).toBe("chat:one");
    expect(resolved.threadId).toBe("77");
  });

  it("keeps an explicit target:none suppressing origin-carrying events", () => {
    const resolved = resolveHeartbeatDeliveryTarget({
      cfg: {},
      entry: {
        sessionId: "sess-origin-target-none",
        updatedAt: 1,
        lastChannel: "alpha",
        lastTo: "chat:one",
      },
      heartbeat: { target: "none" },
      turnSource: { channel: "alpha", to: "chat:one" },
    });
    expect(resolved.channel).toBe("none");
    expect(resolved.reason).toBe("target-none");
  });

  it("stays suppressed with unset heartbeat config and no origin turn source", () => {
    const resolved = resolveHeartbeatDeliveryTarget({
      cfg: {},
      entry: {
        sessionId: "sess-no-config-no-origin",
        updatedAt: 1,
        lastChannel: "alpha",
        lastTo: "chat:one",
      },
    });
    expect(resolved.channel).toBe("none");
    expect(resolved.reason).toBe("target-none");
  });

  const resolveHeartbeatTarget = (entry: LegacyDeliveryFixture, directPolicy?: "allow" | "block") =>
    resolveHeartbeatDeliveryTarget({
      cfg: {},
      entry: normalizeLegacySessionEntryDelivery(entry),
      heartbeat: {
        target: "last",
        ...(directPolicy ? { directPolicy } : {}),
      },
    });

  const expectHeartbeatTarget = (params: {
    name: string;
    entry: LegacyDeliveryFixture;
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
    entry: LegacyDeliveryFixture;
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
  });

  it("keeps explicit heartbeat plugin targets raw for modern route resolution", () => {
    const cfg: OpenClawConfig = {};
    const resolved = resolveHeartbeatDeliveryTarget({
      cfg,
      heartbeat: {
        target: "forum",
        to: "room:ops:topic:1008013",
      },
    });

    expect(resolved.channel).toBe("forum");
    expect(resolved.to).toBe("room:ops:topic:1008013");
    expect(resolved.threadId).toBeUndefined();
  });

  it("bootstraps plugin-channel heartbeat routes when the plugin registry is unavailable", () => {
    const forum = createForumTargetTestPlugin();
    setActivePluginRegistry(createTargetsTestRegistry([]));
    mocks.resolveOutboundChannelPlugin.mockImplementation(
      ({ channel, allowBootstrap }: { channel: string; allowBootstrap?: boolean }) =>
        channel === "forum" && allowBootstrap === true ? forum : undefined,
    );

    const resolved = resolveHeartbeatDeliveryTarget({
      cfg: {},
      entry: {
        sessionId: "sess-heartbeat-no-registry",
        updatedAt: 1,
        lastChannel: "forum",
        lastTo: "room:ops",
      },
      heartbeat: {
        target: "last",
      },
    });

    expect(resolved.channel).toBe("forum");
    expect(resolved.to).toBe("room:ops");
    expect(mocks.resolveOutboundChannelPlugin).toHaveBeenCalledWith({
      channel: "forum",
      cfg: {},
      allowBootstrap: true,
    });
    expect(
      mocks.resolveOutboundChannelPlugin.mock.calls.filter(
        ([params]) => params.allowBootstrap === true,
      ),
    ).toHaveLength(1);
  });

  it("does not bypass target policy when bootstrapping plugin-channel heartbeat routes", () => {
    const forum = createForumTargetTestPlugin();
    setActivePluginRegistry(createTargetsTestRegistry([]));
    mocks.resolveOutboundChannelPlugin.mockImplementation(
      ({ channel, allowBootstrap }: { channel: string; allowBootstrap?: boolean }) =>
        channel === "forum" && allowBootstrap === true ? forum : undefined,
    );

    const resolved = resolveHeartbeatDeliveryTarget({
      cfg: {},
      entry: {
        sessionId: "sess-heartbeat-no-registry-invalid-target",
        updatedAt: 1,
        lastChannel: "forum",
        lastTo: "invalid",
      },
      heartbeat: {
        target: "last",
      },
    });

    expect(resolved.channel).toBe("none");
    expect(resolved.reason).toBe("no-target");
    expect(
      mocks.resolveOutboundChannelPlugin.mock.calls.filter(
        ([params]) => params.allowBootstrap === true,
      ),
    ).toHaveLength(1);
  });

  it("does not bypass account validation when bootstrapping plugin-channel heartbeat routes", () => {
    const forum = createForumTargetTestPlugin();
    const forumWithAccounts = {
      ...forum,
      config: {
        ...forum.config,
        listAccountIds: () => ["valid-account"],
      },
    };
    setActivePluginRegistry(createTargetsTestRegistry([]));
    mocks.resolveOutboundChannelPlugin.mockImplementation(
      ({ channel, allowBootstrap }: { channel: string; allowBootstrap?: boolean }) =>
        channel === "forum" && allowBootstrap === true ? forumWithAccounts : undefined,
    );

    const resolved = resolveHeartbeatDeliveryTarget({
      cfg: {},
      entry: {
        sessionId: "sess-heartbeat-no-registry-invalid-account",
        updatedAt: 1,
        lastChannel: "forum",
        lastTo: "room:ops",
      },
      heartbeat: {
        target: "last",
        accountId: "missing-account",
      },
    });

    expect(resolved.channel).toBe("none");
    expect(resolved.reason).toBe("unknown-account");
    expect(
      mocks.resolveOutboundChannelPlugin.mock.calls.filter(
        ([params]) => params.allowBootstrap === true,
      ),
    ).toHaveLength(1);
  });

  it("does not bootstrap plugin-channel heartbeat routes without a concrete target", () => {
    setActivePluginRegistry(createTargetsTestRegistry([]));

    const resolved = resolveHeartbeatDeliveryTarget({
      cfg: {},
      entry: {
        sessionId: "sess-heartbeat-no-target",
        updatedAt: 1,
        lastChannel: "forum",
      },
      heartbeat: {
        target: "last",
        accountId: "configured-account",
      },
    });

    expect(resolved.channel).toBe("none");
    expect(resolved.reason).toBe("no-target");
    expect(mocks.resolveOutboundChannelPlugin).not.toHaveBeenCalled();
  });

  it("resolves explicit heartbeat plugin targets through the outbound session route", async () => {
    const cfg: OpenClawConfig = {};
    const resolved = await resolveHeartbeatDeliveryTargetWithSessionRoute({
      cfg,
      agentId: "main",
      heartbeat: {
        target: "forum",
        to: "room:ops:topic:1008013",
      },
    });

    expect(resolved.channel).toBe("forum");
    expect(resolved.to).toBe("room:ops");
    expect(resolved.threadId).toBe(1008013);
  });

  it("bootstraps explicit external heartbeat targets before strict validation", () => {
    const external = {
      ...createForumTargetTestPlugin(),
      id: "external-channel",
    };
    mocks.resolveOutboundChannelPlugin.mockImplementation(
      ({ channel, allowBootstrap }: { channel: string; allowBootstrap?: boolean }) =>
        channel === "external-channel" && allowBootstrap === true ? external : undefined,
    );

    const resolved = resolveHeartbeatDeliveryTarget({
      cfg: {},
      entry: {
        sessionId: "sess-external-account",
        updatedAt: 1,
        lastChannel: "external-channel",
        lastTo: "room:previous",
        lastAccountId: "account-2",
      },
      heartbeat: {
        target: "external-channel",
        to: "room:ops",
      },
    });

    expect(resolved.channel).toBe("external-channel");
    expect(resolved.to).toBe("room:ops");
    expect(resolved.accountId).toBe("account-2");
    expect(mocks.resolveOutboundChannelPlugin).toHaveBeenCalledWith({
      channel: "external-channel",
      cfg: {},
      allowBootstrap: true,
    });
  });

  it("blocks heartbeat targets that route to direct chats after canonicalization", async () => {
    const alpha = createGenericTargetTestPlugin("alpha", "Alpha");
    const routedAlpha = {
      ...alpha,
      messaging: {
        ...alpha.messaging,
        resolveOutboundSessionRoute: () => ({
          sessionKey: "main:alpha:user:u123",
          baseSessionKey: "main:alpha:user:u123",
          peer: { kind: "direct" as const, id: "u123" },
          chatType: "direct" as const,
          from: "alpha:u123",
          to: "user:u123",
        }),
      },
    };
    setActivePluginRegistry(createTargetsTestRegistry([]));
    mocks.resolveOutboundChannelPlugin.mockImplementation(
      ({ channel, allowBootstrap }: { channel: string; allowBootstrap?: boolean }) => {
        if (channel !== "alpha") {
          return undefined;
        }
        if (allowBootstrap === true) {
          setActivePluginRegistry(createTargetsTestRegistry([routedAlpha]));
          return routedAlpha;
        }
        return getActivePluginRegistry()?.channels.find((entry) => entry?.plugin?.id === channel)
          ?.plugin;
      },
    );

    const resolved = await resolveHeartbeatDeliveryTargetWithSessionRoute({
      cfg: {},
      agentId: "main",
      entry: {
        sessionId: "sess-heartbeat-routed-direct",
        updatedAt: 1,
        lastChannel: "alpha",
        lastTo: "channel:D123",
      },
      heartbeat: {
        target: "last",
        directPolicy: "block",
      },
    });

    expect(resolved.channel).toBe("none");
    expect(resolved.reason).toBe("dm-blocked");
  });

  it("uses resolved target kind before applying heartbeat directPolicy to routed handles", async () => {
    setActivePluginRegistry(
      createTargetsTestRegistry([
        createTestChannelPlugin({
          id: "telegram",
          label: "Telegram",
          outbound: {
            deliveryMode: "direct",
            resolveTarget: ({ to }) =>
              to
                ? { ok: true as const, to: to.trim() }
                : { ok: false as const, error: new Error("target required") },
          },
          messaging: {
            targetPrefixes: ["telegram"],
            inferTargetChatType: () => "group",
            targetResolver: {
              resolveTarget: async ({ normalized }) => ({
                to: normalized,
                kind: "group",
                source: "directory",
              }),
            },
            resolveOutboundSessionRoute: ({ target, resolvedTarget }) => {
              const isGroup = resolvedTarget?.kind === "group";
              return {
                sessionKey: `main:telegram:${isGroup ? "group" : "user"}:${target}`,
                baseSessionKey: `main:telegram:${isGroup ? "group" : "user"}:${target}`,
                peer: { kind: isGroup ? "group" : "direct", id: target },
                chatType: isGroup ? "group" : "direct",
                from: isGroup ? `telegram:group:${target}` : `telegram:${target}`,
                to: target,
              };
            },
          },
        }),
      ]),
    );

    const resolved = await resolveHeartbeatDeliveryTargetWithSessionRoute({
      cfg: {},
      agentId: "main",
      heartbeat: {
        target: "telegram",
        to: "@public_group",
        directPolicy: "block",
      },
    });

    expect(resolved.channel).toBe("telegram");
    expect(resolved.to).toBe("@public_group");
    expect(resolved.chatType).toBe("group");
  });

  it("uses an activation-aware external plugin when canonicalizing heartbeat routes", async () => {
    const external = createTestChannelPlugin({
      id: "external-channel",
      label: "External",
      outbound: {
        deliveryMode: "direct",
        resolveTarget: ({ to }) =>
          to
            ? { ok: true as const, to: to.trim() }
            : { ok: false as const, error: new Error("target required") },
      },
      messaging: {
        targetResolver: {
          resolveTarget: async ({ normalized }) => ({
            to: normalized,
            kind: "user",
            source: "directory",
          }),
        },
        resolveOutboundSessionRoute: ({ target, resolvedTarget }) => {
          const isDirect = resolvedTarget?.kind === "user";
          return {
            sessionKey: `main:external-channel:${isDirect ? "user" : "group"}:${target}`,
            baseSessionKey: `main:external-channel:${isDirect ? "user" : "group"}:${target}`,
            peer: { kind: isDirect ? "direct" : "group", id: target },
            chatType: isDirect ? "direct" : "group",
            from: `external-channel:${target}`,
            to: target,
          };
        },
      },
    });
    const setupExternal = { ...external, messaging: undefined };
    setActivePluginRegistry(createTargetsTestRegistry([setupExternal]));
    mocks.resolveOutboundChannelPlugin.mockImplementation(
      ({ channel, allowBootstrap }: { channel: string; allowBootstrap?: boolean }) => {
        if (channel !== "external-channel") {
          return undefined;
        }
        if (allowBootstrap === true) {
          return external;
        }
        return setupExternal;
      },
    );

    const resolved = await resolveHeartbeatDeliveryTargetWithSessionRoute({
      cfg: {},
      agentId: "main",
      heartbeat: {
        target: "external-channel",
        to: "person-123",
        directPolicy: "block",
      },
    });

    expect(resolved.channel).toBe("none");
    expect(resolved.reason).toBe("dm-blocked");
  });

  it("blocks direct targets from prepared external target resolvers without route hooks", async () => {
    const external = createTestChannelPlugin({
      id: "external-channel",
      label: "External",
      outbound: {
        deliveryMode: "direct",
        resolveTarget: ({ to }) =>
          to
            ? { ok: true as const, to: to.trim() }
            : { ok: false as const, error: new Error("target required") },
      },
      messaging: {
        targetResolver: {
          resolveTarget: async ({ normalized }) => ({
            to: normalized,
            kind: "user",
            source: "directory",
          }),
        },
      },
    });
    setActivePluginRegistry(createTargetsTestRegistry([]));
    mocks.resolveOutboundChannelPlugin.mockImplementation(
      ({ channel, allowBootstrap }: { channel: string; allowBootstrap?: boolean }) => {
        if (channel !== "external-channel") {
          return undefined;
        }
        if (allowBootstrap === true) {
          setActivePluginRegistry(createTargetsTestRegistry([external]));
          return external;
        }
        return getActivePluginRegistry()?.channels.find((entry) => entry?.plugin?.id === channel)
          ?.plugin;
      },
    );

    const resolved = await resolveHeartbeatDeliveryTargetWithSessionRoute({
      cfg: {},
      agentId: "main",
      heartbeat: {
        target: "external-channel",
        to: "person-123",
        directPolicy: "block",
      },
    });

    expect(resolved.channel).toBe("none");
    expect(resolved.reason).toBe("dm-blocked");
  });

  it("uses an activation-aware infer-only plugin for heartbeat direct policy", () => {
    const external = createTestChannelPlugin({
      id: "external-channel",
      label: "External",
      outbound: {
        deliveryMode: "direct",
        sendText: vi.fn(),
        resolveTarget: ({ to }) =>
          to
            ? { ok: true as const, to: to.trim() }
            : { ok: false as const, error: new Error("target required") },
      },
      messaging: {
        inferTargetChatType: () => "direct",
      },
    });
    const setupExternal = { ...external, messaging: undefined };
    mocks.resolveOutboundChannelPlugin.mockImplementation(
      ({ channel, allowBootstrap }: { channel: string; allowBootstrap?: boolean }) => {
        if (channel !== "external-channel") {
          return undefined;
        }
        return allowBootstrap === true ? external : setupExternal;
      },
    );

    const resolved = resolveHeartbeatDeliveryTarget({
      cfg: {},
      heartbeat: {
        target: "external-channel",
        to: "person-123",
        directPolicy: "block",
      },
    });

    expect(resolved.channel).toBe("none");
    expect(resolved.reason).toBe("dm-blocked");
  });

  it("resolves heartbeat reserved targets through directory before session routing", async () => {
    const listGroups = vi
      .fn()
      .mockResolvedValue([{ kind: "group", id: "-1002458651455", name: "current" }]);
    const listGroupsLive = vi.fn().mockResolvedValue([]);
    setActivePluginRegistry(
      createTargetsTestRegistry([
        {
          ...createTestChannelPlugin({
            id: "telegram",
            label: "Telegram",
            outbound: {
              deliveryMode: "direct",
              resolveTarget: ({ to }) =>
                to
                  ? { ok: true as const, to: to.trim() }
                  : { ok: false as const, error: new Error("target required") },
            },
            messaging: {
              targetPrefixes: ["telegram", "tg"],
              targetResolver: {
                reservedLiterals: ["current", "self", "this", "me"],
                hint: "<chatId>",
              },
              resolveOutboundSessionRoute: ({ target, resolvedTarget }) => ({
                sessionKey: `main:telegram:group:${target}`,
                baseSessionKey: `main:telegram:group:${target}`,
                peer: { kind: resolvedTarget?.kind === "user" ? "direct" : "group", id: target },
                chatType: resolvedTarget?.kind === "user" ? "direct" : "group",
                from: `telegram:group:${target}`,
                to: target,
              }),
            },
          }),
          directory: {
            listGroups,
            listGroupsLive,
          },
        },
      ]),
    );

    const resolved = await resolveHeartbeatDeliveryTargetWithSessionRoute({
      cfg: {},
      agentId: "main",
      heartbeat: {
        target: "telegram",
        to: "current",
      },
    });

    expect(resolved.channel).toBe("telegram");
    expect(resolved.to).toBe("-1002458651455");
    expect(listGroups).toHaveBeenCalled();
  });

  it("fails closed when a heartbeat reserved target misses the directory", async () => {
    const listGroups = vi.fn().mockResolvedValue([]);
    const listGroupsLive = vi.fn().mockResolvedValue([]);
    setActivePluginRegistry(
      createTargetsTestRegistry([
        {
          ...createTestChannelPlugin({
            id: "telegram",
            label: "Telegram",
            outbound: {
              deliveryMode: "direct",
              resolveTarget: ({ to }) =>
                to
                  ? { ok: true as const, to: to.trim() }
                  : { ok: false as const, error: new Error("target required") },
            },
            messaging: {
              targetPrefixes: ["telegram", "tg"],
              targetResolver: {
                reservedLiterals: ["current", "self", "this", "me"],
                hint: "<chatId>",
              },
              resolveOutboundSessionRoute: ({ target }) => ({
                sessionKey: `main:telegram:group:${target}`,
                baseSessionKey: `main:telegram:group:${target}`,
                peer: { kind: "group", id: target },
                chatType: "group",
                from: `telegram:group:${target}`,
                to: target,
              }),
            },
          }),
          directory: {
            listGroups,
            listGroupsLive,
          },
        },
      ]),
    );

    const resolved = await resolveHeartbeatDeliveryTargetWithSessionRoute({
      cfg: {},
      agentId: "main",
      heartbeat: {
        target: "telegram",
        to: "current",
      },
    });

    expect(resolved.channel).toBe("none");
    expect(resolved.reason).toBe("no-target");
    expect(listGroups).toHaveBeenCalled();
    expect(listGroupsLive).toHaveBeenCalled();
  });

  it("keeps heartbeat route canonicalization best-effort when target resolution fails", async () => {
    setActivePluginRegistry(
      createTargetsTestRegistry([
        createTestChannelPlugin({
          id: "telegram",
          label: "Telegram",
          outbound: {
            deliveryMode: "direct",
            resolveTarget: ({ to }) =>
              to
                ? { ok: true as const, to: to.trim() }
                : { ok: false as const, error: new Error("target required") },
          },
          messaging: {
            targetPrefixes: ["telegram"],
            inferTargetChatType: () => "group",
            targetResolver: {
              resolveTarget: async () => {
                throw new Error("directory unavailable");
              },
            },
            resolveOutboundSessionRoute: ({ target }) => ({
              sessionKey: `main:telegram:group:${target}`,
              baseSessionKey: `main:telegram:group:${target}`,
              peer: { kind: "group", id: target },
              chatType: "group",
              from: `telegram:group:${target}`,
              to: target,
            }),
          },
        }),
      ]),
    );

    const resolved = await resolveHeartbeatDeliveryTargetWithSessionRoute({
      cfg: {},
      agentId: "main",
      heartbeat: {
        target: "telegram",
        to: "@public_group",
      },
    });

    expect(resolved.channel).toBe("telegram");
    expect(resolved.to).toBe("@public_group");
    expect(resolved.chatType).toBe("group");
  });

  it("keeps heartbeat route canonicalization best-effort when route resolution fails", async () => {
    const alpha = createGenericTargetTestPlugin("alpha", "Alpha");
    setActivePluginRegistry(
      createTargetsTestRegistry([
        {
          ...alpha,
          messaging: {
            ...alpha.messaging,
            inferTargetChatType: () => "group",
            resolveOutboundSessionRoute: () => {
              throw new Error("route lookup failed");
            },
          },
        },
      ]),
    );

    const resolved = await resolveHeartbeatDeliveryTargetWithSessionRoute({
      cfg: {},
      agentId: "main",
      entry: {
        sessionId: "sess-heartbeat-route-failure",
        updatedAt: 1,
        lastChannel: "alpha",
        lastTo: "group:ops",
      },
      heartbeat: {
        target: "last",
      },
    });

    expect(resolved.channel).toBe("alpha");
    expect(resolved.to).toBe("group:ops");
    expect(resolved.chatType).toBe("group");
  });

  it("applies default heartbeat directPolicy after route canonicalization", async () => {
    const alpha = createGenericTargetTestPlugin("alpha", "Alpha");
    setActivePluginRegistry(
      createTargetsTestRegistry([
        {
          ...alpha,
          messaging: {
            ...alpha.messaging,
            resolveOutboundSessionRoute: () => ({
              sessionKey: "main:alpha:user:u123",
              baseSessionKey: "main:alpha:user:u123",
              peer: { kind: "direct", id: "u123" },
              chatType: "direct",
              from: "alpha:u123",
              to: "user:u123",
            }),
          },
        },
      ]),
    );

    const resolved = await resolveHeartbeatDeliveryTargetWithSessionRoute({
      cfg: {
        agents: {
          defaults: {
            heartbeat: {
              target: "last",
              directPolicy: "block",
            },
          },
        },
      } as OpenClawConfig,
      agentId: "main",
      entry: {
        sessionId: "sess-heartbeat-default-routed-direct",
        updatedAt: 1,
        lastChannel: "alpha",
        lastTo: "channel:D123",
      },
    });

    expect(resolved.channel).toBe("none");
    expect(resolved.reason).toBe("dm-blocked");
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

  it("does not use plugin grammar to match bare stored routes against topic-scoped turn routes", () => {
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
    expect(resolved.threadId).toBeUndefined();
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
