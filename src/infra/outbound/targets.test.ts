// Covers outbound direct target resolution, heartbeat target derivation,
// heartbeat sender context, and route-aware heartbeat refinements.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { ChannelRouteRef } from "../../plugin-sdk/channel-route.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../../plugins/runtime.js";
import { setActiveDegradedSecretOwners } from "../../secrets/runtime-degraded-state.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { normalizeLegacySessionEntryDelivery } from "../state-migrations.legacy-session-store.js";
import {
  hasResolvableHeartbeatOwnerRoute,
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

function createOwnerAllowlistTargetTestPlugin(params: {
  id: ChannelPlugin["id"];
  label: string;
  ownerId: string;
  inferTargetChatType?: NonNullable<ChannelPlugin["messaging"]>["inferTargetChatType"];
}): ChannelPlugin {
  const plugin = createTestChannelPlugin({
    id: params.id,
    label: params.label,
    outbound: {
      deliveryMode: "direct",
      resolveTarget: ({ to }) =>
        to
          ? { ok: true as const, to: to.trim() }
          : { ok: false as const, error: new Error("target required") },
    },
    messaging: {
      ...(params.inferTargetChatType ? { inferTargetChatType: params.inferTargetChatType } : {}),
      // Real channel plugins declare their id as a target prefix; prefixed
      // configured-owner entries rely on it to bind to the right channel.
      targetPrefixes: [String(params.id)],
      targetResolver: { looksLikeId: () => true },
    },
  });
  plugin.config = { ...plugin.config, resolveAllowFrom: () => [params.ownerId] };
  return plugin;
}

vi.mock("./channel-resolution.js", () => ({
  normalizeDeliverableOutboundChannel: mocks.normalizeDeliverableOutboundChannel,
  resolveOutboundChannelPlugin: mocks.resolveOutboundChannelPlugin,
}));

runResolveOutboundTargetCoreTests();

afterEach(() => {
  setActiveDegradedSecretOwners([]);
});

beforeEach(() => {
  mocks.normalizeDeliverableOutboundChannel.mockReset();
  mocks.normalizeDeliverableOutboundChannel.mockImplementation((value?: string | null) => {
    const normalized = typeof value === "string" ? value.trim().toLowerCase() : undefined;
    return ["alpha", "beta", "forum", "googlechat", "telegram", "whatsapp"].includes(
      String(normalized),
    )
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
        lastTo: "chat:stale",
      },
      turnSource: { channel: "beta", to: "chat:event", threadId: "77" },
    });
    expect(resolved.channel).toBe("beta");
    expect(resolved.to).toBe("chat:event");
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

  it("delivers to the last session route when explicitly configured", () => {
    const resolved = resolveHeartbeatDeliveryTarget({
      cfg: {},
      entry: {
        sessionId: "sess-no-config-no-origin",
        updatedAt: 1,
        lastChannel: "alpha",
        lastTo: "chat:one",
      },
      heartbeat: { target: "last" },
    });
    expect(resolved.channel).toBe("alpha");
    expect(resolved.to).toBe("chat:one");
  });

  it("never reuses a group route for implicit owner delivery", () => {
    const forum = createForumTargetTestPlugin();
    forum.config = {
      ...forum.config,
      resolveAllowFrom: () => ["dm:operator"],
    };
    setActivePluginRegistry(createTargetsTestRegistry([forum]));

    const resolved = resolveHeartbeatDeliveryTarget({
      cfg: { channels: { forum: { allowFrom: ["dm:operator"] } } } as OpenClawConfig,
      entry: {
        sessionId: "sess-owner-group",
        updatedAt: 1,
        lastChannel: "forum",
        lastTo: "room:ops",
        chatType: "group",
      },
    });

    expect(resolved.channel).toBe("forum");
    expect(resolved.to).toBe("dm:operator");
    expect(resolved.chatType).toBe("direct");
  });

  it("prefers commands.ownerAllowFrom over channel allowFrom", () => {
    const alpha = createGenericTargetTestPlugin("alpha", "Alpha");
    alpha.config = { ...alpha.config, resolveAllowFrom: () => ["user:channel-owner"] };
    setActivePluginRegistry(createTargetsTestRegistry([alpha]));

    const resolved = resolveHeartbeatDeliveryTarget({
      cfg: {
        commands: { ownerAllowFrom: ["user:global-owner"] },
        channels: { alpha: { allowFrom: ["user:channel-owner"] } },
      } as OpenClawConfig,
      heartbeat: { target: "owner" },
    });

    expect(resolved).toMatchObject({
      channel: "alpha",
      to: "user:global-owner",
      chatType: "direct",
    });
  });

  it("uses the first owner entry compatible with a configured channel", () => {
    const telegram = createOwnerAllowlistTargetTestPlugin({
      id: "telegram",
      label: "Telegram",
      ownerId: "789",
      inferTargetChatType: ({ to }) => (/^\d+$/.test(to) ? "direct" : undefined),
    });
    setActivePluginRegistry(createTargetsTestRegistry([telegram]));

    const resolved = resolveHeartbeatDeliveryTarget({
      cfg: {
        commands: { ownerAllowFrom: ["discord:123", "456"] },
        channels: { telegram: { allowFrom: ["789"] } },
      } as OpenClawConfig,
      heartbeat: { target: "owner" },
    });

    expect(resolved).toMatchObject({ channel: "telegram", to: "456", chatType: "direct" });
  });

  it("falls back to the channel allowFrom owner", () => {
    const alpha = createGenericTargetTestPlugin("alpha", "Alpha");
    alpha.config = { ...alpha.config, resolveAllowFrom: () => ["", "*", "user:channel-owner"] };
    setActivePluginRegistry(createTargetsTestRegistry([alpha]));

    const resolved = resolveHeartbeatDeliveryTarget({
      cfg: { channels: { alpha: { allowFrom: ["user:channel-owner"] } } } as OpenClawConfig,
      heartbeat: { target: "owner" },
    });

    expect(resolved).toMatchObject({
      channel: "alpha",
      to: "user:channel-owner",
      chatType: "direct",
    });
  });

  it("reports no route for wildcard-only owner allowlists", () => {
    const alpha = createGenericTargetTestPlugin("alpha", "Alpha");
    alpha.config = { ...alpha.config, resolveAllowFrom: () => ["", "*"] };
    setActivePluginRegistry(createTargetsTestRegistry([alpha]));

    const resolved = resolveHeartbeatDeliveryTarget({
      cfg: {
        commands: { ownerAllowFrom: ["", "*"] },
        channels: { alpha: { allowFrom: ["*"] } },
      } as OpenClawConfig,
    });

    expect(resolved).toMatchObject({ channel: "none", reason: "no-route" });
  });

  it("reports no route for channel-scoped wildcard owner allowlists", () => {
    const telegram = createOwnerAllowlistTargetTestPlugin({
      id: "telegram",
      label: "Telegram",
      ownerId: "telegram:*",
      inferTargetChatType: () => "direct",
    });
    setActivePluginRegistry(createTargetsTestRegistry([telegram]));

    const resolved = resolveHeartbeatDeliveryTarget({
      cfg: {
        commands: { ownerAllowFrom: ["telegram:*"] },
        channels: { telegram: { allowFrom: ["telegram:*"] } },
      } as OpenClawConfig,
      heartbeat: { target: "owner" },
    });

    expect(resolved).toMatchObject({ channel: "none", reason: "no-route" });
  });

  it("picks the first configured channel in deterministic registry order", () => {
    const alpha = createGenericTargetTestPlugin("alpha", "Alpha");
    alpha.config = { ...alpha.config, resolveAllowFrom: () => ["user:alpha-owner"] };
    const beta = createGenericTargetTestPlugin("beta", "Beta");
    beta.config = { ...beta.config, resolveAllowFrom: () => ["user:beta-owner"] };
    setActivePluginRegistry(createTargetsTestRegistry([beta, alpha]));

    const resolved = resolveHeartbeatDeliveryTarget({
      cfg: {
        channels: {
          alpha: { allowFrom: ["user:alpha-owner"] },
          beta: { allowFrom: ["user:beta-owner"] },
        },
      } as OpenClawConfig,
    });

    expect(resolved).toMatchObject({ channel: "alpha", to: "user:alpha-owner" });
  });

  it.each(["cold", "disabled", "inspection-unavailable", "stale"] as const)(
    "keeps heartbeat owner discovery usable when an account is %s",
    (state) => {
      const unavailable = state !== "stale";
      const alpha = createOwnerAllowlistTargetTestPlugin({
        id: "alpha",
        label: "Alpha",
        ownerId: "user:alpha-owner",
        inferTargetChatType: () => "direct",
      });
      const beta = createOwnerAllowlistTargetTestPlugin({
        id: "beta",
        label: "Beta",
        ownerId: "user:beta-owner",
        inferTargetChatType: () => "direct",
      });
      const resolveAllowFrom = vi.fn(() => {
        if (unavailable) {
          throw new Error("unavailable credential must not resolve for owner discovery");
        }
        return ["user:alpha-owner"];
      });
      alpha.config = {
        ...alpha.config,
        listAccountIds: () => ["work"],
        inspectAccount: () => ({
          enabled: state !== "disabled",
          configured: true,
          tokenStatus: state === "inspection-unavailable" ? "configured_unavailable" : "available",
        }),
        resolveAllowFrom,
      };
      beta.config.listAccountIds = () => ["work"];
      setActivePluginRegistry(createTargetsTestRegistry([alpha, beta]));
      if (state === "cold" || state === "stale") {
        setActiveDegradedSecretOwners([
          {
            ownerKind: "account",
            ownerId: "alpha:work",
            state: "unavailable",
            degradationState: state,
            paths: ["channels.alpha.accounts.work.token"],
            refKeys: [],
            reason: "secret reference was not found",
          },
        ]);
      }
      const cfg = { channels: { alpha: {}, beta: {} } } as OpenClawConfig;

      expect(hasResolvableHeartbeatOwnerRoute({ cfg, heartbeat: { accountId: "work" } })).toBe(
        true,
      );
      expect(
        resolveHeartbeatDeliveryTarget({ cfg, heartbeat: { accountId: "work" } }),
      ).toMatchObject({
        channel: unavailable ? "beta" : "alpha",
        accountId: "work",
        to: unavailable ? "user:beta-owner" : "user:alpha-owner",
      });
      if (unavailable) {
        expect(resolveAllowFrom).not.toHaveBeenCalled();
      } else {
        expect(resolveAllowFrom).toHaveBeenCalled();
      }
    },
  );

  it("keeps owner discovery fail-closed for unresolved store SecretRefs and resolves once the credential is materialized", () => {
    const telegram = createOwnerAllowlistTargetTestPlugin({
      id: "telegram",
      label: "Telegram",
      ownerId: "123456789",
      inferTargetChatType: ({ to }) => (/^\d+$/.test(to) ? "direct" : undefined),
    });
    telegram.config = {
      ...telegram.config,
      listAccountIds: () => ["default"],
      inspectAccount: (cfg: OpenClawConfig) => {
        const botToken = cfg.channels?.telegram?.botToken;
        return typeof botToken === "string" && botToken.trim()
          ? { enabled: true, configured: true, token: botToken, tokenStatus: "available" }
          : { enabled: true, configured: true, tokenStatus: "configured_unavailable" };
      },
    };
    setActivePluginRegistry(createTargetsTestRegistry([telegram]));

    // A store-backed SecretRef that this command path could not resolve must keep
    // owner discovery fail-closed instead of reporting a phantom route.
    const unresolvedCfg: OpenClawConfig = {
      commands: { ownerAllowFrom: ["telegram:123456789"] },
      channels: {
        telegram: {
          enabled: true,
          botToken: { source: "store", provider: "default", id: "TELEGRAM_BOT_TOKEN" },
        },
      },
    };
    expect(hasResolvableHeartbeatOwnerRoute({ cfg: unresolvedCfg })).toBe(false);

    // Once the read-only resolution contract materializes the credential, the
    // configured owner route resolves without any other config change (#137217).
    const resolvedCfg: OpenClawConfig = {
      commands: { ownerAllowFrom: ["telegram:123456789"] },
      channels: { telegram: { enabled: true, botToken: "8905123456:AAF-example-bDTs" } },
    };
    expect(hasResolvableHeartbeatOwnerRoute({ cfg: resolvedCfg })).toBe(true);
  });

  it("reuses an exact direct owner route with its account and thread", () => {
    const alpha = createGenericTargetTestPlugin("alpha", "Alpha");
    setActivePluginRegistry(createTargetsTestRegistry([alpha]));

    const resolved = resolveHeartbeatDeliveryTarget({
      cfg: { commands: { ownerAllowFrom: ["alpha:user:owner"] } },
      entry: {
        sessionId: "sess-owner-direct",
        updatedAt: 1,
        lastChannel: "alpha",
        lastTo: "user:owner",
        lastAccountId: "work",
        lastThreadId: "thread-7",
        chatType: "direct",
      },
    });

    expect(resolved).toMatchObject({
      channel: "alpha",
      to: "user:owner",
      accountId: "work",
      threadId: "thread-7",
      chatType: "direct",
    });
  });

  it("rejects an owner id that resolves to a group", () => {
    const forum = createForumTargetTestPlugin();
    forum.config = { ...forum.config, resolveAllowFrom: () => ["room:operators"] };
    setActivePluginRegistry(createTargetsTestRegistry([forum]));

    const resolved = resolveHeartbeatDeliveryTarget({
      cfg: { channels: { forum: { allowFrom: ["room:operators"] } } } as OpenClawConfig,
      heartbeat: { target: "owner" },
    });

    expect(resolved).toMatchObject({ channel: "none", reason: "no-route" });
  });

  it.each([undefined, "owner"])(
    "uses a turn-source origin before owner discovery for target %s",
    (target) => {
      const resolved = resolveHeartbeatDeliveryTarget({
        cfg: {},
        heartbeat: target ? { target } : undefined,
        turnSource: { channel: "beta", to: "group:event", threadId: "77" },
      });

      expect(resolved).toMatchObject({
        channel: "beta",
        to: "group:event",
        threadId: "77",
      });
    },
  );

  it.each([undefined, "owner"])("ignores heartbeat.to for target %s", (target) => {
    const alpha = createGenericTargetTestPlugin("alpha", "Alpha");
    alpha.config = { ...alpha.config, resolveAllowFrom: () => ["user:owner"] };
    setActivePluginRegistry(createTargetsTestRegistry([alpha]));
    const heartbeat = { ...(target ? { target } : {}), to: "group:wrong" };

    const resolved = resolveHeartbeatDeliveryTarget({
      cfg: { channels: { alpha: { allowFrom: ["user:owner"] } } } as OpenClawConfig,
      heartbeat,
    });

    expect(resolved).toMatchObject({ channel: "alpha", to: "user:owner" });
  });

  it("reports no route when unset heartbeat config has no session route", () => {
    const resolved = resolveHeartbeatDeliveryTarget({
      cfg: {},
      entry: {
        sessionId: "sess-no-config-no-route",
        updatedAt: 1,
      },
    });
    expect(resolved.channel).toBe("none");
    expect(resolved.reason).toBe("no-route");
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
      agentId: "ops",
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
      agentId: "ops",
      allowBootstrap: true,
    });
    expect(
      mocks.resolveOutboundChannelPlugin.mock.calls.filter(
        ([params]) => params.allowBootstrap === true,
      ),
    ).toHaveLength(1);
  });

  it("upgrades an owner-route setup shell with the selected agent runtime", () => {
    const runtime = createOwnerAllowlistTargetTestPlugin({
      id: "forum",
      label: "Forum",
      ownerId: "user:ops",
      inferTargetChatType: () => "direct",
    });
    const setup = { ...runtime, outbound: undefined };
    setActivePluginRegistry(createTargetsTestRegistry([setup]));
    mocks.resolveOutboundChannelPlugin.mockImplementation(
      ({
        channel,
        agentId,
        allowBootstrap,
      }: {
        channel: string;
        agentId?: string;
        allowBootstrap?: boolean;
      }) => (channel === "forum" && agentId === "ops" && allowBootstrap === true ? runtime : setup),
    );
    const cfg = { channels: { forum: {} } } as OpenClawConfig;

    const resolved = resolveHeartbeatDeliveryTarget({
      cfg,
      agentId: "ops",
      heartbeat: { target: "owner" },
    });

    expect(resolved.channel).toBe("forum");
    expect(resolved.to).toBe("user:ops");
    expect(mocks.resolveOutboundChannelPlugin).toHaveBeenCalledWith({
      channel: "forum",
      cfg,
      agentId: "ops",
      allowBootstrap: true,
    });
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

  it("reports no route without a concrete last target", () => {
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
    expect(resolved.reason).toBe("no-route");
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
    expect(mocks.resolveOutboundChannelPlugin).toHaveBeenCalledWith({
      channel: "forum",
      cfg,
      agentId: "main",
      allowBootstrap: true,
    });
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

  it("rejects an owner destination whose canonical session route is a group", async () => {
    const alpha = createTestChannelPlugin({
      id: "alpha",
      label: "Alpha",
      outbound: {
        deliveryMode: "direct",
        resolveTarget: ({ to }) =>
          to
            ? { ok: true as const, to: to.trim() }
            : { ok: false as const, error: new Error("target required") },
      },
      messaging: {
        inferTargetChatType: () => "direct",
        targetResolver: {
          resolveTarget: async ({ normalized }) => ({
            to: normalized,
            kind: "user",
            source: "directory",
          }),
        },
        resolveOutboundSessionRoute: ({ target }) => ({
          sessionKey: `main:alpha:group:${target}`,
          baseSessionKey: `main:alpha:group:${target}`,
          peer: { kind: "group", id: target },
          chatType: "group",
          from: `alpha:group:${target}`,
          to: target,
        }),
      },
    });
    alpha.config = { ...alpha.config, resolveAllowFrom: () => ["operator"] };
    setActivePluginRegistry(createTargetsTestRegistry([alpha]));

    const resolved = await resolveHeartbeatDeliveryTargetWithSessionRoute({
      cfg: { channels: { alpha: { allowFrom: ["operator"] } } } as OpenClawConfig,
      agentId: "main",
      heartbeat: { target: "owner" },
    });

    expect(resolved).toMatchObject({ channel: "none", reason: "no-route" });
  });

  it("delivers a Google Chat user allowlist entry to its owner route", async () => {
    const googlechat = createOwnerAllowlistTargetTestPlugin({
      id: "googlechat",
      label: "Google Chat",
      ownerId: "users/abc",
      inferTargetChatType: ({ to }) => (to.startsWith("users/") ? "direct" : undefined),
    });
    setActivePluginRegistry(createTargetsTestRegistry([googlechat]));

    const resolved = await resolveHeartbeatDeliveryTargetWithSessionRoute({
      cfg: { channels: { googlechat: { allowFrom: ["users/abc"] } } } as OpenClawConfig,
      agentId: "main",
      heartbeat: { target: "owner" },
    });

    expect(resolved).toMatchObject({ channel: "googlechat", to: "users/abc" });
  });

  it("rejects a Google Chat space allowlist entry as an owner route", async () => {
    const googlechat = createOwnerAllowlistTargetTestPlugin({
      id: "googlechat",
      label: "Google Chat",
      ownerId: "spaces/xyz",
      inferTargetChatType: ({ to }) => (to.startsWith("spaces/") ? "group" : undefined),
    });
    setActivePluginRegistry(createTargetsTestRegistry([googlechat]));

    const resolved = await resolveHeartbeatDeliveryTargetWithSessionRoute({
      cfg: { channels: { googlechat: { allowFrom: ["spaces/xyz"] } } } as OpenClawConfig,
      agentId: "main",
      heartbeat: { target: "owner" },
    });

    expect(resolved).toMatchObject({ channel: "none", reason: "no-route" });
  });

  it.each(["@shared", "user:shared"])(
    "rejects classifier-proven group owner id %s",
    async (ownerId) => {
      const telegram = createOwnerAllowlistTargetTestPlugin({
        id: "telegram",
        label: "Telegram",
        ownerId,
        inferTargetChatType: () => "group",
      });
      setActivePluginRegistry(createTargetsTestRegistry([telegram]));

      const resolved = await resolveHeartbeatDeliveryTargetWithSessionRoute({
        cfg: { channels: { telegram: { allowFrom: [ownerId] } } } as OpenClawConfig,
        agentId: "main",
        heartbeat: { target: "owner" },
      });

      expect(resolved).toMatchObject({ channel: "none", reason: "no-route" });
    },
  );

  it("rejects an unclassified plugin owner id", async () => {
    const external = createOwnerAllowlistTargetTestPlugin({
      id: "external-channel",
      label: "External",
      ownerId: "opaque-owner-id",
    });
    setActivePluginRegistry(createTargetsTestRegistry([external]));

    const resolved = await resolveHeartbeatDeliveryTargetWithSessionRoute({
      cfg: {
        channels: { "external-channel": { allowFrom: ["opaque-owner-id"] } },
      } as OpenClawConfig,
      agentId: "main",
      heartbeat: { target: "owner" },
    });

    expect(resolved).toMatchObject({ channel: "none", reason: "no-route" });
  });

  it("rejects a user-prefixed owner id on a classifier-less plugin", async () => {
    const external = createOwnerAllowlistTargetTestPlugin({
      id: "external-channel",
      label: "External",
      ownerId: "user:shared",
    });
    setActivePluginRegistry(createTargetsTestRegistry([external]));

    const resolved = await resolveHeartbeatDeliveryTargetWithSessionRoute({
      cfg: {} as OpenClawConfig,
      agentId: "main",
      heartbeat: { target: "owner" },
    });

    expect(resolved).toMatchObject({ channel: "none", reason: "no-route" });
  });

  it("prefers a prefixed configured owner on a later channel over session-channel allowFrom", () => {
    const slack = createOwnerAllowlistTargetTestPlugin({
      id: "slack",
      label: "Slack",
      ownerId: "user:slack-local",
      inferTargetChatType: ({ to }) => (/^user:/i.test(to) ? "direct" : undefined),
    });
    const telegram = createOwnerAllowlistTargetTestPlugin({
      id: "telegram",
      label: "Telegram",
      ownerId: "999",
      inferTargetChatType: ({ to }) => (/^\d+$/.test(to) ? "direct" : undefined),
    });
    setActivePluginRegistry(createTargetsTestRegistry([slack, telegram]));

    const resolved = resolveHeartbeatDeliveryTarget({
      cfg: {
        commands: { ownerAllowFrom: ["telegram:456"] },
        channels: {
          slack: { allowFrom: ["user:slack-local"] },
          telegram: { allowFrom: ["999"] },
        },
      } as OpenClawConfig,
      entry: {
        sessionId: "sess-slack-first",
        updatedAt: 1,
        lastChannel: "slack",
        lastTo: "user:someone",
        chatType: "direct",
      },
      heartbeat: { target: "owner" },
    });

    // Precedence and channel binding are under test; the passthrough fixture
    // resolveTarget keeps the raw prefixed form (stripping is covered elsewhere).
    expect(resolved).toMatchObject({ channel: "telegram", to: "telegram:456" });
  });

  it.each([
    { target: undefined, source: false, purpose: "heartbeat-owner" },
    { target: "owner", source: false, purpose: "heartbeat-owner" },
    { target: "whatsapp", source: false, purpose: undefined },
    { target: "owner", source: true, purpose: undefined },
  ] as const)(
    "marks only owner-derived plugin routes: target=$target, source=$source",
    async ({ target, source, purpose }) => {
      const plugin = createOwnerAllowlistTargetTestPlugin({
        id: "whatsapp",
        label: "WhatsApp",
        ownerId: "+15555550166",
        inferTargetChatType: () => "direct",
      });
      const resolveRoute = vi.fn().mockResolvedValue(null);
      plugin.messaging = { ...plugin.messaging, resolveOutboundSessionRoute: resolveRoute };
      setActivePluginRegistry(createTargetsTestRegistry([plugin]));
      const resolved = await resolveHeartbeatDeliveryTargetWithSessionRoute({
        cfg: { channels: { whatsapp: { allowFrom: ["+15555550166"] } } },
        agentId: "main",
        heartbeat: { target, to: "+15555550166" },
        turnSource: source ? { channel: "whatsapp", to: "+15555550166" } : undefined,
      });
      expect(resolved).toMatchObject({ channel: "whatsapp", to: "+15555550166" });
      expect(resolveRoute).toHaveBeenCalledOnce();
      expect(resolveRoute.mock.calls[0]?.[0].deliveryPurpose).toBe(purpose);
    },
  );

  it("delivers a classifier-proven WhatsApp E.164 owner route", async () => {
    const inferTargetChatType = vi.fn(({ to }: { to: string }) =>
      /^\+\d+$/.test(to) ? ("direct" as const) : undefined,
    );
    const whatsapp = createOwnerAllowlistTargetTestPlugin({
      id: "whatsapp",
      label: "WhatsApp",
      ownerId: "+15555550166",
      inferTargetChatType,
    });
    setActivePluginRegistry(createTargetsTestRegistry([whatsapp]));
    const cfg = {
      channels: { whatsapp: { allowFrom: ["+15555550166"] } },
    } as OpenClawConfig;

    expect(hasResolvableHeartbeatOwnerRoute({ cfg })).toBe(true);

    const resolved = await resolveHeartbeatDeliveryTargetWithSessionRoute({
      cfg,
      agentId: "main",
      heartbeat: { target: "owner" },
    });

    expect(resolved).toMatchObject({ channel: "whatsapp", to: "+15555550166" });
    expect(inferTargetChatType).toHaveBeenCalledWith({ to: "+15555550166" });
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

  it.each([
    {
      name: "moved direct session does not block the event group",
      storedTo: "user:operator",
      storedType: "direct",
      eventTo: "group:ops",
      expectedChannel: "alpha",
      expectedType: "group",
    },
    {
      name: "moved group session does not allow the event direct chat",
      storedTo: "group:ops",
      storedType: "group",
      eventTo: "user:operator",
      expectedChannel: "none",
      expectedType: undefined,
    },
    {
      name: "same opaque direct conversation retains its hint",
      storedTo: "opaque-dm",
      storedType: "direct",
      eventTo: "opaque-dm",
      expectedChannel: "none",
      expectedType: undefined,
    },
    {
      name: "same group conversation remains deliverable",
      storedTo: "group:ops",
      storedType: "group",
      eventTo: "group:ops",
      expectedChannel: "alpha",
      expectedType: "group",
    },
  ] as const)(
    "qualifies heartbeat chat type by the selected conversation: $name",
    async ({ storedTo, storedType, eventTo, expectedChannel, expectedType }) => {
      const resolved = await resolveHeartbeatDeliveryTargetWithSessionRoute({
        cfg: {},
        agentId: "main",
        entry: {
          sessionId: "chat-type-owner",
          updatedAt: 1,
          lastChannel: "alpha",
          lastTo: storedTo,
          chatType: storedType,
        },
        heartbeat: { target: "last", directPolicy: "block" },
        turnSource: { channel: "alpha", to: eventTo },
      });
      expect(resolved.channel).toBe(expectedChannel);
      expect(resolved.chatType).toBe(expectedType);
      if (expectedChannel === "none") {
        expect(resolved.reason).toBe("dm-blocked");
        expect(resolved.to).toBeUndefined();
      } else {
        expect(resolved.to).toBe(eventTo);
      }
    },
  );

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

  it.each([
    {
      description: "matching account identities",
      sessionAccountId: "work",
      turnSourceAccountId: "work",
    },
    {
      description: "an unspecified turn-source account",
      sessionAccountId: "work",
      turnSourceAccountId: undefined,
    },
    {
      description: "an unspecified session account",
      sessionAccountId: undefined,
      turnSourceAccountId: "work",
    },
  ])(
    "keeps the session topic for compatible routes with $description",
    ({ sessionAccountId, turnSourceAccountId }) => {
      const resolved = resolveSessionDeliveryTarget({
        entry: {
          sessionId: "sess-forum-compatible-account-topic",
          updatedAt: 1,
          lastChannel: "forum",
          lastTo: "room:ops",
          lastAccountId: sessionAccountId,
          lastThreadId: 1122,
        },
        requestedChannel: "last",
        turnSourceChannel: "forum",
        turnSourceTo: "room:ops",
        turnSourceAccountId,
      });

      expect(resolved.accountId).toBe(turnSourceAccountId);
      expect(resolved.threadId).toBe(1122);
      expect(resolved.threadIdSource).toBe("session");
    },
  );

  it("does not inherit a session topic from a different account on the same channel", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-forum-cross-account-topic",
        updatedAt: 1,
        lastChannel: "forum",
        lastTo: "room:ops",
        lastAccountId: "personal",
        lastThreadId: 1122,
      },
      requestedChannel: "last",
      turnSourceChannel: "forum",
      turnSourceTo: "room:ops",
      turnSourceAccountId: "work",
    });

    expect(resolved.accountId).toBe("work");
    expect(resolved.threadId).toBeUndefined();
    expect(resolved.threadIdSource).toBeUndefined();
    expect(resolved.lastThreadId).toBeUndefined();
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
