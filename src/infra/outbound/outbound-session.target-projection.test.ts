// Covers authoritative target-session selection for outbound delivery projection.
import { beforeEach, describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import {
  selectAuthoritativeOutboundTargetSessionRoute,
  selectOutboundSessionRouteForDelivery,
} from "./outbound-session.js";
import { setMinimalOutboundSessionPluginRegistryForTests } from "./outbound-session.test-helpers.js";

describe("selectAuthoritativeOutboundTargetSessionRoute", () => {
  beforeEach(() => {
    setMinimalOutboundSessionPluginRegistryForTests();
  });

  const exactDirectRoute = {
    sessionKey: "agent:main:bound-channel:direct:alice",
    baseSessionKey: "agent:main:bound-channel:direct:alice",
    recipientSessionExact: true as const,
    peer: { kind: "direct" as const, id: "alice" },
    chatType: "direct" as const,
    from: "bound-channel:alice",
    to: "user:alice",
  };

  it("projects an exact recipient into the currently bound agent", () => {
    const cfg = {
      session: { dmScope: "per-channel-peer" },
      bindings: [
        {
          agentId: "support",
          match: { channel: "bound-channel", peer: exactDirectRoute.peer },
        },
      ],
    } as OpenClawConfig;

    expect(
      selectAuthoritativeOutboundTargetSessionRoute({
        cfg,
        sourceAgentId: "main",
        channel: "bound-channel",
        route: exactDirectRoute,
      }),
    ).toEqual({
      agentId: "support",
      isCurrent: expect.any(Function),
      route: {
        ...exactDirectRoute,
        sessionKey: "agent:support:bound-channel:direct:alice",
        baseSessionKey: "agent:support:bound-channel:direct:alice",
      },
    });
  });

  it("rejects a projection after a hot config reload changes the route owner", () => {
    const initialConfig = {
      session: { dmScope: "per-channel-peer" },
      bindings: [
        {
          agentId: "support",
          match: { channel: "bound-channel", peer: exactDirectRoute.peer },
        },
      ],
    } as OpenClawConfig;
    let currentConfig = initialConfig;
    const selected = selectAuthoritativeOutboundTargetSessionRoute({
      cfg: initialConfig,
      readCurrentConfig: () => currentConfig,
      sourceAgentId: "main",
      channel: "bound-channel",
      route: exactDirectRoute,
    });

    expect(selected?.isCurrent()).toBe(true);
    currentConfig = {
      ...initialConfig,
      bindings: [
        {
          agentId: "ops",
          match: { channel: "bound-channel", peer: exactDirectRoute.peer },
        },
      ],
    } as OpenClawConfig;
    expect(selected?.isCurrent()).toBe(false);
  });

  it("accepts an equivalent runtime config clone", () => {
    const initialConfig = {
      session: { dmScope: "per-channel-peer" },
      bindings: [
        {
          agentId: "support",
          match: { channel: "bound-channel", peer: exactDirectRoute.peer },
        },
      ],
    } as OpenClawConfig;
    const currentConfig = structuredClone(initialConfig);
    const selected = selectAuthoritativeOutboundTargetSessionRoute({
      cfg: initialConfig,
      readCurrentConfig: () => currentConfig,
      sourceAgentId: "main",
      channel: "bound-channel",
      route: exactDirectRoute,
    });

    expect(selected?.isCurrent()).toBe(true);
  });

  it.each([
    ["DM scope", { session: { dmScope: "per-channel-peer" } }],
    ["session scope", { session: { scope: "global" } }],
  ] as const)("rejects a stale route after a hot %s change", (_label, nextConfig) => {
    const initialConfig = {} as OpenClawConfig;
    let currentConfig = initialConfig;
    const selected = selectAuthoritativeOutboundTargetSessionRoute({
      cfg: initialConfig,
      readCurrentConfig: () => currentConfig,
      sourceAgentId: "main",
      channel: "bound-channel",
      route: exactDirectRoute,
    });

    expect(selected?.isCurrent()).toBe(true);
    currentConfig = nextConfig as OpenClawConfig;
    expect(selected?.isCurrent()).toBe(false);
  });

  it("rejects a group route whose owner depends on unavailable ingress context", () => {
    const route = {
      sessionKey: "agent:main:bound-channel:channel:thread-1",
      baseSessionKey: "agent:main:bound-channel:channel:thread-1",
      recipientSessionExact: true as const,
      peer: { kind: "channel" as const, id: "thread-1" },
      chatType: "channel" as const,
      from: "bound-channel:channel:thread-1",
      to: "channel:thread-1",
      threadId: "thread-1",
    };
    const cfg = {
      bindings: [
        {
          agentId: "support",
          match: { channel: "bound-channel", guildId: "guild-1" },
          session: { groupScope: "main" },
        },
      ],
    } as OpenClawConfig;

    expect(
      selectAuthoritativeOutboundTargetSessionRoute({
        cfg,
        sourceAgentId: "main",
        channel: "bound-channel",
        route,
      }),
    ).toBeNull();
  });

  it("fails closed when a channel owner omits its exact session", () => {
    const plugin = {
      ...createChannelTestPluginBase({ id: "owned-channel" }),
      messaging: {
        resolveConversationRouteOwner: () => ({ kind: "agent" as const, agentId: "main" }),
      },
    } satisfies ChannelPlugin;
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "owned-channel", source: "test", plugin }]),
    );

    const route = {
      ...exactDirectRoute,
      sessionKey: "agent:main:owned-channel:direct:alice",
      baseSessionKey: "agent:main:owned-channel:direct:alice",
      from: "owned-channel:alice",
    };

    expect(
      selectOutboundSessionRouteForDelivery({
        cfg: {},
        agentId: "main",
        channel: "owned-channel",
        route,
        mode: "allow-fallback",
      }),
    ).toEqual(route);
    expect(
      selectAuthoritativeOutboundTargetSessionRoute({
        cfg: {},
        sourceAgentId: "main",
        channel: "owned-channel",
        route,
      }),
    ).toBeNull();
  });

  it("uses a channel-owned exact session once and revalidates it", () => {
    let ownerSessionKey = "agent:main:owned-channel:direct:alice:thread:bound";
    const plugin = {
      ...createChannelTestPluginBase({ id: "owned-channel" }),
      messaging: {
        resolveConversationRouteOwner: () => ({
          kind: "agent" as const,
          agentId: "main",
          sessionKey: ownerSessionKey,
        }),
      },
    } satisfies ChannelPlugin;
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "owned-channel", source: "test", plugin }]),
    );
    const route = {
      ...exactDirectRoute,
      sessionKey: "agent:main:owned-channel:direct:alice:thread:outbound",
      baseSessionKey: "agent:main:owned-channel:direct:alice",
      from: "owned-channel:alice",
    };

    const selected = selectAuthoritativeOutboundTargetSessionRoute({
      cfg: {},
      sourceAgentId: "main",
      channel: "owned-channel",
      route,
    });

    expect(selected).toMatchObject({
      agentId: "main",
      route: {
        sessionKey: "agent:main:owned-channel:direct:alice:thread:bound",
        baseSessionKey: "agent:main:owned-channel:direct:alice:thread:bound",
      },
    });
    expect(selected?.isCurrent()).toBe(true);
    ownerSessionKey = "agent:main:owned-channel:direct:alice:thread:replacement";
    expect(selected?.isCurrent()).toBe(false);
  });

  it("rejects a channel-owned session whose key belongs to another agent", () => {
    const plugin = {
      ...createChannelTestPluginBase({ id: "owned-channel" }),
      messaging: {
        resolveConversationRouteOwner: () => ({
          kind: "agent" as const,
          agentId: "main",
          sessionKey: "agent:other:owned-channel:direct:alice",
        }),
      },
    } satisfies ChannelPlugin;
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "owned-channel", source: "test", plugin }]),
    );

    expect(
      selectAuthoritativeOutboundTargetSessionRoute({
        cfg: {},
        sourceAgentId: "main",
        channel: "owned-channel",
        route: exactDirectRoute,
      }),
    ).toBeNull();
  });

  it("keeps an ownerless global target in the current conversation owner's store", () => {
    const plugin = {
      ...createChannelTestPluginBase({ id: "owned-channel" }),
      messaging: {
        resolveConversationRouteOwner: () => ({
          kind: "agent" as const,
          agentId: "support",
          sessionKey: "agent:support:owned-channel:direct:alice",
        }),
      },
    } satisfies ChannelPlugin;
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "owned-channel", source: "test", plugin }]),
    );

    expect(
      selectAuthoritativeOutboundTargetSessionRoute({
        cfg: { session: { scope: "global", store: "/stores/shared.sqlite" } },
        sourceAgentId: "main",
        channel: "owned-channel",
        route: { ...exactDirectRoute, sessionKey: "global", baseSessionKey: "global" },
      }),
    ).toMatchObject({
      agentId: "support",
      route: { sessionKey: "global", baseSessionKey: "global" },
    });
  });

  it("uses the configured fixed-store owner for a global target instead of its channel binding", () => {
    const cfg = {
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { main: {}, ops: {}, support: {} },
      },
      session: { scope: "global", store: "/stores/shared.sqlite" },
      bindings: [
        {
          agentId: "support",
          match: { channel: "bound-channel", peer: exactDirectRoute.peer },
        },
      ],
    } as OpenClawConfig;

    expect(
      selectAuthoritativeOutboundTargetSessionRoute({
        cfg,
        sourceAgentId: "main",
        channel: "bound-channel",
        route: { ...exactDirectRoute, sessionKey: "global", baseSessionKey: "global" },
      }),
    ).toMatchObject({
      agentId: "ops",
      route: { sessionKey: "global", baseSessionKey: "global" },
    });
  });

  it("rejects a global target whose fixed-store owner is retired", () => {
    const cfg = {
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "retired" } },
        entries: { main: {}, support: {} },
      },
      session: { scope: "global", store: "/stores/shared.sqlite" },
      bindings: [
        {
          agentId: "support",
          match: { channel: "bound-channel", peer: exactDirectRoute.peer },
        },
      ],
    } as OpenClawConfig;

    expect(
      selectAuthoritativeOutboundTargetSessionRoute({
        cfg,
        sourceAgentId: "main",
        channel: "bound-channel",
        route: { ...exactDirectRoute, sessionKey: "global", baseSessionKey: "global" },
      }),
    ).toBeNull();
  });

  it("accepts an authoritative direct alias in the configured global bucket", () => {
    const route = {
      ...exactDirectRoute,
      sessionKey: "global",
      baseSessionKey: "global",
      recipientSessionExact: "direct-alias" as const,
    };

    expect(
      selectAuthoritativeOutboundTargetSessionRoute({
        cfg: { session: { scope: "global" } },
        sourceAgentId: "main",
        channel: "bound-channel",
        route,
      }),
    ).toMatchObject({
      agentId: "main",
      route: { sessionKey: "global", baseSessionKey: "global" },
    });
  });

  it("keeps a main-session direct alias when another account has an isolated override", () => {
    const route = {
      ...exactDirectRoute,
      sessionKey: "agent:main:main",
      baseSessionKey: "agent:main:main",
      recipientSessionExact: "direct-alias" as const,
    };

    expect(
      selectAuthoritativeOutboundTargetSessionRoute({
        cfg: {
          session: { dmScope: "main" },
          bindings: [
            {
              agentId: "main",
              match: {
                channel: "bound-channel",
                accountId: "work",
                peer: exactDirectRoute.peer,
              },
              session: { dmScope: "per-channel-peer" },
            },
          ],
        },
        sourceAgentId: "main",
        channel: "bound-channel",
        accountId: "default",
        route,
      }),
    ).toMatchObject({ route: { sessionKey: "agent:main:main" } });
  });

  it("rebases a main-session direct alias for its matching isolated peer", () => {
    const route = {
      ...exactDirectRoute,
      sessionKey: "agent:main:main",
      baseSessionKey: "agent:main:main",
      recipientSessionExact: "direct-alias" as const,
    };

    expect(
      selectAuthoritativeOutboundTargetSessionRoute({
        cfg: {
          session: { dmScope: "main" },
          bindings: [
            {
              agentId: "main",
              match: { channel: "bound-channel", peer: exactDirectRoute.peer },
              session: { dmScope: "per-channel-peer" },
            },
          ],
        },
        sourceAgentId: "main",
        channel: "bound-channel",
        route,
      }),
    ).toMatchObject({
      route: {
        sessionKey: "agent:main:bound-channel:direct:alice",
        baseSessionKey: "agent:main:bound-channel:direct:alice",
      },
    });
  });

  it("rebases a scoped binding while preserving the selected thread suffix", () => {
    const route = {
      ...exactDirectRoute,
      sessionKey: `${exactDirectRoute.sessionKey}:thread:topic-1`,
    };
    const selected = selectAuthoritativeOutboundTargetSessionRoute({
      cfg: {
        session: { dmScope: "per-channel-peer" },
        bindings: [
          {
            agentId: "main",
            match: { channel: "bound-channel", peer: exactDirectRoute.peer },
            session: { dmScope: "main" },
          },
        ],
      },
      sourceAgentId: "main",
      channel: "bound-channel",
      route,
    });

    expect(selected).toMatchObject({
      agentId: "main",
      route: {
        sessionKey: "agent:main:main:thread:topic-1",
        baseSessionKey: "agent:main:main",
      },
    });
  });
});
