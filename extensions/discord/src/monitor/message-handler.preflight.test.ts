import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelType, MessageType } from "../internal/discord.js";
import { createPartialDiscordChannelWithThrowingGetters } from "../test-support/partial-channel.js";

const transcribeFirstAudioMock = vi.hoisted(() => vi.fn());
const fetchPluralKitMessageInfoMock = vi.hoisted(() => vi.fn());
const resolveDiscordDmCommandAccessMock = vi.hoisted(() => vi.fn());
const handleDiscordDmCommandDecisionMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../pluralkit.js", () => ({
  fetchPluralKitMessageInfo: (...args: unknown[]) => fetchPluralKitMessageInfoMock(...args),
}));
vi.mock("./preflight-audio.runtime.js", () => ({
  transcribeFirstAudio: transcribeFirstAudioMock,
}));
vi.mock("./dm-command-auth.js", () => ({
  resolveDiscordDmCommandAccess: resolveDiscordDmCommandAccessMock,
}));
vi.mock("./dm-command-decision.js", () => ({
  handleDiscordDmCommandDecision: handleDiscordDmCommandDecisionMock,
}));
import {
  __testing as sessionBindingTesting,
  registerSessionBindingAdapter,
} from "openclaw/plugin-sdk/conversation-runtime";
import {
  createDiscordMessage,
  createDiscordPreflightArgs,
  createGuildEvent,
  createGuildTextClient,
  DEFAULT_PREFLIGHT_CFG,
  type DiscordClient,
  type DiscordConfig,
  type DiscordMessageEvent,
} from "./message-handler.preflight.test-helpers.js";
let preflightDiscordMessage: typeof import("./message-handler.preflight.js").preflightDiscordMessage;
let resolvePreflightMentionRequirement: typeof import("./message-handler.preflight.js").resolvePreflightMentionRequirement;
let shouldIgnoreBoundThreadWebhookMessage: typeof import("./message-handler.preflight.js").shouldIgnoreBoundThreadWebhookMessage;
let threadBindingTesting: typeof import("./thread-bindings.js").__testing;
let createThreadBindingManager: typeof import("./thread-bindings.js").createThreadBindingManager;

beforeAll(async () => {
  ({
    preflightDiscordMessage,
    resolvePreflightMentionRequirement,
    shouldIgnoreBoundThreadWebhookMessage,
  } = await import("./message-handler.preflight.js"));
  ({ __testing: threadBindingTesting, createThreadBindingManager } =
    await import("./thread-bindings.js"));
});

beforeEach(() => {
  fetchPluralKitMessageInfoMock.mockReset();
});

function createThreadBinding(
  overrides?: Partial<import("openclaw/plugin-sdk/conversation-runtime").SessionBindingRecord>,
) {
  return {
    bindingId: "default:thread-1",
    targetSessionKey: "agent:main:subagent:child-1",
    targetKind: "subagent",
    conversation: {
      channel: "discord",
      accountId: "default",
      conversationId: "thread-1",
      parentConversationId: "parent-1",
    },
    status: "active",
    boundAt: 1,
    metadata: {
      agentId: "main",
      boundBy: "test",
      webhookId: "wh-1",
      webhookToken: "tok-1",
    },
    ...overrides,
  } satisfies import("openclaw/plugin-sdk/conversation-runtime").SessionBindingRecord;
}

function createPreflightArgs(params: {
  cfg: import("openclaw/plugin-sdk/config-types").OpenClawConfig;
  discordConfig: DiscordConfig;
  data: DiscordMessageEvent;
  client: DiscordClient;
}): Parameters<typeof preflightDiscordMessage>[0] {
  return createDiscordPreflightArgs(params);
}

function createThreadClient(params: { threadId: string; parentId: string }): DiscordClient {
  return {
    fetchChannel: async (channelId: string) => {
      if (channelId === params.threadId) {
        return {
          id: params.threadId,
          type: ChannelType.PublicThread,
          name: "focus",
          parentId: params.parentId,
          ownerId: "owner-1",
        };
      }
      if (channelId === params.parentId) {
        return {
          id: params.parentId,
          type: ChannelType.GuildText,
          name: "general",
        };
      }
      return null;
    },
  } as unknown as DiscordClient;
}

function createDmClient(channelId: string): DiscordClient {
  return {
    fetchChannel: async (id: string) => {
      if (id === channelId) {
        return {
          id: channelId,
          type: ChannelType.DM,
        };
      }
      return null;
    },
  } as unknown as DiscordClient;
}

function createMissingChannelClient(): DiscordClient {
  return {
    fetchChannel: async () => null,
  } as unknown as DiscordClient;
}

async function runThreadBoundPreflight(params: {
  threadId: string;
  parentId: string;
  message: import("../internal/discord.js").Message;
  threadBinding: import("openclaw/plugin-sdk/conversation-runtime").SessionBindingRecord;
  discordConfig: DiscordConfig;
  registerBindingAdapter?: boolean;
}) {
  if (params.registerBindingAdapter) {
    registerSessionBindingAdapter({
      channel: "discord",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: (ref) =>
        ref.conversationId === params.threadId ? params.threadBinding : null,
    });
  }

  const client = createThreadClient({
    threadId: params.threadId,
    parentId: params.parentId,
  });

  return preflightDiscordMessage({
    ...createPreflightArgs({
      cfg: DEFAULT_PREFLIGHT_CFG,
      discordConfig: params.discordConfig,
      data: createGuildEvent({
        channelId: params.threadId,
        guildId: "guild-1",
        author: params.message.author,
        message: params.message,
      }),
      client,
    }),
    threadBindings: {
      getByThreadId: (id: string) => (id === params.threadId ? params.threadBinding : undefined),
    } as import("./thread-bindings.js").ThreadBindingManager,
  });
}

