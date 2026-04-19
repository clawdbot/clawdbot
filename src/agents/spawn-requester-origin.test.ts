import { describe, expect, it } from "vitest";
import type { AgentBindingMatch } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRequesterOriginForChild } from "./spawn-requester-origin.js";

describe("resolveRequesterOriginForChild", () => {
  function routeBinding(match: AgentBindingMatch) {
    return { type: "route" as const, agentId: "bot-alpha", match };
  }

  function resolveAccount(params: {
    cfg: OpenClawConfig;
    targetAgentId?: string;
    requesterAgentId?: string;
    requesterChannel: string;
    requesterAccountId?: string;
    requesterTo: string;
    requesterGroupSpace?: string | null;
    requesterMemberRoleIds?: string[];
  }) {
    return resolveRequesterOriginForChild({
      requesterAccountId: "bot-beta",
      ...params,
      targetAgentId: params.targetAgentId ?? "bot-alpha",
      requesterAgentId: params.requesterAgentId ?? "main",
    })?.accountId;
  }

  it.each([
    ["channel:conversation-a", "channel:conversation-a", "channel"],
    ["dm:conversation-a", "dm:conversation-a", "direct"],
    ["thread:conversation-a/thread-a", "thread:conversation-a/thread-a", "channel"],
  ] as const)(
    "keeps canonical prefixed peer id %s eligible for exact binding lookup",
    (to, peerId, peerKind) => {
      const cfg = {
        bindings: [
          routeBinding({
            channel: "qa-channel",
            peer: {
              kind: peerKind,
              id: peerId,
            },
            accountId: "bot-alpha-qa",
          }),
        ],
      } as OpenClawConfig;

      expect(
        resolveRequesterOriginForChild({
          cfg,
          targetAgentId: "bot-alpha",
          requesterAgentId: "main",
          requesterChannel: "qa-channel",
          requesterAccountId: "bot-beta",
          requesterTo: to,
        }),
      ).toMatchObject({
        channel: "qa-channel",
        accountId: "bot-alpha-qa",
        to,
      });
    },
  );

  it.each([
    {
      name: "prefers peer-specific binding over channel-only binding",
      requesterChannel: "matrix",
      requesterTo: "!roomA:example.org",
      expected: "bot-alpha-room-a",
      bindings: [
        routeBinding({ channel: "matrix", accountId: "bot-alpha-default" }),
        routeBinding({
          channel: "matrix",
          peer: { kind: "channel", id: "!roomA:example.org" },
          accountId: "bot-alpha-room-a",
        }),
      ],
    },
    {
      name: "falls back to channel-only binding when peer does not match",
      requesterChannel: "matrix",
      requesterTo: "!roomB:example.org",
      expected: "bot-alpha-default",
      bindings: [
        routeBinding({ channel: "matrix", accountId: "bot-alpha-default" }),
        routeBinding({
          channel: "matrix",
          peer: { kind: "channel", id: "!roomA:example.org" },
          accountId: "bot-alpha-room-a",
        }),
      ],
    },
    {
      name: "treats wildcard peer binding as match-any and beats channel-only",
      requesterChannel: "matrix",
      requesterTo: "!anyRoom:example.org",
      expected: "bot-alpha-wildcard",
      bindings: [
        routeBinding({ channel: "matrix", accountId: "bot-alpha-default" }),
        routeBinding({
          channel: "matrix",
          peer: { kind: "channel", id: "*" },
          accountId: "bot-alpha-wildcard",
        }),
      ],
    },
    {
      name: "prefers exact peer binding over wildcard peer binding",
      requesterChannel: "matrix",
      requesterTo: "!roomA:example.org",
      expected: "bot-alpha-room-a",
      bindings: [
        routeBinding({
          channel: "matrix",
          peer: { kind: "channel", id: "*" },
          accountId: "bot-alpha-wildcard",
        }),
        routeBinding({
          channel: "matrix",
          peer: { kind: "channel", id: "!roomA:example.org" },
          accountId: "bot-alpha-room-a",
        }),
      ],
    },
    {
      name: "uses requester roles for role-scoped target-agent accounts",
      requesterChannel: "discord",
      requesterTo: "channel:ops",
      requesterGroupSpace: "guild-current",
      requesterMemberRoleIds: ["admin"],
      expected: "bot-alpha-admin",
      bindings: [
        routeBinding({ channel: "discord", accountId: "bot-alpha-default" }),
        routeBinding({
          channel: "discord",
          guildId: "guild-current",
          roles: ["admin"],
          peer: { kind: "channel", id: "channel:ops" },
          accountId: "bot-alpha-admin",
        }),
      ],
    },
    {
      name: "strips channel-side prefixes before bound-account lookup",
      requesterChannel: "matrix",
      requesterTo: "room:!exampleRoomId:example.org",
      expected: "bot-alpha",
      bindings: [
        routeBinding({
          channel: "matrix",
          peer: { kind: "channel", id: "!exampleRoomId:example.org" },
          accountId: "bot-alpha",
        }),
      ],
    },
    {
      name: "classifies Matrix room:@user targets as direct, not channel",
      requesterChannel: "matrix",
      requesterTo: "room:@other-user:example.org",
      expected: "bot-alpha-dm",
      bindings: [
        routeBinding({
          channel: "matrix",
          peer: { kind: "channel", id: "@other-user:example.org" },
          accountId: "bot-alpha-wrong-kind",
        }),
        routeBinding({
          channel: "matrix",
          peer: { kind: "direct", id: "@other-user:example.org" },
          accountId: "bot-alpha-dm",
        }),
      ],
    },
    {
      name: "preserves the caller account for same-agent subagent spawns",
      requesterChannel: "matrix",
      requesterAccountId: "bot-alpha-adhoc",
      requesterAgentId: "bot-alpha",
      requesterTo: "!someRoom:example.org",
      expected: "bot-alpha-adhoc",
      bindings: [routeBinding({ channel: "matrix", accountId: "bot-alpha-default" })],
    },
  ] as const)("selects target account: $name", (scenario) => {
    expect(
      resolveAccount({
        cfg: { bindings: [...scenario.bindings] } as OpenClawConfig,
        requesterChannel: scenario.requesterChannel,
        requesterAccountId: scenario.requesterAccountId,
        requesterAgentId: scenario.requesterAgentId,
        requesterTo: scenario.requesterTo,
        requesterGroupSpace: scenario.requesterGroupSpace,
        requesterMemberRoleIds: scenario.requesterMemberRoleIds
          ? [...scenario.requesterMemberRoleIds]
          : undefined,
      }),
    ).toBe(scenario.expected);
  });

  it("preserves canonical peer ids that start with token-colon after a known wrapper", () => {
    const to = "conversation:a:1:team-thread";
    const cfg = {
      bindings: [
        routeBinding({
          channel: "msteams",
          peer: {
            kind: "channel",
            id: "a:1:team-thread",
          },
          accountId: "bot-alpha-teams",
        }),
      ],
    } as OpenClawConfig;

    expect(
      resolveRequesterOriginForChild({
        cfg,
        targetAgentId: "bot-alpha",
        requesterAgentId: "main",
        requesterChannel: "msteams",
        requesterAccountId: "bot-beta",
        requesterTo: to,
      }),
    ).toMatchObject({
      channel: "msteams",
      accountId: "bot-alpha-teams",
      to,
    });
  });

  it("keeps explicit channel prefixes ahead of ids that start with direct marker characters", () => {
    const to = "channel:@ops";
    const cfg = {
      bindings: [
        routeBinding({
          channel: "qa-channel",
          peer: {
            kind: "channel",
            id: to,
          },
          accountId: "bot-alpha-qa",
        }),
      ],
    } as OpenClawConfig;

    expect(
      resolveRequesterOriginForChild({
        cfg,
        targetAgentId: "bot-alpha",
        requesterAgentId: "main",
        requesterChannel: "qa-channel",
        requesterAccountId: "bot-beta",
        requesterTo: to,
      }),
    ).toMatchObject({
      channel: "qa-channel",
      accountId: "bot-alpha-qa",
      to,
    });
  });

  it("uses requester group space before selecting a scoped target-agent account", () => {
    const to = "channel:ops";
    const cfg = {
      bindings: [
        routeBinding({
          channel: "discord",
          guildId: "guild-other",
          peer: {
            kind: "channel",
            id: to,
          },
          accountId: "bot-alpha-other-guild",
        }),
        routeBinding({
          channel: "discord",
          guildId: "guild-current",
          peer: {
            kind: "channel",
            id: to,
          },
          accountId: "bot-alpha-current-guild",
        }),
      ],
    } as OpenClawConfig;

    expect(
      resolveRequesterOriginForChild({
        cfg,
        targetAgentId: "bot-alpha",
        requesterAgentId: "main",
        requesterChannel: "discord",
        requesterAccountId: "main-current-guild",
        requesterTo: to,
        requesterGroupSpace: "guild-current",
      }),
    ).toMatchObject({
      channel: "discord",
      accountId: "bot-alpha-current-guild",
      to,
    });
  });

  it("still peels channel id plus kind wrappers before peer lookup", () => {
    const to = "line:group:U123example";
    const cfg = {
      bindings: [
        routeBinding({
          channel: "line",
          peer: {
            kind: "group",
            id: "U123example",
          },
          accountId: "bot-alpha-line",
        }),
      ],
    } as OpenClawConfig;

    expect(
      resolveRequesterOriginForChild({
        cfg,
        targetAgentId: "bot-alpha",
        requesterAgentId: "main",
        requesterChannel: "line",
        requesterAccountId: "bot-beta",
        requesterTo: to,
      }),
    ).toMatchObject({
      channel: "line",
      accountId: "bot-alpha-line",
      to,
    });
  });
});
