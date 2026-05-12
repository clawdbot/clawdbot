import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { ensureOutboundSessionEntry, resolveOutboundSessionRoute } from "./outbound-session.js";
import { setMinimalOutboundSessionPluginRegistryForTests } from "./outbound-session.test-helpers.js";

type InboundMetadataParams = {
  sessionKey?: string;
  storePath?: string;
};

const mocks = vi.hoisted(() => ({
  recordSessionMetaFromInbound: vi.fn(async (_params: InboundMetadataParams) => ({ ok: true })),
  resolveStorePath: vi.fn(
    (_store: unknown, params?: { agentId?: string }) => `/stores/${params?.agentId ?? "main"}.json`,
  ),
}));

function firstMockArg(
  mock: { mock: { calls: readonly unknown[][] } },
  label: string,
): Record<string, unknown> {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  const [arg] = call;
  if (typeof arg !== "object" || arg === null || Array.isArray(arg)) {
    throw new Error(`expected ${label} params to be an object`);
  }
  return arg as Record<string, unknown>;
}

vi.mock("../../config/sessions/inbound.runtime.js", () => ({
  recordSessionMetaFromInbound: mocks.recordSessionMetaFromInbound,
  resolveStorePath: mocks.resolveStorePath,
}));

describe("resolveOutboundSessionRoute", () => {
  beforeEach(() => {
    mocks.recordSessionMetaFromInbound.mockClear();
    mocks.resolveStorePath.mockClear();
    setMinimalOutboundSessionPluginRegistryForTests();
  });

  const baseConfig = {} as OpenClawConfig;
  const perChannelPeerCfg = { session: { dmScope: "per-channel-peer" } } as OpenClawConfig;
  const identityLinksCfg = {
    session: {
      dmScope: "per-peer",
      identityLinks: {
        alice: ["guildchat:123"],
      },
    },
  } as OpenClawConfig;
  const workspaceMpimCfg = {
    channels: {
      workspace: {
        dm: {
          groupChannels: ["G123"],
        },
      },
    },
  } as OpenClawConfig;

  async function expectResolvedRoute(params: {
    cfg: OpenClawConfig;
    channel: string;
    target: string;
    replyToId?: string;
    threadId?: string;
    expected: {
      sessionKey: string;
      from?: string;
      to?: string;
      threadId?: string | number;
      chatType?: "channel" | "direct" | "group";
    };
  }) {
    const route = await resolveOutboundSessionRoute({
      cfg: params.cfg,
      channel: params.channel,
      agentId: "main",
      target: params.target,
      replyToId: params.replyToId,
      threadId: params.threadId,
    });
    expect(route?.sessionKey).toBe(params.expected.sessionKey);
    if (params.expected.from !== undefined) {
      expect(route?.from).toBe(params.expected.from);
    }
    if (params.expected.to !== undefined) {
      expect(route?.to).toBe(params.expected.to);
    }
    if (params.expected.threadId !== undefined) {
      expect(route?.threadId).toBe(params.expected.threadId);
    }
    if (params.expected.chatType !== undefined) {
      expect(route?.chatType).toBe(params.expected.chatType);
    }
  }

  type RouteCase = Parameters<typeof expectResolvedRoute>[0];
  type NamedRouteCase = RouteCase & { name: string };

  const perChannelPeerSessionCfg = { session: { dmScope: "per-channel-peer" } } as OpenClawConfig;

  it.each([
    {
      name: "MobileChat group jid",
      cfg: baseConfig,
      channel: "mobilechat",
      target: "120363040000000000@g.us",
      expected: {
        sessionKey: "agent:main:mobilechat:group:120363040000000000@g.us",
        from: "120363040000000000@g.us",
        to: "120363040000000000@g.us",
        chatType: "group",
      },
    },
    {
      name: "Matrix room target",
      cfg: baseConfig,
      channel: "matrix",
      target: "room:!ops:matrix.example",
      expected: {
        sessionKey: "agent:main:matrix:channel:!ops:matrix.example",
        from: "matrix:channel:!ops:matrix.example",
        to: "room:!ops:matrix.example",
        chatType: "channel",
      },
    },
    {
      name: "MeetingChat conversation target",
      cfg: baseConfig,
      channel: "meetingchat",
      target: "conversation:19:meeting_abc@thread.tacv2",
      expected: {
        sessionKey: "agent:main:meetingchat:channel:19:meeting_abc@thread.tacv2",
        from: "meetingchat:channel:19:meeting_abc@thread.tacv2",
        to: "conversation:19:meeting_abc@thread.tacv2",
        chatType: "channel",
      },
    },
    {
      name: "Workspace thread",
      cfg: baseConfig,
      channel: "workspace",
      target: "channel:C123",
      replyToId: "456",
      expected: {
        sessionKey: "agent:main:workspace:channel:c123:thread:456",
        from: "workspace:channel:C123",
        to: "channel:C123",
        threadId: "456",
      },
    },
    {
      name: "Forum topic group",
      cfg: baseConfig,
      channel: "forum",
      target: "-100123456:topic:42",
      expected: {
        sessionKey: "agent:main:forum:group:-100123456:topic:42",
        from: "forum:group:-100123456:topic:42",
        to: "forum:-100123456",
        threadId: 42,
      },
    },
    {
      name: "Forum DM with topic",
      cfg: perChannelPeerCfg,
      channel: "forum",
      target: "123456789:topic:99",
      expected: {
        sessionKey: "agent:main:forum:direct:123456789:thread:99",
        from: "forum:123456789:topic:99",
        to: "forum:123456789",
        threadId: 99,
        chatType: "direct",
      },
    },
    {
      name: "Forum unresolved username DM",
      cfg: perChannelPeerCfg,
      channel: "forum",
      target: "@alice",
      expected: {
        sessionKey: "agent:main:forum:direct:@alice",
        chatType: "direct",
      },
    },
    {
      name: "Forum DM scoped threadId fallback",
      cfg: perChannelPeerCfg,
      channel: "forum",
      target: "12345",
      threadId: "12345:99",
      expected: {
        sessionKey: "agent:main:forum:direct:12345:thread:99",
        from: "forum:12345:topic:99",
        to: "forum:12345",
        threadId: 99,
        chatType: "direct",
      },
    },
    {
      name: "identity-links per-peer",
      cfg: identityLinksCfg,
      channel: "guildchat",
      target: "user:123",
      expected: {
        sessionKey: "agent:main:direct:alice",
      },
    },
    {
      name: "Nextcloud Talk room target",
      cfg: baseConfig,
      channel: "nextcloud-talk",
      target: "room:opsroom42",
      expected: {
        sessionKey: "agent:main:nextcloud-talk:group:opsroom42",
        from: "nextcloud-talk:room:opsroom42",
        to: "nextcloud-talk:opsroom42",
        chatType: "group",
      },
    },
    {
      name: "LocalChat chat_* prefix stripping",
      cfg: baseConfig,
      channel: "localchat",
      target: "chat_guid:ABC123",
      expected: {
        sessionKey: "agent:main:localchat:group:abc123",
        from: "group:ABC123",
      },
    },
    {
      name: "Zalo direct target",
      cfg: perChannelPeerCfg,
      channel: "zalo",
      target: "zl:123456",
      expected: {
        sessionKey: "agent:main:zalo:direct:123456",
        from: "zalo:123456",
        to: "zalo:123456",
        chatType: "direct",
      },
    },
    {
      name: "Zalo Personal DM target",
      cfg: perChannelPeerCfg,
      channel: "zalouser",
      target: "123456",
      expected: {
        sessionKey: "agent:main:zalouser:direct:123456",
        chatType: "direct",
      },
    },
    {
      name: "Nostr prefixed target",
      cfg: perChannelPeerCfg,
      channel: "nostr",
      target: "nostr:npub1example",
      expected: {
        sessionKey: "agent:main:nostr:direct:npub1example",
        from: "nostr:npub1example",
        to: "nostr:npub1example",
        chatType: "direct",
      },
    },
    {
      name: "Tlon group target",
      cfg: baseConfig,
      channel: "tlon",
      target: "group:~zod/main",
      expected: {
        sessionKey: "agent:main:tlon:group:chat/~zod/main",
        from: "tlon:group:chat/~zod/main",
        to: "tlon:chat/~zod/main",
        chatType: "group",
      },
    },
    {
      name: "Workspace group allowlist -> group key",
      cfg: workspaceMpimCfg,
      channel: "workspace",
      target: "channel:G123",
      expected: {
        sessionKey: "agent:main:workspace:group:g123",
        from: "workspace:group:G123",
      },
    },
    {
      name: "CollabChat explicit group prefix keeps group routing",
      cfg: baseConfig,
      channel: "collabchat",
      target: "group:oc_group_chat",
      expected: {
        sessionKey: "agent:main:collabchat:group:oc_group_chat",
        from: "collabchat:group:oc_group_chat",
        to: "oc_group_chat",
        chatType: "group",
      },
    },
    {
      name: "CollabChat explicit dm prefix keeps direct routing",
      cfg: perChannelPeerCfg,
      channel: "collabchat",
      target: "dm:oc_dm_chat",
      expected: {
        sessionKey: "agent:main:collabchat:direct:oc_dm_chat",
        from: "collabchat:oc_dm_chat",
        to: "oc_dm_chat",
        chatType: "direct",
      },
    },
    {
      name: "CollabChat bare oc_ target defaults to direct routing",
      cfg: perChannelPeerCfg,
      channel: "collabchat",
      target: "oc_ambiguous_chat",
      expected: {
        sessionKey: "agent:main:collabchat:direct:oc_ambiguous_chat",
        from: "collabchat:oc_ambiguous_chat",
        to: "oc_ambiguous_chat",
        chatType: "direct",
      },
    },
    {
      name: "Workspace user DM target",
      cfg: perChannelPeerCfg,
      channel: "workspace",
      target: "user:U12345ABC",
      expected: {
        sessionKey: "agent:main:workspace:direct:u12345abc",
        from: "workspace:U12345ABC",
        to: "user:U12345ABC",
        chatType: "direct",
      },
    },
    {
      name: "Workspace channel target without thread",
      cfg: baseConfig,
      channel: "workspace",
      target: "channel:C999XYZ",
      expected: {
        sessionKey: "agent:main:workspace:channel:c999xyz",
        from: "workspace:channel:C999XYZ",
        to: "channel:C999XYZ",
        chatType: "channel",
      },
    },
  ] satisfies NamedRouteCase[])("$name", async ({ name: _name, ...params }) => {
    await expectResolvedRoute(params);
  });

  it.each([
    {
      name: "uses resolved GuildChat user targets to route bare numeric ids as DMs",
      target: "123",
      resolvedTarget: {
        to: "user:123",
        kind: "user" as const,
        source: "directory" as const,
      },
      expected: {
        sessionKey: "agent:main:guildchat:direct:123",
        from: "guildchat:123",
        to: "user:123",
        chatType: "direct",
      },
    },
    {
      name: "uses resolved GuildChat channel targets to route bare numeric ids as channels without thread suffixes",
      target: "456",
      threadId: "789",
      resolvedTarget: {
        to: "channel:456",
        kind: "channel" as const,
        source: "directory" as const,
      },
      expected: {
        sessionKey: "agent:main:guildchat:channel:456",
        baseSessionKey: "agent:main:guildchat:channel:456",
        from: "guildchat:channel:456",
        to: "channel:456",
        chatType: "channel",
        threadId: "789",
      },
    },
    {
      name: "uses resolved BoardChat user targets to route bare ids as DMs",
      target: "dthcxgoxhifn3pwh65cut3ud3w",
      channel: "boardchat",
      resolvedTarget: {
        to: "user:dthcxgoxhifn3pwh65cut3ud3w",
        kind: "user" as const,
        source: "directory" as const,
      },
      expected: {
        sessionKey: "agent:main:boardchat:direct:dthcxgoxhifn3pwh65cut3ud3w",
        from: "boardchat:dthcxgoxhifn3pwh65cut3ud3w",
        to: "user:dthcxgoxhifn3pwh65cut3ud3w",
        chatType: "direct",
      },
    },
  ])("$name", async ({ channel = "guildchat", target, threadId, resolvedTarget, expected }) => {
    const route = await resolveOutboundSessionRoute({
      cfg: perChannelPeerSessionCfg,
      channel,
      agentId: "main",
      target,
      threadId,
      resolvedTarget,
    });

    for (const [key, value] of Object.entries(expected)) {
      expect((route as Record<string, unknown>)[key]).toEqual(value);
    }
  });

  it("rejects bare numeric GuildChat targets when the caller has no kind hint", async () => {
    await expect(
      resolveOutboundSessionRoute({
        cfg: perChannelPeerSessionCfg,
        channel: "guildchat",
        agentId: "main",
        target: "123",
      }),
    ).rejects.toThrow(/Ambiguous Guild Chat recipient/);
  });
});

describe("ensureOutboundSessionEntry", () => {
  beforeEach(() => {
    mocks.recordSessionMetaFromInbound.mockClear();
    mocks.resolveStorePath.mockClear();
  });

  it("persists metadata in the owning session store for the route session key", async () => {
    await ensureOutboundSessionEntry({
      cfg: {
        session: {
          store: "/stores/{agentId}.json",
        },
      } as OpenClawConfig,
      channel: "workspace",
      route: {
        sessionKey: "agent:main:workspace:channel:c1",
        baseSessionKey: "agent:work:workspace:channel:resolved",
        peer: { kind: "channel", id: "c1" },
        chatType: "channel",
        from: "workspace:channel:C1",
        to: "channel:C1",
      },
    });

    expect(mocks.resolveStorePath).toHaveBeenCalledWith("/stores/{agentId}.json", {
      agentId: "main",
    });
    expect(mocks.recordSessionMetaFromInbound).toHaveBeenCalledOnce();
    const metadata = firstMockArg(
      mocks.recordSessionMetaFromInbound,
      "recordSessionMetaFromInbound",
    );
    expect(metadata.storePath).toBe("/stores/main.json");
    expect(metadata.sessionKey).toBe("agent:main:workspace:channel:c1");
  });
});