async function runGuildPreflight(params: {
  channelId: string;
  guildId: string;
  message: import("../internal/discord.js").Message;
  discordConfig: DiscordConfig;
  cfg?: import("openclaw/plugin-sdk/config-types").OpenClawConfig;
  guildEntries?: Parameters<typeof preflightDiscordMessage>[0]["guildEntries"];
  includeGuildObject?: boolean;
}) {
  return preflightDiscordMessage({
    ...createPreflightArgs({
      cfg: params.cfg ?? DEFAULT_PREFLIGHT_CFG,
      discordConfig: params.discordConfig,
      data: createGuildEvent({
        channelId: params.channelId,
        guildId: params.guildId,
        author: params.message.author,
        message: params.message,
        includeGuildObject: params.includeGuildObject,
      }),
      client: createGuildTextClient(params.channelId),
    }),
    guildEntries: params.guildEntries,
  });
}

async function runDmPreflight(params: {
  channelId: string;
  message: import("../internal/discord.js").Message;
  discordConfig: DiscordConfig;
}) {
  return preflightDiscordMessage({
    ...createPreflightArgs({
      cfg: DEFAULT_PREFLIGHT_CFG,
      discordConfig: params.discordConfig,
      data: {
        channel_id: params.channelId,
        author: params.message.author,
        message: params.message,
      } as DiscordMessageEvent,
      client: createDmClient(params.channelId),
    }),
  });
}

async function runUnresolvedDmPreflight(params: {
  cfg?: import("openclaw/plugin-sdk/config-types").OpenClawConfig;
  channelId: string;
  message: import("../internal/discord.js").Message;
  discordConfig: DiscordConfig;
}) {
  return preflightDiscordMessage({
    ...createPreflightArgs({
      cfg: params.cfg ?? DEFAULT_PREFLIGHT_CFG,
      discordConfig: params.discordConfig,
      data: {
        channel_id: params.channelId,
        author: params.message.author,
        message: params.message,
      } as DiscordMessageEvent,
      client: createMissingChannelClient(),
    }),
  });
}

async function runMentionOnlyBotPreflight(params: {
  channelId: string;
  guildId: string;
  message: import("../internal/discord.js").Message;
}) {
  return runGuildPreflight({
    channelId: params.channelId,
    guildId: params.guildId,
    message: params.message,
    discordConfig: {
      allowBots: "mentions",
    } as DiscordConfig,
  });
}

async function runIgnoreOtherMentionsPreflight(params: {
  channelId: string;
  guildId: string;
  message: import("../internal/discord.js").Message;
}) {
  return runGuildPreflight({
    channelId: params.channelId,
    guildId: params.guildId,
    message: params.message,
    discordConfig: {} as DiscordConfig,
    guildEntries: {
      [params.guildId]: {
        requireMention: false,
        ignoreOtherMentions: true,
      },
    },
  });
}

describe("resolvePreflightMentionRequirement", () => {
  it("requires mention when config requires mention and thread is not bound", () => {
    expect(
      resolvePreflightMentionRequirement({
        shouldRequireMention: true,
        bypassMentionRequirement: false,
      }),
    ).toBe(true);
  });

  it("disables mention requirement when the route explicitly bypasses mentions", () => {
    expect(
      resolvePreflightMentionRequirement({
        shouldRequireMention: true,
        bypassMentionRequirement: true,
      }),
    ).toBe(false);
  });

  it("keeps mention requirement disabled when config already disables it", () => {
    expect(
      resolvePreflightMentionRequirement({
        shouldRequireMention: false,
        bypassMentionRequirement: false,
      }),
    ).toBe(false);
  });
});

