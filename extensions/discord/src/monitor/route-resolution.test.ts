import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { describe, expect, it } from "vitest";
import {
  buildDiscordRoutePeer,
  resolveDiscordBoundConversationRoute,
  resolveDiscordConversationRoute,
  resolveDiscordEffectiveRoute,
} from "./route-resolution.js";

function buildWorkerBindingConfig(peer: {
  kind: "channel" | "direct";
  id: string;
}): OpenClawConfig {
  return {
    agents: {
      list: [{ id: "worker" }],
    },
    bindings: [
      {
        agentId: "worker",
        match: {
          channel: "discord",
          accountId: "default",
          peer,
        },
      },
    ],
  };
}

describe("discord route resolution helpers", () => {
  it("builds a direct peer from DM metadata", () => {
    expect(
      buildDiscordRoutePeer({
        isDirectMessage: true,
        isGroupDm: false,
        directUserId: "user-1",
        conversationId: "channel-1",
      }),
    ).toEqual({
      kind: "direct",
      id: "user-1",
    });
  });

  it("resolves bound session keys on top of the routed session", () => {
    const route: ResolvedAgentRoute = {
      agentId: "main",
      channel: "discord",
      accountId: "default",
      sessionKey: "agent:main:discord:channel:c1",
      mainSessionKey: "agent:main:main",
      lastRoutePolicy: "session",
      matchedBy: "default",
    };

    expect(
      resolveDiscordEffectiveRoute({
        route,
        boundSessionKey: "agent:worker:discord:channel:c1",
        matchedBy: "binding.channel",
      }),
    ).toEqual({
      ...route,
      agentId: "worker",
      sessionKey: "agent:worker:discord:channel:c1",
      matchedBy: "binding.channel",
    });
  });

  it("falls back to configured route when no bound session exists", () => {
    const route: ResolvedAgentRoute = {
      agentId: "main",
      channel: "discord",
      accountId: "default",
      sessionKey: "agent:main:discord:channel:c1",
      mainSessionKey: "agent:main:main",
      lastRoutePolicy: "session",
      matchedBy: "default",
    };
    const configuredRoute = {
      route: {
        ...route,
        agentId: "worker",
        sessionKey: "agent:worker:discord:channel:c1",
        mainSessionKey: "agent:worker:main",
        lastRoutePolicy: "session" as const,
        matchedBy: "binding.peer" as const,
      },
    };

    expect(
      resolveDiscordEffectiveRoute({
        route,
        configuredRoute,
      }),
    ).toEqual(configuredRoute.route);
  });

  it("resolves the same route shape as the inline Discord route inputs", () => {
    const cfg = buildWorkerBindingConfig({ kind: "channel", id: "c1" });

    expect(
      resolveDiscordConversationRoute({
        cfg,
        accountId: "default",
        guildId: "g1",
        memberRoleIds: [],
        peer: { kind: "channel", id: "c1" },
      }),
    ).toMatchObject({
      agentId: "worker",
      sessionKey: "agent:worker:discord:channel:c1",
      matchedBy: "binding.peer",
    });
  });

  it("composes route building with effective-route overrides", () => {
    const cfg = buildWorkerBindingConfig({ kind: "direct", id: "user-1" });

    expect(
      resolveDiscordBoundConversationRoute({
        cfg,
        accountId: "default",
        isDirectMessage: true,
        isGroupDm: false,
        directUserId: "user-1",
        conversationId: "dm-1",
        boundSessionKey: "agent:worker:discord:direct:user-1",
        matchedBy: "binding.channel",
      }),
    ).toMatchObject({
      agentId: "worker",
      sessionKey: "agent:worker:discord:direct:user-1",
      matchedBy: "binding.channel",
    });
  });
});
