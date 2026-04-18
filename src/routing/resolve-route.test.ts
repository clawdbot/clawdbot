import { describe, expect, test, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import * as routingBindings from "./bindings.js";
import {
  deriveLastRoutePolicy,
  resolveAgentRoute,
  resolveInboundLastRouteSessionKey,
} from "./resolve-route.js";

type ResolvedRouteExpectation = {
  agentId: string;
  matchedBy: string;
  sessionKey?: string;
  accountId?: string;
  lastRoutePolicy?: string;
};

type CompatRoutePeerKind =
  | NonNullable<Parameters<typeof resolveAgentRoute>[0]["peer"]>["kind"]
  | "dm";

const resolveRoute = (
  params: Omit<Parameters<typeof resolveAgentRoute>[0], "cfg"> & { cfg?: OpenClawConfig },
) =>
  resolveAgentRoute({
    cfg: params.cfg ?? {},
    ...params,
  });

function expectResolvedRoute(
  route: ReturnType<typeof resolveAgentRoute>,
  expected: ResolvedRouteExpectation,
) {
  expect(route.agentId).toBe(expected.agentId);
  expect(route.matchedBy).toBe(expected.matchedBy);
  if (expected.sessionKey !== undefined) {
    expect(route.sessionKey).toBe(expected.sessionKey);
  }
  if (expected.accountId !== undefined) {
    expect(route.accountId).toBe(expected.accountId);
  }
  if (expected.lastRoutePolicy !== undefined) {
    expect(route.lastRoutePolicy).toBe(expected.lastRoutePolicy);
  }
}

function createCompatPeer(kind: CompatRoutePeerKind, id: string) {
  return { kind, id } as unknown as NonNullable<Parameters<typeof resolveAgentRoute>[0]["peer"]>;
}

describe("resolveAgentRoute", () => {
  const expectDirectRouteSessionKey = (params: {
    cfg: OpenClawConfig;
    channel: Parameters<typeof resolveAgentRoute>[0]["channel"];
    peerId: string;
    expected: string;
  }) => {
    const route = resolveRoute({
      cfg: params.cfg,
      channel: params.channel,
      accountId: null,
      peer: { kind: "direct", id: params.peerId },
    });
    expect(route.sessionKey).toBe(params.expected);
    return route;
  };

  const expectRouteResolutionCase = (params: {
    routeParams: Omit<Parameters<typeof resolveRoute>[0], "cfg"> & { cfg: OpenClawConfig };
    expected: ResolvedRouteExpectation;
  }) => {
    expectResolvedRoute(resolveRoute(params.routeParams), params.expected);
  };

  const expectInboundLastRouteSessionKeyCase = (params: {
    route: { mainSessionKey: string; lastRoutePolicy: "main" | "session" };
    sessionKey: string;
    expected: string;
  }) => {
    expect(
      resolveInboundLastRouteSessionKey({
        route: params.route,
        sessionKey: params.sessionKey,
      }),
    ).toBe(params.expected);
  };

  const expectDerivedLastRoutePolicyCase = (params: {
    sessionKey: string;
    mainSessionKey: string;
    expected: "main" | "session";
  }) => {
    expect(
      deriveLastRoutePolicy({
        sessionKey: params.sessionKey,
        mainSessionKey: params.mainSessionKey,
      }),
    ).toBe(params.expected);
  };

  test("defaults to main/default when no bindings exist", () => {
    const cfg: OpenClawConfig = {};
    const route = resolveAgentRoute({
      cfg,
      channel: "whatsapp",
      accountId: null,
      peer: { kind: "direct", id: "+15551234567" },
    });
    expectResolvedRoute(route, {
      agentId: "main",
      accountId: "default",
      sessionKey: "agent:main:main",
      lastRoutePolicy: "main",
      matchedBy: "default",
    });
  });

  test.each([
    { dmScope: "per-peer" as const, expected: "agent:main:direct:+15551234567" },
    {
      dmScope: "per-channel-peer" as const,
      expected: "agent:main:whatsapp:direct:+15551234567",
    },
  ])("dmScope=%s controls direct-message session key isolation", ({ dmScope, expected }) => {
    const cfg: OpenClawConfig = {
      session: { dmScope },
    };
    const route = expectDirectRouteSessionKey({
      cfg,
      channel: "whatsapp",
      peerId: "+15551234567",
      expected,
    });
    expectResolvedRoute(route, {
      agentId: "main",
      matchedBy: "default",
      lastRoutePolicy: "session",
    });
  });

  test.each([
    {
      name: "collapses inbound last-route session keys to main when policy is main",
      route: {
        mainSessionKey: "agent:main:main",
        lastRoutePolicy: "main" as const,
      },
      sessionKey: "agent:main:discord:direct:user-1",
      expected: "agent:main:main",
    },
    {
      name: "preserves inbound last-route session keys when policy is session",
      route: {
        mainSessionKey: "agent:main:main",
        lastRoutePolicy: "session" as const,
      },
      sessionKey: "agent:main:telegram:atlas:direct:123",
      expected: "agent:main:telegram:atlas:direct:123",
    },
  ] as const)("$name", ({ route, sessionKey, expected }) => {
    expectInboundLastRouteSessionKeyCase({ route, sessionKey, expected });
  });

  test.each([
    {
      name: "classifies the main session route as main",
      sessionKey: "agent:main:main",
      mainSessionKey: "agent:main:main",
      expected: "main" as const,
    },
    {
      name: "keeps non-main session routes scoped to session",
      sessionKey: "agent:main:telegram:direct:123",
      mainSessionKey: "agent:main:main",
      expected: "session" as const,
    },
  ] as const)("$name", ({ sessionKey, mainSessionKey, expected }) => {
    expectDerivedLastRoutePolicyCase({ sessionKey, mainSessionKey, expected });
  });

  test.each([
    {
      dmScope: "per-peer" as const,
      channel: "telegram" as const,
      peerId: "111111111",
      expected: "agent:main:direct:alice",
    },
    {
      dmScope: "per-channel-peer" as const,
      channel: "discord" as const,
      peerId: "222222222222222222",
      expected: "agent:main:discord:direct:alice",
    },
  ])(
    "identityLinks applies to direct-message scopes: $channel $dmScope",
    ({ dmScope, channel, peerId, expected }) => {
      const cfg: OpenClawConfig = {
        session: {
          dmScope,
          identityLinks: {
            alice: ["telegram:111111111", "discord:222222222222222222"],
          },
        },
      };
      expectDirectRouteSessionKey({
        cfg,
        channel,
        peerId,
        expected,
      });
    },
  );

  test.each([
    {
      name: "peer binding wins over account binding",
      routeParams: {
        cfg: {
          bindings: [
            {
              agentId: "a",
              match: {
                channel: "whatsapp",
                accountId: "biz",
                peer: { kind: "direct", id: "+1000" },
              },
            },
            {
              agentId: "b",
              match: { channel: "whatsapp", accountId: "biz" },
            },
          ],
        } satisfies OpenClawConfig,
        channel: "whatsapp" as const,
        accountId: "biz",
        peer: { kind: "direct" as const, id: "+1000" },
      },
      expected: {
        agentId: "a",
        sessionKey: "agent:a:main",
        matchedBy: "binding.peer",
      },
    },
    {
      name: "discord channel peer binding wins over guild binding",
      routeParams: {
        cfg: {
          bindings: [
            {
              agentId: "chan",
              match: {
                channel: "discord",
                accountId: "default",
                peer: { kind: "channel", id: "c1" },
              },
            },
            {
              agentId: "guild",
              match: {
                channel: "discord",
                accountId: "default",
                guildId: "g1",
              },
            },
          ],
        } satisfies OpenClawConfig,
        channel: "discord" as const,
        accountId: "default",
        guildId: "g1",
        peer: { kind: "channel" as const, id: "c1" },
      },
      expected: {
        agentId: "chan",
        sessionKey: "agent:chan:discord:channel:c1",
        matchedBy: "binding.peer",
      },
    },
    {
      name: "guild binding wins over account binding when peer is not bound",
      routeParams: {
        cfg: {
          bindings: [
            {
              agentId: "guild",
              match: {
                channel: "discord",
                accountId: "default",
                guildId: "g1",
              },
            },
            {
              agentId: "acct",
              match: { channel: "discord", accountId: "default" },
            },
          ],
        } satisfies OpenClawConfig,
        channel: "discord" as const,
        accountId: "default",
        guildId: "g1",
        peer: { kind: "channel" as const, id: "c1" },
      },
      expected: {
        agentId: "guild",
        matchedBy: "binding.guild",
      },
    },
  ] as const)("$name", ({ routeParams, expected }) => {
    expectRouteResolutionCase({ routeParams, expected });
  });

  test("coerces numeric peer ids to stable session keys", () => {
    const cfg: OpenClawConfig = {};
    const route = resolveAgentRoute({
      cfg,
      channel: "discord",
      accountId: "default",
      peer: { kind: "channel", id: 1468834856187203680n as unknown as string },
    });
    expect(route.sessionKey).toBe("agent:main:discord:channel:1468834856187203680");
  });

  test.each([
    {
      name: "peer+guild binding does not act as guild-wide fallback when peer mismatches (#14752)",
      routeParams: {
        cfg: {
          bindings: [
            {
              agentId: "olga",
              match: {
                channel: "discord",
                peer: { kind: "channel", id: "CHANNEL_A" },
                guildId: "GUILD_1",
              },
            },
            {
              agentId: "main",
              match: {
                channel: "discord",
                guildId: "GUILD_1",
              },
            },
          ],
        } satisfies OpenClawConfig,
        channel: "discord" as const,
        guildId: "GUILD_1",
        peer: { kind: "channel" as const, id: "CHANNEL_B" },
      },
      expected: {
        agentId: "main",
        matchedBy: "binding.guild",
      },
    },
    {
      name: "peer+guild binding requires guild match even when peer matches",
      routeParams: {
        cfg: {
          bindings: [
            {
              agentId: "wrongguild",
              match: {
                channel: "discord",
                peer: { kind: "channel", id: "c1" },
                guildId: "g1",
              },
            },
            {
              agentId: "rightguild",
              match: {
                channel: "discord",
                guildId: "g2",
              },
            },
          ],
        } satisfies OpenClawConfig,
        channel: "discord" as const,
        guildId: "g2",
        peer: { kind: "channel" as const, id: "c1" },
      },
      expected: {
        agentId: "rightguild",
        matchedBy: "binding.guild",
      },
    },
    {
      name: "peer+team binding does not act as team-wide fallback when peer mismatches",
      routeParams: {
        cfg: {
          bindings: [
            {
              agentId: "roomonly",
              match: {
                channel: "slack",
                peer: { kind: "channel", id: "C_A" },
                teamId: "T1",
              },
            },
            {
              agentId: "teamwide",
              match: {
                channel: "slack",
                teamId: "T1",
              },
            },
          ],
        } satisfies OpenClawConfig,
        channel: "slack" as const,
        teamId: "T1",
        peer: { kind: "channel" as const, id: "C_B" },
      },
      expected: {
        agentId: "teamwide",
        matchedBy: "binding.team",
      },
    },
    {
      name: "peer+team binding requires team match even when peer matches",
      routeParams: {
        cfg: {
          bindings: [
            {
              agentId: "wrongteam",
              match: {
                channel: "slack",
                peer: { kind: "channel", id: "C1" },
                teamId: "T1",
              },
            },
            {
              agentId: "rightteam",
              match: {
                channel: "slack",
                teamId: "T2",
              },
            },
          ],
        } satisfies OpenClawConfig,
        channel: "slack" as const,
        teamId: "T2",
        peer: { kind: "channel" as const, id: "C1" },
      },
      expected: {
        agentId: "rightteam",
        matchedBy: "binding.team",
      },
    },
  ] as const)("$name", ({ routeParams, expected }) => {
    expectRouteResolutionCase({ routeParams, expected });
  });

  test("missing accountId in binding matches default account only", () => {
    const cfg: OpenClawConfig = {
      bindings: [{ agentId: "defaultAcct", match: { channel: "whatsapp" } }],
    };

    expectResolvedRoute(
      resolveRoute({
        cfg,
        channel: "whatsapp",
        accountId: undefined,
        peer: { kind: "direct", id: "+1000" },
      }),
      {
        agentId: "defaultacct",
        matchedBy: "binding.account",
      },
    );

    expectResolvedRoute(
      resolveRoute({
        cfg,
        channel: "whatsapp",
        accountId: "biz",
        peer: { kind: "direct", id: "+1000" },
      }),
      {
        agentId: "main",
        matchedBy: "default",
      },
    );
  });

  test.each([
    {
      name: "accountId=* matches any account as a channel fallback",
      cfg: {
        bindings: [
          {
            agentId: "any",
            match: { channel: "whatsapp", accountId: "*" },
          },
        ],
      } satisfies OpenClawConfig,
      channel: "whatsapp" as const,
      accountId: "biz",
      peer: { kind: "direct" as const, id: "+1000" },
      expected: {
        agentId: "any",
        matchedBy: "binding.channel",
      },
    },
    {
      name: "binding accountId matching is canonicalized",
      cfg: {
        bindings: [{ agentId: "biz", match: { channel: "discord", accountId: "BIZ" } }],
      } satisfies OpenClawConfig,
      channel: "discord" as const,
      accountId: " biz ",
      peer: { kind: "direct" as const, id: "u-1" },
      expected: {
        agentId: "biz",
        matchedBy: "binding.account",
        accountId: "biz",
      },
    },
    {
      name: "defaultAgentId is used when no binding matches",
      cfg: {
        agents: {
          list: [{ id: "home", default: true, workspace: "~/openclaw-home" }],
        },
      } satisfies OpenClawConfig,
      channel: "whatsapp" as const,
      accountId: "biz",
      peer: { kind: "direct" as const, id: "+1000" },
      expected: {
        agentId: "home",
        matchedBy: "default",
        sessionKey: "agent:home:main",
      },
    },
  ] as const)("$name", ({ cfg, channel, accountId, peer, expected }) => {
    expectResolvedRoute(
      resolveRoute({
        cfg,
        channel,
        accountId,
        peer,
      }),
      expected,
    );
  });
});

test.each([
  {
    name: "isolates DM sessions per account, channel and sender",
    accountId: "tasks",
    expected: "agent:main:telegram:tasks:direct:7550356539",
  },
  {
    name: "uses default accountId when not provided",
    accountId: null,
    expected: "agent:main:telegram:default:direct:7550356539",
  },
] as const)("dmScope=per-account-channel-peer $name", ({ accountId, expected }) => {
  const route = resolveAgentRoute({
    cfg: {
      session: { dmScope: "per-account-channel-peer" },
    },
    channel: "telegram",
    accountId,
    peer: { kind: "direct", id: "7550356539" },
  });
  expect(route.sessionKey).toBe(expected);
});

describe("parentPeer binding inheritance (thread support)", () => {
  const threadPeer = { kind: "channel" as const, id: "thread-456" };
  const defaultParentPeer = { kind: "channel" as const, id: "parent-channel-123" };

  function makeDiscordPeerBinding(agentId: string, peerId: string) {
    return {
      agentId,
      match: {
        channel: "discord" as const,
        peer: { kind: "channel" as const, id: peerId },
      },
    };
  }

  function makeDiscordGuildBinding(agentId: string, guildId: string) {
    return {
      agentId,
      match: {
        channel: "discord" as const,
        guildId,
      },
    };
  }

  function resolveDiscordThreadRoute(params: {
    cfg: OpenClawConfig;
    parentPeer?: { kind: "channel"; id: string } | null;
    guildId?: string;
  }) {
    const parentPeer = "parentPeer" in params ? params.parentPeer : defaultParentPeer;
    return resolveAgentRoute({
      cfg: params.cfg,
      channel: "discord",
      peer: threadPeer,
      parentPeer,
      guildId: params.guildId,
    });
  }

  function expectDiscordThreadRoute(params: {
    cfg: OpenClawConfig;
    parentPeer?: { kind: "channel"; id: string } | null;
    guildId?: string;
    expectedAgentId: string;
    expectedMatchedBy: string;
  }) {
    const route = resolveDiscordThreadRoute(params);
    expectResolvedRoute(route, {
      agentId: params.expectedAgentId,
      matchedBy: params.expectedMatchedBy,
    });
  }

  test("thread inherits binding from parent channel when no direct match", () => {
    expectDiscordThreadRoute({
      cfg: {
        bindings: [makeDiscordPeerBinding("adecco", defaultParentPeer.id)],
      },
      expectedAgentId: "adecco",
      expectedMatchedBy: "binding.peer.parent",
    });
  });

  test("direct peer binding wins over parent peer binding", () => {
    expectDiscordThreadRoute({
      cfg: {
        bindings: [
          makeDiscordPeerBinding("thread-agent", threadPeer.id),
          makeDiscordPeerBinding("parent-agent", defaultParentPeer.id),
        ],
      },
      expectedAgentId: "thread-agent",
      expectedMatchedBy: "binding.peer",
    });
  });

  test("parent peer binding wins over guild binding", () => {
    expectDiscordThreadRoute({
      cfg: {
        bindings: [
          makeDiscordPeerBinding("parent-agent", defaultParentPeer.id),
          makeDiscordGuildBinding("guild-agent", "guild-789"),
        ],
      },
      guildId: "guild-789",
      expectedAgentId: "parent-agent",
      expectedMatchedBy: "binding.peer.parent",
    });
  });

  test.each([
    {
      name: "falls back to guild binding when no parent peer match",
      cfg: {
        bindings: [
          makeDiscordPeerBinding("other-parent-agent", "other-parent-999"),
          makeDiscordGuildBinding("guild-agent", "guild-789"),
        ],
      } satisfies OpenClawConfig,
      guildId: "guild-789",
      expectedAgentId: "guild-agent",
      expectedMatchedBy: "binding.guild",
    },
    {
      name: "parentPeer with empty id is ignored",
      cfg: {
        bindings: [makeDiscordPeerBinding("parent-agent", defaultParentPeer.id)],
      } satisfies OpenClawConfig,
      parentPeer: { kind: "channel" as const, id: "" },
      expectedAgentId: "main",
      expectedMatchedBy: "default",
    },
    {
      name: "null parentPeer is handled gracefully",
      cfg: {
        bindings: [makeDiscordPeerBinding("parent-agent", defaultParentPeer.id)],
      } satisfies OpenClawConfig,
      parentPeer: null,
      expectedAgentId: "main",
      expectedMatchedBy: "default",
    },
  ])("$name", (testCase) => {
    expectDiscordThreadRoute(testCase);
  });
});

describe("backward compatibility: peer.kind dm → direct", () => {
  test.each([
    {
      name: "legacy dm in config matches runtime direct peer",
      bindingPeerKind: "dm" as const satisfies CompatRoutePeerKind,
      runtimePeerKind: "direct" as const satisfies CompatRoutePeerKind,
    },
    {
      name: "runtime dm peer.kind matches config direct binding (#22730)",
      bindingPeerKind: "direct" as const satisfies CompatRoutePeerKind,
      runtimePeerKind: "dm" as const satisfies CompatRoutePeerKind,
    },
  ])("$name", ({ bindingPeerKind, runtimePeerKind }) => {
    const route = resolveAgentRoute({
      cfg: {
        bindings: [
          {
            agentId: "alex",
            match: {
              channel: "whatsapp",
              peer: createCompatPeer(bindingPeerKind, "+15551234567"),
            },
          },
        ],
      },
      channel: "whatsapp",
      accountId: null,
      peer: createCompatPeer(runtimePeerKind, "+15551234567"),
    });
    expectResolvedRoute(route, {
      agentId: "alex",
      matchedBy: "binding.peer",
    });
  });
});

describe("backward compatibility: peer.kind group ↔ channel", () => {
  test.each([
    {
      name: "config group binding matches runtime channel scope",
      agentId: "slack-group-agent",
      bindingPeerKind: "group" as const satisfies CompatRoutePeerKind,
      runtimePeerKind: "channel" as const satisfies CompatRoutePeerKind,
      expectedAgentId: "slack-group-agent",
      expectedMatchedBy: "binding.peer",
    },
    {
      name: "config channel binding matches runtime group scope",
      agentId: "slack-channel-agent",
      bindingPeerKind: "channel" as const satisfies CompatRoutePeerKind,
      runtimePeerKind: "group" as const satisfies CompatRoutePeerKind,
      expectedAgentId: "slack-channel-agent",
      expectedMatchedBy: "binding.peer",
    },
    {
      name: "group/channel compatibility does not match direct peer kind",
      agentId: "group-only-agent",
      bindingPeerKind: "group" as const satisfies CompatRoutePeerKind,
      runtimePeerKind: "direct" as const satisfies CompatRoutePeerKind,
      expectedAgentId: "main",
      expectedMatchedBy: "default",
    },
  ])(
    "$name",
    ({ agentId, bindingPeerKind, runtimePeerKind, expectedAgentId, expectedMatchedBy }) => {
      const route = resolveAgentRoute({
        cfg: {
          bindings: [
            {
              agentId,
              match: {
                channel: "slack",
                peer: createCompatPeer(bindingPeerKind, "C123456"),
              },
            },
          ],
        },
        channel: "slack",
        accountId: null,
        peer: createCompatPeer(runtimePeerKind, "C123456"),
      });
      expectResolvedRoute(route, {
        agentId: expectedAgentId,
        matchedBy: expectedMatchedBy,
      });
    },
  );
});

describe("role-based agent routing", () => {
  type DiscordBinding = NonNullable<OpenClawConfig["bindings"]>[number];

  function makeDiscordRoleBinding(
    agentId: string,
    params: {
      roles?: readonly string[];
      peerId?: string;
      includeGuildId?: boolean;
    } = {},
  ): DiscordBinding {
    return {
      agentId,
      match: {
        channel: "discord",
        ...(params.includeGuildId === false ? {} : { guildId: "g1" }),
        ...(params.roles !== undefined ? { roles: [...params.roles] } : {}),
        ...(params.peerId ? { peer: { kind: "channel", id: params.peerId } } : {}),
      },
    };
  }

  function expectDiscordRoleRoute(params: {
    bindings: readonly DiscordBinding[];
    memberRoleIds?: readonly string[];
    peerId?: string;
    parentPeerId?: string;
    expectedAgentId: string;
    expectedMatchedBy: string;
  }) {
    const route = resolveRoute({
      cfg: { bindings: [...params.bindings] },
      channel: "discord",
      guildId: "g1",
      ...(params.memberRoleIds ? { memberRoleIds: [...params.memberRoleIds] } : {}),
      peer: { kind: "channel", id: params.peerId ?? "c1" },
      ...(params.parentPeerId
        ? {
            parentPeer: { kind: "channel", id: params.parentPeerId },
          }
        : {}),
    });
    expect(route.agentId).toBe(params.expectedAgentId);
    expect(route.matchedBy).toBe(params.expectedMatchedBy);
  }

  test.each([
    {
      name: "guild+roles binding matches when member has matching role",
      bindings: [makeDiscordRoleBinding("opus", { roles: ["r1"] })],
      memberRoleIds: ["r1"],
      expectedAgentId: "opus",
      expectedMatchedBy: "binding.guild+roles",
    },
    {
      name: "guild+roles binding skipped when no matching role",
      bindings: [makeDiscordRoleBinding("opus", { roles: ["r1"] })],
      memberRoleIds: ["r2"],
      expectedAgentId: "main",
      expectedMatchedBy: "default",
    },
    {
      name: "guild+roles is more specific than guild-only",
      bindings: [
        makeDiscordRoleBinding("opus", { roles: ["r1"] }),
        makeDiscordRoleBinding("sonnet"),
      ],
      memberRoleIds: ["r1"],
      expectedAgentId: "opus",
      expectedMatchedBy: "binding.guild+roles",
    },
    {
      name: "peer binding still beats guild+roles",
      bindings: [
        makeDiscordRoleBinding("peer-agent", { peerId: "c1", includeGuildId: false }),
        makeDiscordRoleBinding("roles-agent", { roles: ["r1"] }),
      ],
      memberRoleIds: ["r1"],
      expectedAgentId: "peer-agent",
      expectedMatchedBy: "binding.peer",
    },
    {
      name: "parent peer binding still beats guild+roles",
      bindings: [
        makeDiscordRoleBinding("parent-agent", {
          peerId: "parent-1",
          includeGuildId: false,
        }),
        makeDiscordRoleBinding("roles-agent", { roles: ["r1"] }),
      ],
      memberRoleIds: ["r1"],
      peerId: "thread-1",
      parentPeerId: "parent-1",
      expectedAgentId: "parent-agent",
      expectedMatchedBy: "binding.peer.parent",
    },
    {
      name: "no memberRoleIds means guild+roles doesn't match",
      bindings: [makeDiscordRoleBinding("opus", { roles: ["r1"] })],
      expectedAgentId: "main",
      expectedMatchedBy: "default",
    },
    {
      name: "first matching binding wins with multiple role bindings",
      bindings: [
        makeDiscordRoleBinding("opus", { roles: ["r1"] }),
        makeDiscordRoleBinding("sonnet", { roles: ["r2"] }),
      ],
      memberRoleIds: ["r1", "r2"],
      expectedAgentId: "opus",
      expectedMatchedBy: "binding.guild+roles",
    },
    {
      name: "empty roles array treated as no role restriction",
      bindings: [makeDiscordRoleBinding("opus", { roles: [] })],
      memberRoleIds: ["r1"],
      expectedAgentId: "opus",
      expectedMatchedBy: "binding.guild",
    },
    {
      name: "guild+roles binding does not match as guild-only when roles do not match",
      bindings: [makeDiscordRoleBinding("opus", { roles: ["admin"] })],
      memberRoleIds: ["regular"],
      expectedAgentId: "main",
      expectedMatchedBy: "default",
    },
    {
      name: "peer+guild+roles binding does not act as guild+roles fallback when peer mismatches",
      bindings: [
        makeDiscordRoleBinding("peer-roles", { peerId: "c-target", roles: ["r1"] }),
        makeDiscordRoleBinding("guild-roles", { roles: ["r1"] }),
      ],
      memberRoleIds: ["r1"],
      peerId: "c-other",
      expectedAgentId: "guild-roles",
      expectedMatchedBy: "binding.guild+roles",
    },
  ] as const)("$name", (testCase) => {
    expectDiscordRoleRoute(testCase);
  });
});

describe("wildcard peer bindings (peer.id=*)", () => {
  test("peer.id=* matches any direct peer and routes to the bound agent", () => {
    const cfg: OpenClawConfig = {
      agents: { list: [{ id: "second-ana" }] },
      bindings: [
        {
          agentId: "second-ana",
          match: {
            channel: "telegram",
            accountId: "second-ana",
            peer: { kind: "direct", id: "*" },
          },
        },
      ],
    };
    const route = resolveAgentRoute({
      cfg,
      channel: "telegram",
      accountId: "second-ana",
      peer: { kind: "direct", id: "12345678" },
    });
    expect(route.agentId).toBe("second-ana");
    expect(route.sessionKey).toContain("agent:second-ana:");
    expect(route.matchedBy).toBe("binding.peer.wildcard");
  });

  test("peer.id=* does not match group peers when kind is direct", () => {
    const cfg: OpenClawConfig = {
      agents: { list: [{ id: "main", default: true }, { id: "dm-only" }] },
      bindings: [
        {
          agentId: "dm-only",
          match: {
            channel: "telegram",
            accountId: "bot1",
            peer: { kind: "direct", id: "*" },
          },
        },
      ],
    };
    const route = resolveAgentRoute({
      cfg,
      channel: "telegram",
      accountId: "bot1",
      peer: { kind: "group", id: "group-999" },
    });
    expect(route.agentId).toBe("main");
    expect(route.matchedBy).toBe("default");
  });

  test("exact peer binding wins over wildcard peer binding", () => {
    const cfg: OpenClawConfig = {
      agents: { list: [{ id: "exact" }, { id: "wild" }] },
      bindings: [
        {
          agentId: "wild",
          match: {
            channel: "whatsapp",
            accountId: "biz",
            peer: { kind: "direct", id: "*" },
          },
        },
        {
          agentId: "exact",
          match: {
            channel: "whatsapp",
            accountId: "biz",
            peer: { kind: "direct", id: "+1000" },
          },
        },
      ],
    };
    const route = resolveAgentRoute({
      cfg,
      channel: "whatsapp",
      accountId: "biz",
      peer: { kind: "direct", id: "+1000" },
    });
    expect(route.agentId).toBe("exact");
    expect(route.matchedBy).toBe("binding.peer");
  });

  test("wildcard peer binding wins over default fallback for unmatched peers", () => {
    const cfg: OpenClawConfig = {
      agents: { list: [{ id: "exact" }, { id: "wild" }] },
      bindings: [
        {
          agentId: "wild",
          match: {
            channel: "whatsapp",
            accountId: "biz",
            peer: { kind: "direct", id: "*" },
          },
        },
        {
          agentId: "exact",
          match: {
            channel: "whatsapp",
            accountId: "biz",
            peer: { kind: "direct", id: "+1000" },
          },
        },
      ],
    };
    const route = resolveAgentRoute({
      cfg,
      channel: "whatsapp",
      accountId: "biz",
      peer: { kind: "direct", id: "+9999" },
    });
    expect(route.agentId).toBe("wild");
    expect(route.matchedBy).toBe("binding.peer.wildcard");
  });

  test("group wildcard peer matches any group peer", () => {
    const cfg: OpenClawConfig = {
      agents: { list: [{ id: "grp" }] },
      bindings: [
        {
          agentId: "grp",
          match: {
            channel: "discord",
            accountId: "default",
            peer: { kind: "group", id: "*" },
          },
        },
      ],
    };
    const route = resolveAgentRoute({
      cfg,
      channel: "discord",
      accountId: "default",
      peer: { kind: "group", id: "g-42" },
    });
    expect(route.agentId).toBe("grp");
    expect(route.matchedBy).toBe("binding.peer.wildcard");
  });
});

describe("binding evaluation cache scalability", () => {
  test("does not rescan full bindings across distinct channel/account cache entries (#36915)", () => {
    const cacheKeyCount = 64;
    const cfg: OpenClawConfig = {
      bindings: [
        {
          agentId: "agent-0",
          match: {
            channel: "dingtalk",
            accountId: "acct-0",
            peer: { kind: "direct", id: "user-0" },
          },
        },
      ],
    };
    const listBindingsSpy = vi.spyOn(routingBindings, "listBindings");
    try {
      const boundRoute = resolveAgentRoute({
        cfg,
        channel: "dingtalk",
        accountId: "acct-0",
        peer: { kind: "direct", id: "user-0" },
      });
      expect(boundRoute.agentId).toBe("agent-0");
      expect(boundRoute.matchedBy).toBe("binding.peer");

      for (let idx = 1; idx < cacheKeyCount; idx += 1) {
        const route = resolveAgentRoute({
          cfg,
          channel: "dingtalk",
          accountId: `acct-${idx}`,
          peer: { kind: "direct", id: `user-${idx}` },
        });
        expect(route.agentId).toBe("main");
        expect(route.matchedBy).toBe("default");
      }

      const repeated = resolveAgentRoute({
        cfg,
        channel: "dingtalk",
        accountId: "acct-0",
        peer: { kind: "direct", id: "user-0" },
      });
      expect(repeated.agentId).toBe("agent-0");
      expect(listBindingsSpy).toHaveBeenCalledTimes(1);
    } finally {
      listBindingsSpy.mockRestore();
    }
  });

  test("uses indexed channel/account bindings without per-route scans", () => {
    const bindingCount = 101;
    const cfg: OpenClawConfig = {
      bindings: Array.from({ length: bindingCount }, (_, idx) => ({
        agentId: `agent-${idx}`,
        match: {
          channel: "dingtalk",
          accountId: `acct-${idx}`,
          peer: { kind: "direct", id: `user-${idx}` },
        },
      })),
    };

    const route = resolveAgentRoute({
      cfg,
      channel: "dingtalk",
      accountId: "acct-100",
      peer: { kind: "direct", id: "user-100" },
    });
    expect(route.agentId).toBe("agent-100");
    expect(route.matchedBy).toBe("binding.peer");

    const defaultRoute = resolveAgentRoute({
      cfg,
      channel: "dingtalk",
      accountId: "acct-missing",
      peer: { kind: "direct", id: "user-missing" },
    });
    expect(defaultRoute.agentId).toBe("main");
    expect(defaultRoute.matchedBy).toBe("default");
  });
});