describe("preflightDiscordMessage", () => {
  beforeEach(() => {
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    transcribeFirstAudioMock.mockReset();
    resolveDiscordDmCommandAccessMock.mockReset();
    resolveDiscordDmCommandAccessMock.mockResolvedValue({
      commandAuthorized: true,
      decision: "allow",
      allowMatch: { allowed: true, matchedBy: "allowFrom", value: "123" },
    });
    handleDiscordDmCommandDecisionMock.mockReset();
    handleDiscordDmCommandDecisionMock.mockResolvedValue(undefined);
  });

  it("drops bound-thread bot system messages to prevent ACP self-loop", async () => {
    const threadBinding = createThreadBinding({
      targetKind: "session",
      targetSessionKey: "agent:main:acp:discord-thread-1",
    });
    const threadId = "thread-system-1";
    const parentId = "channel-parent-1";
    const message = createDiscordMessage({
      id: "m-system-1",
      channelId: threadId,
      content:
        "⚙️ codex-acp session active (auto-unfocus in 24h). Messages here go directly to this session.",
      author: {
        id: "relay-bot-1",
        bot: true,
        username: "OpenClaw",
      },
    });

    const result = await runThreadBoundPreflight({
      threadId,
      parentId,
      message,
      threadBinding,
      discordConfig: {
        allowBots: true,
      } as DiscordConfig,
    });

    expect(result).toBeNull();
  });

  it("restores direct-message bindings by user target instead of DM channel id", async () => {
    registerSessionBindingAdapter({
      channel: "discord",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: (ref) =>
        ref.conversationId === "user:user-1"
          ? createThreadBinding({
              conversation: {
                channel: "discord",
                accountId: "default",
                conversationId: "user:user-1",
              },
              metadata: {
                pluginBindingOwner: "plugin",
                pluginId: "openclaw-codex-app-server",
                pluginRoot: "/Users/huntharo/github/openclaw-app-server",
              },
            })
          : null,
    });

    const result = await runDmPreflight({
      channelId: "dm-channel-1",
      message: createDiscordMessage({
        id: "m-dm-1",
        channelId: "dm-channel-1",
        content: "who are you",
        author: {
          id: "user-1",
          bot: false,
          username: "alice",
        },
      }),
      discordConfig: {
        allowBots: true,
        dmPolicy: "open",
      } as DiscordConfig,
    });

    expect(result).not.toBeNull();
    expect(result?.threadBinding).toMatchObject({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "user:user-1",
      },
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "openclaw-codex-app-server",
      },
    });
  });

  it("ignores stale route-shaped channel bindings when config now routes to another agent", async () => {
    const channelId = "channel-stale-route";
    registerSessionBindingAdapter({
      channel: "discord",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: (ref) =>
        ref.conversationId === channelId
          ? createThreadBinding({
              bindingId: "default:channel-stale-route",
              targetKind: "session",
              targetSessionKey: `agent:oldagent:discord:channel:${channelId}`,
              conversation: {
                channel: "discord",
                accountId: "default",
                conversationId: channelId,
              },
              metadata: undefined,
            })
          : null,
    });

    const result = await runGuildPreflight({
      channelId,
      guildId: "guild-stale-route",
      message: createDiscordMessage({
        id: "m-stale-route",
        channelId,
        content: "which agent is this?",
        author: {
          id: "user-1",
          bot: false,
          username: "alice",
        },
      }),
      cfg: {
        agents: {
          list: [{ id: "newagent" }],
        },
        bindings: [
          {
            agentId: "newagent",
            match: {
              channel: "discord",
              accountId: "default",
              peer: { kind: "channel", id: channelId },
            },
          },
        ],
        channels: {
          discord: {},
        },
      },
      discordConfig: {
        allowBots: true,
      } as DiscordConfig,
      guildEntries: {
        "guild-stale-route": {
          channels: {
            [channelId]: {
              enabled: true,
              requireMention: false,
            },
          },
        },
      },
    });

    expect(result).not.toBeNull();
    expect(result?.route.agentId).toBe("newagent");
    expect(result?.route.sessionKey).toBe(`agent:newagent:discord:channel:${channelId}`);
    expect(result?.boundSessionKey).toBeUndefined();
    expect(result?.threadBinding).toBeUndefined();
  });

  it("preflights direct-message voice notes without mention gating", async () => {
    transcribeFirstAudioMock.mockResolvedValue("hello openclaw from dm audio");

    const result = await runDmPreflight({
      channelId: "dm-channel-audio-1",
      message: createDiscordMessage({
        id: "m-dm-audio-1",
        channelId: "dm-channel-audio-1",
        content: "",
        attachments: [
          {
            id: "att-dm-audio-1",
            url: "https://cdn.discordapp.com/attachments/voice.ogg",
            content_type: "audio/ogg",
            filename: "voice.ogg",
          },
        ],
        author: {
          id: "user-1",
          bot: false,
          username: "alice",
        },
      }),
      discordConfig: {
        dmPolicy: "open",
      } as DiscordConfig,
    });

    expect(transcribeFirstAudioMock).toHaveBeenCalledTimes(1);
    expect(transcribeFirstAudioMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          MediaUrls: ["https://cdn.discordapp.com/attachments/voice.ogg"],
          MediaTypes: ["audio/ogg"],
        }),
      }),
    );
    expect(result).not.toBeNull();
    expect(result?.isDirectMessage).toBe(true);
    expect(result?.preflightAudioTranscript).toBe("hello openclaw from dm audio");
  });

  it("keeps no-guild messages direct when channel lookup is unavailable", async () => {
    const result = await runUnresolvedDmPreflight({
      cfg: {
        ...DEFAULT_PREFLIGHT_CFG,
        session: {
          ...DEFAULT_PREFLIGHT_CFG.session,
          dmScope: "per-channel-peer",
        },
      },
      channelId: "dm-channel-unresolved-1",
      message: createDiscordMessage({
        id: "m-dm-unresolved-1",
        channelId: "dm-channel-unresolved-1",
        content: "hello from a degraded dm",
        author: {
          id: "user-1",
          bot: false,
          username: "alice",
        },
      }),
      discordConfig: {
        dmPolicy: "open",
      } as DiscordConfig,
    });

    expect(result).not.toBeNull();
    expect(result?.channelInfo).toBeNull();
    expect(result?.isDirectMessage).toBe(true);
    expect(result?.isGroupDm).toBe(false);
    expect(result?.route.sessionKey).toBe("agent:main:discord:direct:user-1");
  });

  it("falls back to the default discord account for omitted-account dm authorization", async () => {
    const message = createDiscordMessage({
      id: "m-dm-default-account",
      channelId: "dm-channel-default-account",
      content: "who are you",
      author: {
        id: "user-1",
        bot: false,
        username: "alice",
      },
    });

    await preflightDiscordMessage({
      ...createPreflightArgs({
        cfg: {
          ...DEFAULT_PREFLIGHT_CFG,
          channels: {
            discord: {
              defaultAccount: "work",
              accounts: {
                default: {
                  token: "token-default",
                },
                work: {
                  token: "token-work",
                },
              },
            },
          },
        },
        discordConfig: {
          defaultAccount: "work",
          dmPolicy: "allowlist",
        } as DiscordConfig,
        data: {
          channel_id: "dm-channel-default-account",
          author: message.author,
          message,
        } as DiscordMessageEvent,
        client: createDmClient("dm-channel-default-account"),
      }),
    });

    expect(resolveDiscordDmCommandAccessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
      }),
    );
  });

  it("keeps bound-thread regular bot messages flowing when allowBots=true", async () => {
    const threadBinding = createThreadBinding({
      targetKind: "session",
      targetSessionKey: "agent:main:acp:discord-thread-1",
    });
    const threadId = "thread-bot-regular-1";
    const parentId = "channel-parent-regular-1";
    const message = createDiscordMessage({
      id: "m-bot-regular-1",
      channelId: threadId,
      content: "here is tool output chunk",
      author: {
        id: "relay-bot-1",
        bot: true,
        username: "Relay",
      },
    });

    const result = await runThreadBoundPreflight({
      threadId,
      parentId,
      message,
      threadBinding,
      discordConfig: {
        allowBots: true,
      } as DiscordConfig,
      registerBindingAdapter: true,
    });

    expect(result).not.toBeNull();
    expect(result?.boundSessionKey).toBe(threadBinding.targetSessionKey);
  });

  it("drops hydrated bound-thread webhook copies after fetching an empty payload", async () => {
    const threadBinding = createThreadBinding({
      targetKind: "session",
      targetSessionKey: "agent:main:acp:discord-thread-1",
    });
    const threadId = "thread-webhook-hydrated-1";
    const parentId = "channel-parent-webhook-hydrated-1";
    const message = createDiscordMessage({
      id: "m-webhook-hydrated-1",
      channelId: threadId,
      content: "",
      author: {
        id: "relay-bot-1",
        bot: true,
        username: "Relay",
      },
    });
    const restGet = vi.fn(async () => ({
      id: message.id,
      content: "webhook relay",
      webhook_id: "wh-1",
      attachments: [],
      embeds: [],
      mentions: [],
      mention_roles: [],
      mention_everyone: false,
      author: {
        id: "relay-bot-1",
        username: "Relay",
        bot: true,
      },
    }));
    const client = Object.assign(createThreadClient({ threadId, parentId }), {
      rest: {
        get: restGet,
      },
    }) as unknown as DiscordClient;

    const result = await preflightDiscordMessage({
      ...createPreflightArgs({
        cfg: DEFAULT_PREFLIGHT_CFG,
        discordConfig: {
          allowBots: true,
        } as DiscordConfig,
        data: createGuildEvent({
          channelId: threadId,
          guildId: "guild-1",
          author: message.author,
          message,
        }),
        client,
      }),
      threadBindings: {
        getByThreadId: (id: string) => (id === threadId ? threadBinding : undefined),
      } as import("./thread-bindings.js").ThreadBindingManager,
    });

    expect(restGet).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
  });

  it("drops bound-thread webhook copies from other webhook ids", async () => {
    const threadBinding = createThreadBinding({
      targetKind: "session",
      targetSessionKey: "agent:main:acp:discord-thread-1",
    });
    const threadId = "thread-webhook-proxy-1";
    const parentId = "channel-parent-webhook-proxy-1";
    const message = createDiscordMessage({
      id: "m-webhook-proxy-1",
      channelId: threadId,
      content: "proxied user message",
      webhookId: "pluralkit-webhook-1",
      author: {
        id: "relay-bot-1",
        bot: true,
        username: "Proxy",
      },
    });

    const result = await runThreadBoundPreflight({
      threadId,
      parentId,
      message,
      threadBinding,
      discordConfig: {
        allowBots: true,
      } as DiscordConfig,
    });

    expect(result).toBeNull();
  });

  it("canonicalizes PluralKit webhook messages to the original Discord message id", async () => {
    fetchPluralKitMessageInfoMock.mockResolvedValue({
      id: "proxy-456",
      original: "orig-123",
      member: { id: "member-1", name: "Echo" },
      system: { id: "system-1", name: "System" },
    });

    const result = await runGuildPreflight({
      channelId: "c1",
      guildId: "g1",
      message: createDiscordMessage({
        id: "proxy-456",
        channelId: "c1",
        content: "<@openclaw-bot> hello",
        webhookId: "pluralkit-webhook-1",
        author: {
          id: "webhook-author",
          bot: true,
          username: "PluralKit",
        },
        mentionedUsers: [{ id: "openclaw-bot" }],
      }),
      discordConfig: {
        pluralkit: { enabled: true },
      } as DiscordConfig,
    });

    expect(fetchPluralKitMessageInfoMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "proxy-456",
        config: expect.objectContaining({ enabled: true }),
      }),
    );
    expect(result).not.toBeNull();
    expect(result?.sender.isPluralKit).toBe(true);
    expect(result?.canonicalMessageId).toBe("orig-123");
  });

  it("skips PluralKit lookup for bound-thread webhook echoes", async () => {
    const threadBinding = createThreadBinding({
      targetKind: "session",
      targetSessionKey: "agent:main:acp:discord-thread-1",
    });
    const threadId = "thread-webhook-pk-echo-1";
    const parentId = "channel-parent-webhook-pk-echo-1";

    const result = await runThreadBoundPreflight({
      threadId,
      parentId,
      threadBinding,
      message: createDiscordMessage({
        id: "m-webhook-pk-echo-1",
        channelId: threadId,
        content: "proxied user message",
        webhookId: "pluralkit-webhook-1",
        author: {
          id: "relay-bot-1",
          bot: true,
          username: "Proxy",
        },
      }),
      discordConfig: {
        pluralkit: { enabled: true },
      } as DiscordConfig,
    });

    expect(result).toBeNull();
    expect(fetchPluralKitMessageInfoMock).not.toHaveBeenCalled();
  });

  it("bypasses mention gating in bound threads for allowed bot senders", async () => {
    const threadBinding = createThreadBinding();
    const threadId = "thread-bot-focus";
    const parentId = "channel-parent-focus";
    const client = createThreadClient({ threadId, parentId });
    const message = createDiscordMessage({
      id: "m-bot-1",
      channelId: threadId,
      content: "relay message without mention",
      author: {
        id: "relay-bot-1",
        bot: true,
        username: "Relay",
      },
    });

    registerSessionBindingAdapter({
      channel: "discord",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: (ref) => (ref.conversationId === threadId ? threadBinding : null),
    });

    const result = await preflightDiscordMessage(
      createPreflightArgs({
        cfg: {
          ...DEFAULT_PREFLIGHT_CFG,
        } as import("openclaw/plugin-sdk/config-types").OpenClawConfig,
        discordConfig: {
          allowBots: true,
        } as DiscordConfig,
        data: createGuildEvent({
          channelId: threadId,
          guildId: "guild-1",
          author: message.author,
          message,
        }),
        client,
      }),
    );

    expect(result).not.toBeNull();
    expect(result?.boundSessionKey).toBe(threadBinding.targetSessionKey);
    expect(result?.shouldRequireMention).toBe(false);
  });

  it("drops bot messages without mention when allowBots=mentions", async () => {
    const channelId = "channel-bot-mentions-off";
    const guildId = "guild-bot-mentions-off";
    const message = createDiscordMessage({
      id: "m-bot-mentions-off",
      channelId,
      content: "relay chatter",
      author: {
        id: "relay-bot-1",
        bot: true,
        username: "Relay",
      },
    });

    const result = await runMentionOnlyBotPreflight({ channelId, guildId, message });

    expect(result).toBeNull();
  });

  it("allows bot messages with explicit mention when allowBots=mentions", async () => {
    const channelId = "channel-bot-mentions-on";
    const guildId = "guild-bot-mentions-on";
    const message = createDiscordMessage({
      id: "m-bot-mentions-on",
      channelId,
      content: "hi <@openclaw-bot>",
      mentionedUsers: [{ id: "openclaw-bot" }],
      author: {
        id: "relay-bot-1",
        bot: true,
        username: "Relay",
      },
    });

    const result = await runMentionOnlyBotPreflight({ channelId, guildId, message });

    expect(result).not.toBeNull();
  });

  it("hydrates mention metadata from REST when bot mention syntax is present but mentions are missing", async () => {
    const channelId = "channel-bot-mentions-hydrated";
    const guildId = "guild-bot-mentions-hydrated";
    const botId = "123456789012345678";
    const message = createDiscordMessage({
      id: "m-bot-mentions-hydrated",
      channelId,
      content: `hi <@${botId}>`,
      author: {
        id: "relay-bot-1",
        bot: true,
        username: "Relay",
      },
      mentionedUsers: [],
    });
    const client = createGuildTextClient(channelId);
    client.rest = {
      get: vi.fn(async () => ({
        id: message.id,
        content: message.content,
        mentions: [{ id: botId, username: "OpenClaw", bot: true }],
        mention_roles: [],
        mention_everyone: false,
      })),
    } as unknown as DiscordClient["rest"];

    const result = await preflightDiscordMessage({
      ...createPreflightArgs({
        cfg: DEFAULT_PREFLIGHT_CFG,
        discordConfig: {
          allowBots: "mentions",
        } as DiscordConfig,
        data: createGuildEvent({
          channelId,
          guildId,
          author: message.author,
          message,
        }),
        client,
      }),
      botUserId: botId,
    });

    expect(result).not.toBeNull();
  });

  it("still drops bot control commands without a real mention when allowBots=mentions", async () => {
    const channelId = "channel-bot-command-no-mention";
    const guildId = "guild-bot-command-no-mention";
    const message = createDiscordMessage({
      id: "m-bot-command-no-mention",
      channelId,
      content: "/new incident room",
      author: {
        id: "relay-bot-1",
        bot: true,
        username: "Relay",
      },
    });

    const result = await runMentionOnlyBotPreflight({ channelId, guildId, message });

    expect(result).toBeNull();
  });

  it("still allows bot control commands with an explicit mention when allowBots=mentions", async () => {
    const channelId = "channel-bot-command-with-mention";
    const guildId = "guild-bot-command-with-mention";
    const message = createDiscordMessage({
      id: "m-bot-command-with-mention",
      channelId,
      content: "<@openclaw-bot> /new incident room",
      mentionedUsers: [{ id: "openclaw-bot" }],
      author: {
        id: "relay-bot-1",
        bot: true,
        username: "Relay",
      },
    });

    const result = await runMentionOnlyBotPreflight({ channelId, guildId, message });

    expect(result).not.toBeNull();
  });

  it("routes ordinary guild text control commands through authorization instead of dropping them", async () => {
    const channelId = "channel-text-control-command";
    const guildId = "guild-text-control-command";
    const message = createDiscordMessage({
      id: "m-text-control-command",
      channelId,
      content: "/steer keep digging",
      author: {
        id: "user-1",
        bot: false,
        username: "Alice",
      },
    });

    const result = await preflightDiscordMessage({
      ...createPreflightArgs({
        cfg: DEFAULT_PREFLIGHT_CFG,
        discordConfig: {} as DiscordConfig,
        data: createGuildEvent({
          channelId,
          guildId,
          author: message.author,
          message,
        }),
        client: createGuildTextClient(channelId),
      }),
      allowFrom: ["discord:user-1"],
      guildEntries: {
        [guildId]: {
          channels: {
            [channelId]: {
              enabled: true,
              requireMention: true,
            },
          },
        },
      },
    });

    expect(result).not.toBeNull();
    expect(result?.baseText).toBe("/steer keep digging");
    expect(result?.commandAuthorized).toBe(true);
    expect(result?.shouldRequireMention).toBe(true);
    expect(result?.shouldBypassMention).toBe(true);
  });

  it("still drops Discord native command echo messages", async () => {
    const channelId = "channel-native-command-echo";
    const guildId = "guild-native-command-echo";
    const message = createDiscordMessage({
      id: "m-native-command-echo",
      channelId,
      content: "/steer keep digging",
      type: MessageType.ChatInputCommand,
      author: {
        id: "user-1",
        bot: false,
        username: "Alice",
      },
    });

    const result = await preflightDiscordMessage({
      ...createPreflightArgs({
        cfg: DEFAULT_PREFLIGHT_CFG,
        discordConfig: {} as DiscordConfig,
        data: createGuildEvent({
          channelId,
          guildId,
          author: message.author,
          message,
        }),
        client: createGuildTextClient(channelId),
      }),
      allowFrom: ["discord:user-1"],
      guildEntries: {
        [guildId]: {
          channels: {
            [channelId]: {
              enabled: true,
              requireMention: true,
            },
          },
        },
      },
    });

    expect(result).toBeNull();
  });

  it("does not mask mention gating when bot id is missing but mention patterns can detect", async () => {
    const channelId = "channel-missing-bot-id-mention-gate";
    const guildId = "guild-missing-bot-id-mention-gate";
    const message = createDiscordMessage({
      id: "m-missing-bot-id-mention-gate",
      channelId,
      content: "general update without the configured mention",
      author: {
        id: "user-1",
        bot: false,
        username: "Alice",
      },
    });

    const result = await preflightDiscordMessage({
      ...createPreflightArgs({
        cfg: {
          ...DEFAULT_PREFLIGHT_CFG,
          messages: {
            groupChat: {
              mentionPatterns: ["openclaw"],
            },
          },
        } as import("openclaw/plugin-sdk/config-types").OpenClawConfig,
        discordConfig: {} as DiscordConfig,
        data: createGuildEvent({
          channelId,
          guildId,
          author: message.author,
          message,
        }),
        client: createGuildTextClient(channelId),
      }),
      botUserId: undefined,
      guildEntries: {
        [guildId]: {
          channels: {
            [channelId]: {
              enabled: true,
              requireMention: true,
            },
          },
        },
      },
    });

    expect(result).toBeNull();
  });

  it("treats @everyone as a mention when requireMention is true", async () => {
    const channelId = "channel-everyone-mention";
    const guildId = "guild-everyone-mention";
    const message = createDiscordMessage({
      id: "m-everyone-mention",
      channelId,
      content: "@everyone standup time!",
      mentionedEveryone: true,
      author: {
        id: "user-1",
        bot: false,
        username: "Peter",
      },
    });

    const result = await runGuildPreflight({
      channelId,
      guildId,
      message,
      discordConfig: {
        botId: "openclaw-bot",
      } as DiscordConfig,
      guildEntries: {
        [guildId]: {
          channels: {
            [channelId]: {
              enabled: true,
              requireMention: true,
            },
          },
        },
      },
    });

    expect(result).not.toBeNull();
    expect(result?.shouldRequireMention).toBe(true);
    expect(result?.wasMentioned).toBe(true);
  });

  it("accepts allowlisted guild messages when guild object is missing", async () => {
    const message = createDiscordMessage({
      id: "m-guild-id-only",
      channelId: "ch-1",
      content: "hello from maintainers",
      author: {
        id: "user-1",
        bot: false,
        username: "Peter",
      },
    });

    const result = await runGuildPreflight({
      channelId: "ch-1",
      guildId: "guild-1",
      message,
      discordConfig: {} as DiscordConfig,
      guildEntries: {
        "guild-1": {
          channels: {
            "ch-1": {
              enabled: true,
              requireMention: false,
            },
          },
        },
      },
      includeGuildObject: false,
    });

    expect(result).not.toBeNull();
    expect(result?.guildInfo?.id).toBe("guild-1");
    expect(result?.channelConfig?.allowed).toBe(true);
    expect(result?.shouldRequireMention).toBe(false);
  });

  it("inherits parent thread allowlist when guild object is missing", async () => {
    const threadId = "thread-1";
    const parentId = "parent-1";
    const message = createDiscordMessage({
      id: "m-thread-id-only",
      channelId: threadId,
      content: "thread hello",
      author: {
        id: "user-1",
        bot: false,
        username: "Peter",
      },
    });

    const result = await preflightDiscordMessage({
      ...createPreflightArgs({
        cfg: DEFAULT_PREFLIGHT_CFG,
        discordConfig: {} as DiscordConfig,
        data: createGuildEvent({
          channelId: threadId,
          guildId: "guild-1",
          author: message.author,
          message,
          includeGuildObject: false,
        }),
        client: createThreadClient({
          threadId,
          parentId,
        }),
      }),
      guildEntries: {
        "guild-1": {
          channels: {
            [parentId]: {
              enabled: true,
              requireMention: false,
            },
          },
        },
      },
    });

    expect(result).not.toBeNull();
    expect(result?.guildInfo?.id).toBe("guild-1");
    expect(result?.threadParentId).toBe(parentId);
    expect(result?.channelConfig?.allowed).toBe(true);
    expect(result?.shouldRequireMention).toBe(false);
  });

  it("handles partial thread channel owner getters during mention preflight", async () => {
    const threadId = "thread-partial-owner";
    const parentId = "parent-partial-owner";
    const message = createDiscordMessage({
      id: "m-thread-partial-owner",
      channelId: threadId,
      content: "thread hello",
      author: {
        id: "user-1",
        bot: false,
        username: "Peter",
      },
    });
    Object.defineProperty(message, "channel", {
      value: createPartialDiscordChannelWithThrowingGetters(
        {
          id: threadId,
          isThread: () => true,
          ownerId: "owner-1",
          parentId,
          parent: { id: parentId, name: "general" },
        },
        ["ownerId", "parentId", "parent"],
      ),
      configurable: true,
      enumerable: true,
    });

    const result = await preflightDiscordMessage({
      ...createPreflightArgs({
        cfg: DEFAULT_PREFLIGHT_CFG,
        discordConfig: {} as DiscordConfig,
        data: createGuildEvent({
          channelId: threadId,
          guildId: "guild-1",
          author: message.author,
          message,
          includeGuildObject: false,
        }),
        client: createThreadClient({
          threadId,
          parentId,
        }),
      }),
      guildEntries: {
        "guild-1": {
          channels: {
            [parentId]: {
              enabled: true,
              requireMention: false,
            },
          },
        },
      },
    });

    expect(result).not.toBeNull();
    expect(result?.threadParentId).toBe(parentId);
    expect(result?.shouldRequireMention).toBe(false);
  });

  it("drops guild messages that mention another user when ignoreOtherMentions=true", async () => {
    const channelId = "channel-other-mention-1";
    const guildId = "guild-other-mention-1";
    const message = createDiscordMessage({
      id: "m-other-mention-1",
      channelId,
      content: "hello <@999>",
      mentionedUsers: [{ id: "999" }],
      author: {
        id: "user-1",
        bot: false,
        username: "Alice",
      },
    });

    const result = await runIgnoreOtherMentionsPreflight({ channelId, guildId, message });

    expect(result).toBeNull();
  });

  it("does not drop @everyone messages when ignoreOtherMentions=true", async () => {
    const channelId = "channel-other-mention-everyone";
    const guildId = "guild-other-mention-everyone";
    const message = createDiscordMessage({
      id: "m-other-mention-everyone",
      channelId,
      content: "@everyone heads up",
      mentionedEveryone: true,
      author: {
        id: "user-1",
        bot: false,
        username: "Alice",
      },
    });

    const result = await runIgnoreOtherMentionsPreflight({ channelId, guildId, message });

    expect(result).not.toBeNull();
    expect(result?.hasAnyMention).toBe(true);
  });

  it("ignores bot-sent @everyone mentions for detection", async () => {
    const channelId = "channel-everyone-1";
    const guildId = "guild-everyone-1";
    const client = createGuildTextClient(channelId);
    const message = createDiscordMessage({
      id: "m-everyone-1",
      channelId,
      content: "@everyone heads up",
      mentionedEveryone: true,
      author: {
        id: "relay-bot-1",
        bot: true,
        username: "Relay",
      },
    });

    const result = await preflightDiscordMessage({
      ...createPreflightArgs({
        cfg: DEFAULT_PREFLIGHT_CFG,
        discordConfig: {
          allowBots: true,
        } as DiscordConfig,
        data: createGuildEvent({
          channelId,
          guildId,
          author: message.author,
          message,
        }),
        client,
      }),
      guildEntries: {
        [guildId]: {
          requireMention: false,
        },
      },
    });

    expect(result).not.toBeNull();
    expect(result?.hasAnyMention).toBe(false);
  });

  it("does not treat bot-sent @everyone as wasMentioned", async () => {
    const channelId = "channel-everyone-2";
    const guildId = "guild-everyone-2";
    const client = createGuildTextClient(channelId);
    const message = createDiscordMessage({
      id: "m-everyone-2",
      channelId,
      content: "@everyone relay message",
      mentionedEveryone: true,
      author: {
        id: "relay-bot-2",
        bot: true,
        username: "RelayBot",
      },
    });

    const result = await preflightDiscordMessage({
      ...createPreflightArgs({
        cfg: DEFAULT_PREFLIGHT_CFG,
        discordConfig: {
          allowBots: true,
        } as DiscordConfig,
        data: createGuildEvent({
          channelId,
          guildId,
          author: message.author,
          message,
        }),
        client,
      }),
      guildEntries: {
        [guildId]: {
          requireMention: false,
        },
      },
    });

    expect(result).not.toBeNull();
    expect(result?.wasMentioned).toBe(false);
  });

  it("uses attachment content_type for guild audio preflight mention detection", async () => {
    transcribeFirstAudioMock.mockResolvedValue("hey openclaw");

    const channelId = "channel-audio-1";
    const client = createGuildTextClient(channelId);

    const message = createDiscordMessage({
      id: "m-audio-1",
      channelId,
      content: "",
      attachments: [
        {
          id: "att-1",
          url: "https://cdn.discordapp.com/attachments/voice.ogg",
          content_type: "audio/ogg",
          filename: "voice.ogg",
        },
      ],
      author: {
        id: "user-1",
        bot: false,
        username: "Alice",
      },
    });

    const result = await preflightDiscordMessage({
      ...createPreflightArgs({
        cfg: {
          ...DEFAULT_PREFLIGHT_CFG,
          messages: {
            groupChat: {
              mentionPatterns: ["openclaw"],
            },
          },
        } as import("openclaw/plugin-sdk/config-types").OpenClawConfig,
        discordConfig: {} as DiscordConfig,
        data: createGuildEvent({
          channelId,
          guildId: "guild-1",
          author: message.author,
          message,
        }),
        client,
      }),
      guildEntries: {
        "guild-1": {
          channels: {
            [channelId]: {
              enabled: true,
              requireMention: true,
            },
          },
        },
      },
    });

    expect(transcribeFirstAudioMock).toHaveBeenCalledTimes(1);
    expect(transcribeFirstAudioMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          MediaUrls: ["https://cdn.discordapp.com/attachments/voice.ogg"],
          MediaTypes: ["audio/ogg"],
        }),
      }),
    );
    expect(result).not.toBeNull();
    expect(result?.wasMentioned).toBe(true);
    expect(result?.preflightAudioTranscript).toBe("hey openclaw");
  });

  it("does not transcribe guild audio from unauthorized members", async () => {
    const channelId = "channel-audio-unauthorized-1";
    const guildId = "guild-audio-unauthorized-1";
    const client = createGuildTextClient(channelId);

    const message = createDiscordMessage({
      id: "m-audio-unauthorized-1",
      channelId,
      content: "",
      attachments: [
        {
          id: "att-1",
          url: "https://cdn.discordapp.com/attachments/voice.ogg",
          content_type: "audio/ogg",
          filename: "voice.ogg",
        },
      ],
      author: {
        id: "user-2",
        bot: false,
        username: "Mallory",
      },
    });

    const result = await preflightDiscordMessage({
      ...createPreflightArgs({
        cfg: {
          ...DEFAULT_PREFLIGHT_CFG,
          messages: {
            groupChat: {
              mentionPatterns: ["openclaw"],
            },
          },
        } as import("openclaw/plugin-sdk/config-types").OpenClawConfig,
        discordConfig: {} as DiscordConfig,
        data: createGuildEvent({
          channelId,
          guildId,
          author: message.author,
          message,
        }),
        client,
      }),
      guildEntries: {
        [guildId]: {
          channels: {
            [channelId]: {
              enabled: true,
              requireMention: true,
              users: ["user-1"],
            },
          },
        },
      },
    });

    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("drops guild message without mention when channel has configuredBinding and requireMention: true", async () => {
    const conversationRuntime = await import("openclaw/plugin-sdk/conversation-runtime");
    const channelId = "ch-binding-1";
    const bindingRoute = {
      bindingResolution: {
        record: {
          targetSessionKey: "agent:main:acp:binding:discord:default:abc",
          targetKind: "session",
        },
      } as never,
      route: { agentId: "main", matchedBy: "binding.channel" } as never,
      boundSessionKey: "agent:main:acp:binding:discord:default:abc",
      boundAgentId: "main",
    };
    const routeSpy = vi
      .spyOn(conversationRuntime, "resolveConfiguredBindingRoute")
      .mockReturnValue(bindingRoute);
    const ensureSpy = vi
      .spyOn(conversationRuntime, "ensureConfiguredBindingRouteReady")
      .mockResolvedValue({ ok: true });

    try {
      const result = await runGuildPreflight({
        channelId,
        guildId: "guild-1",
        message: createDiscordMessage({
          id: "m-binding-1",
          channelId,
          content: "hello without mention",
          author: { id: "user-1", bot: false, username: "alice" },
        }),
        discordConfig: {} as DiscordConfig,
        guildEntries: {
          "guild-1": { channels: { [channelId]: { enabled: true, requireMention: true } } },
        },
      });
      expect(result).toBeNull();
    } finally {
      routeSpy.mockRestore();
      ensureSpy.mockRestore();
    }
  });

  it("allows guild message with mention when channel has configuredBinding and requireMention: true", async () => {
    const conversationRuntime = await import("openclaw/plugin-sdk/conversation-runtime");
    const channelId = "ch-binding-2";
    const bindingRoute = {
      bindingResolution: {
        record: {
          targetSessionKey: "agent:main:acp:binding:discord:default:def",
          targetKind: "session",
        },
      } as never,
      route: { agentId: "main", matchedBy: "binding.channel" } as never,
      boundSessionKey: "agent:main:acp:binding:discord:default:def",
      boundAgentId: "main",
    };
    const routeSpy = vi
      .spyOn(conversationRuntime, "resolveConfiguredBindingRoute")
      .mockReturnValue(bindingRoute);
    const ensureSpy = vi
      .spyOn(conversationRuntime, "ensureConfiguredBindingRouteReady")
      .mockResolvedValue({ ok: true });

    try {
      const result = await runGuildPreflight({
        channelId,
        guildId: "guild-1",
        message: createDiscordMessage({
          id: "m-binding-2",
          channelId,
          content: "hello <@openclaw-bot>",
          author: { id: "user-1", bot: false, username: "alice" },
          mentionedUsers: [{ id: "openclaw-bot" }],
        }),
        discordConfig: {} as DiscordConfig,
        guildEntries: {
          "guild-1": { channels: { [channelId]: { enabled: true, requireMention: true } } },
        },
      });
      expect(result).not.toBeNull();
    } finally {
      routeSpy.mockRestore();
      ensureSpy.mockRestore();
    }
  });
});

