import { ChannelType, MessageType } from "@buape/carbon";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchMock } from "./monitor.tool-result.test-harness.js";
import {
  captureNextDispatchCtx,
  type Config,
  createGuildHandler,
  createGuildMessageEvent,
  createGuildTextClient,
  createMentionRequiredGuildConfig,
  createThreadChannel,
  createThreadClient,
  createThreadEvent,
  resetDiscordToolResultHarness,
} from "./monitor.tool-result.test-helpers.js";

beforeEach(() => {
  resetDiscordToolResultHarness();
});

async function createHandler(cfg: Config) {
  return createGuildHandler({ cfg });
}

function createOpenGuildConfig(
  channels: Record<string, { allow: boolean; includeThreadStarter?: boolean }>,
  extra: Partial<Config> = {},
): Config {
  const cfg: Config = {
    ...createMentionRequiredGuildConfig(),
    ...extra,
    channels: {
      discord: {
        dm: { enabled: true, policy: "open" },
        groupPolicy: "open",
        guilds: {
          "*": {
            requireMention: false,
            channels,
          },
        },
      },
    },
  };
  return cfg;
}

describe("discord tool result dispatch", () => {
  it("accepts guild messages when mentionPatterns match", async () => {
    const cfg = createMentionRequiredGuildConfig({
      messages: {
        inbound: { debounceMs: 0 },
        groupChat: { mentionPatterns: ["\\bopenclaw\\b"] },
      },
    } as Partial<Config>);

    const handler = await createHandler(cfg);
    const client = createGuildTextClient();

    await handler(createGuildMessageEvent({ messageId: "m2", content: "openclaw: hello" }), client);

    await vi.waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(1));
  });

  it("accepts guild reply-to-bot messages as implicit mentions", async () => {
    const getCapturedCtx = captureNextDispatchCtx<{ WasMentioned?: boolean }>();
    const cfg = createMentionRequiredGuildConfig();
    const handler = await createHandler(cfg);
    const client = createGuildTextClient();

    await handler(
      createGuildMessageEvent({
        messageId: "m3",
        content: "following up",
        messagePatch: {
          referencedMessage: {
            id: "m2",
            channelId: "c1",
            content: "bot reply",
            timestamp: new Date().toISOString(),
            type: MessageType.Default,
            attachments: [],
            embeds: [],
            mentionedEveryone: false,
            mentionedUsers: [],
            mentionedRoles: [],
            author: { id: "bot-id", bot: true, username: "OpenClaw" },
          },
        },
      }),
      client,
    );

    await vi.waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(1));
    expect(getCapturedCtx()?.WasMentioned).toBe(true);
  });

  it("forks thread sessions and injects starter context", async () => {
    const getCapturedCtx = captureNextDispatchCtx<{
      SessionKey?: string;
      ParentSessionKey?: string;
      ThreadStarterBody?: string;
      ThreadLabel?: string;
    }>();
    const cfg = createOpenGuildConfig({ p1: { allow: true } });

    const handler = await createHandler(cfg);
    const client = createThreadClient({
      fetchChannel: vi
        .fn()
        .mockResolvedValueOnce(createThreadChannel({ includeStarter: true }))
        .mockResolvedValueOnce({ id: "p1", type: ChannelType.GuildText, name: "general" }),
    });

    await handler(createThreadEvent("m4"), client);

    await vi.waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(1));
    const capturedCtx = getCapturedCtx();
    expect(capturedCtx?.SessionKey).toBe("agent:main:discord:channel:t1");
    expect(capturedCtx?.ParentSessionKey).toBe("agent:main:discord:channel:p1");
    expect(capturedCtx?.ThreadStarterBody).toContain("starter message");
    expect(capturedCtx?.ThreadLabel).toContain("Discord thread #general");
  });

  it("skips thread starter context when disabled", async () => {
    const getCapturedCtx = captureNextDispatchCtx<{ ThreadStarterBody?: string }>();
    const cfg = createOpenGuildConfig({
      p1: { allow: true, includeThreadStarter: false },
    });

    const handler = await createHandler(cfg);
    const client = createThreadClient();

    await handler(createThreadEvent("m7"), client);

    await vi.waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(1));
    expect(getCapturedCtx()?.ThreadStarterBody).toBeUndefined();
  });

  it("treats forum threads as distinct sessions without channel payloads", async () => {
    const getCapturedCtx = captureNextDispatchCtx<{
      SessionKey?: string;
      ParentSessionKey?: string;
      ThreadStarterBody?: string;
      ThreadLabel?: string;
    }>();
    const cfg = createOpenGuildConfig({ "forum-1": { allow: true } });

    const fetchChannel = vi
      .fn()
      .mockResolvedValueOnce({
        id: "t1",
        type: ChannelType.PublicThread,
        name: "topic-1",
        parentId: "forum-1",
      })
      .mockResolvedValueOnce({
        id: "forum-1",
        type: ChannelType.GuildForum,
        name: "support",
      });
    const restGet = vi.fn().mockResolvedValue({
      content: "starter message",
      author: { id: "u1", username: "Alice", discriminator: "0001" },
      timestamp: new Date().toISOString(),
    });
    const handler = await createHandler(cfg);
    const client = createThreadClient({ fetchChannel, restGet });

    await handler(createThreadEvent("m6"), client);

    await vi.waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(1));
    const capturedCtx = getCapturedCtx();
    expect(capturedCtx?.SessionKey).toBe("agent:main:discord:channel:t1");
    expect(capturedCtx?.ParentSessionKey).toBe("agent:main:discord:channel:forum-1");
    expect(capturedCtx?.ThreadStarterBody).toContain("starter message");
    expect(capturedCtx?.ThreadLabel).toContain("Discord thread #support");
  });

  it("scopes thread sessions to the routed agent", async () => {
    const getCapturedCtx = captureNextDispatchCtx<{
      SessionKey?: string;
      ParentSessionKey?: string;
    }>();
    const cfg = createOpenGuildConfig(
      { p1: { allow: true } },
      { bindings: [{ agentId: "support", match: { channel: "discord", guildId: "g1" } }] },
    );

    const handler = await createHandler(cfg);
    const client = createThreadClient();

    await handler(createThreadEvent("m5"), client);

    await vi.waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(1));
    const capturedCtx = getCapturedCtx();
    expect(capturedCtx?.SessionKey).toBe("agent:support:discord:channel:t1");
    expect(capturedCtx?.ParentSessionKey).toBe("agent:support:discord:channel:p1");
  });
});