describe("shouldIgnoreBoundThreadWebhookMessage", () => {
  beforeEach(() => {
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    threadBindingTesting.resetThreadBindingsForTests();
  });

  it("returns true when inbound webhook id matches the bound thread webhook", () => {
    expect(
      shouldIgnoreBoundThreadWebhookMessage({
        webhookId: "wh-1",
        threadBinding: createThreadBinding(),
      }),
    ).toBe(true);
  });

  it("returns true when a bound thread receives a different webhook id", () => {
    expect(
      shouldIgnoreBoundThreadWebhookMessage({
        threadId: "thread-1",
        webhookId: "wh-other",
        threadBinding: createThreadBinding(),
      }),
    ).toBe(true);
  });

  it("returns true when a bound thread receives a webhook without a recorded bound webhook id", () => {
    expect(
      shouldIgnoreBoundThreadWebhookMessage({
        threadId: "thread-1",
        webhookId: "wh-1",
        threadBinding: createThreadBinding({
          metadata: {
            webhookId: undefined,
          },
        }),
      }),
    ).toBe(true);
  });

  it("returns false for differing webhook ids without a known thread id", () => {
    expect(
      shouldIgnoreBoundThreadWebhookMessage({
        webhookId: "wh-other",
        threadBinding: createThreadBinding(),
      }),
    ).toBe(false);
  });

  it("returns true for recently unbound thread webhook echoes", async () => {
    const manager = createThreadBindingManager({
      cfg: DEFAULT_PREFLIGHT_CFG,
      accountId: "default",
      persist: false,
      enableSweeper: false,
    });
    const binding = await manager.bindTarget({
      threadId: "thread-1",
      channelId: "parent-1",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:child-1",
      agentId: "main",
      webhookId: "wh-1",
      webhookToken: "tok-1",
    });
    expect(binding).not.toBeNull();

    manager.unbindThread({
      threadId: "thread-1",
      sendFarewell: false,
    });

    expect(
      shouldIgnoreBoundThreadWebhookMessage({
        accountId: "default",
        threadId: "thread-1",
        webhookId: "wh-1",
      }),
    ).toBe(true);
  });
});
