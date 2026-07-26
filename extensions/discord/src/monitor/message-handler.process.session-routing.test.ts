// Discord message processing coverage split by cohesive behavior.
import { DEFAULT_EMOJIS } from "openclaw/plugin-sdk/channel-feedback";
import { describe, expect, it, vi } from "vitest";
import {
  BASE_CHANNEL_ROUTE,
  createBaseContext,
  createDirectMessageContextOverrides,
  createDiscordDraftStream,
  createNoQueuedDispatchResult,
  dispatchInboundMessageForTest as dispatchInboundMessage,
  getLastDispatchCtx,
  getLastDispatchReplyOptions,
  getLastRouteUpdate,
  runProcessDiscordMessage,
  sendMocksForTest as sendMocks,
  registerDiscordProcessTestLifecycle,
} from "./message-handler.process.test-harness.js";
import type { DispatchInboundParams } from "./message-handler.process.test-harness.js";
import {
  expectRecordFields,
  getReactionEmojis,
  requireRecord,
} from "./message-handler.process.test-helpers.js";

registerDiscordProcessTestLifecycle();

describe("processDiscordMessage session routing", () => {
  it("carries preflight audio transcript into dispatch context and marks media transcribed", async () => {
    const ctx = await createBaseContext({
      message: {
        id: "m-audio-preflight",
        channelId: "c1",
        content: "",
        timestamp: new Date().toISOString(),
        attachments: [
          {
            id: "att-audio-preflight",
            url: "https://cdn.discordapp.com/attachments/voice.ogg",
            content_type: "audio/ogg",
            filename: "voice.ogg",
          },
        ],
      },
      baseText: "",
      messageText: "",
      preflightAudioTranscript: "hello from discord voice",
      preparedMedia: [
        {
          path: "/tmp/openclaw-discord-test/voice.ogg",
          contentType: "audio/ogg",
        },
      ],
    });

    await runProcessDiscordMessage(ctx);

    expectRecordFields(requireRecord(getLastDispatchCtx(), "dispatch context"), {
      BodyForAgent: "hello from discord voice",
      CommandBody: "hello from discord voice",
      Transcript: "hello from discord voice",
      media: [expect.objectContaining({ contentType: "audio/ogg", transcribed: true })],
    });
  });

  it("uses prepared media instead of re-downloading after the run queue", async () => {
    // Regression for #96165: Discord CDN attachment URLs expire, so process
    // must not re-fetch attachments preflight already downloaded at receipt
    // time. A throwing fetchImpl here proves no re-fetch happens.
    const fetchImpl = vi.fn(async () => {
      throw new Error("attachment should not be re-fetched after preflight downloaded it");
    });
    const ctx = await createBaseContext({
      message: {
        id: "m-preflight-media",
        channelId: "c1",
        content: "look",
        timestamp: new Date().toISOString(),
        attachments: [
          {
            id: "att-preflight-media",
            url: "https://cdn.discordapp.com/attachments/1/photo.png?ex=expired",
            content_type: "image/png",
            filename: "photo.png",
          },
        ],
      },
      baseText: "look",
      messageText: "look",
      preparedMedia: [
        {
          path: "/tmp/openclaw-discord-test/photo.png",
          contentType: "image/png",
        },
      ],
      discordRestFetch: fetchImpl,
    });

    await runProcessDiscordMessage(ctx);

    expect(fetchImpl).not.toHaveBeenCalled();
    expectRecordFields(requireRecord(getLastDispatchCtx(), "dispatch context"), {
      media: [
        expect.objectContaining({
          path: "/tmp/openclaw-discord-test/photo.png",
          contentType: "image/png",
        }),
      ],
    });
  });

  it("does not attach referenced reply media when reply context is hidden", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("hidden reply media should not be fetched");
    });
    const ctx = await createBaseContext({
      cfg: {
        channels: { discord: { contextVisibility: "allowlist" } },
        messages: { ackReaction: "👀" },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
      author: {
        id: "U1",
        username: "alice",
        discriminator: "0",
        globalName: "Alice",
      },
      channelConfig: {
        allowed: true,
        users: ["U1"],
      },
      discordRestFetch: fetchImpl,
      message: {
        id: "m-reply-hidden-media",
        channelId: "c1",
        content: "<@bot> what is this?",
        timestamp: new Date().toISOString(),
        attachments: [],
        messageReference: {
          type: 0,
          message_id: "m-hidden",
          channel_id: "c1",
        },
        referencedMessage: {
          id: "m-hidden",
          channelId: "c1",
          content: "hidden image",
          timestamp: new Date().toISOString(),
          attachments: [
            {
              id: "att-hidden",
              url: "https://cdn.discordapp.com/attachments/hidden.png",
              content_type: "image/png",
              filename: "hidden.png",
            },
          ],
          author: {
            id: "U2",
            username: "mallory",
            discriminator: "0",
            globalName: "Mallory",
          },
        },
      },
      baseText: "<@bot> what is this?",
      messageText: "<@bot> what is this?",
    });

    await runProcessDiscordMessage(ctx);

    const dispatchCtx = requireRecord(getLastDispatchCtx(), "dispatch context");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(dispatchCtx.ReplyToBody).toBeUndefined();
    expect(dispatchCtx.MediaPath).toBeUndefined();
    expect(dispatchCtx.MediaPaths).toBeUndefined();
  });

  it("does not inject the bot's previous message body when users reply to it", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("self-reply media should not be fetched");
    });
    const ctx = await createBaseContext({
      botUserId: "bot-1",
      cfg: {
        channels: { discord: { contextVisibility: "all" } },
        messages: { ackReaction: "👀" },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
      discordRestFetch: fetchImpl,
      message: {
        id: "m-self-reply",
        channelId: "c1",
        content: "<@bot> hit that again",
        timestamp: new Date().toISOString(),
        attachments: [],
        messageReference: {
          type: 0,
          message_id: "m-bot-previous",
          channel_id: "c1",
        },
        referencedMessage: {
          id: "m-bot-previous",
          channelId: "c1",
          content: "The same stale bot response keeps looping.",
          timestamp: new Date().toISOString(),
          attachments: [
            {
              id: "att-bot-previous",
              url: "https://cdn.discordapp.com/attachments/previous.png",
              content_type: "image/png",
              filename: "previous.png",
            },
          ],
          author: {
            id: "bot-1",
            username: "Spartacus",
            discriminator: "0",
            globalName: "Spartacus",
          },
        },
      },
      baseText: "<@bot> hit that again",
      messageText: "<@bot> hit that again",
    });

    await runProcessDiscordMessage(ctx);

    const dispatchCtx = requireRecord(getLastDispatchCtx(), "dispatch context");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(dispatchCtx.ReplyToId).toBe("m-bot-previous");
    expect(dispatchCtx.ReplyToSender).toBe("Spartacus");
    expect(dispatchCtx.ReplyToBody).toBeUndefined();
    expect(JSON.stringify(dispatchCtx)).not.toContain("The same stale bot response keeps looping.");
  });

  it("stores DM lastRoute with user target for direct-session continuity", async () => {
    const ctx = await createBaseContext({
      ...createDirectMessageContextOverrides(),
      message: {
        id: "m1",
        channelId: "dm1",
        timestamp: new Date().toISOString(),
        attachments: [],
      },
      messageChannelId: "dm1",
    });

    await runProcessDiscordMessage(ctx);

    expect(getLastRouteUpdate()).toEqual({
      sessionKey: "agent:main:discord:direct:u1",
      channel: "discord",
      to: "user:U1",
      accountId: "default",
    });
    expectRecordFields(requireRecord(getLastDispatchCtx(), "dispatch context"), {
      ChatType: "direct",
      From: "discord:U1",
      To: "user:U1",
      OriginatingTo: "user:U1",
      SessionKey: "agent:main:discord:direct:u1",
    });
  });

  it("pins Discord text DM main-route updates to the single configured DM owner", async () => {
    const ctx = await createBaseContext({
      ...createDirectMessageContextOverrides(),
      cfg: {
        messages: { ackReaction: "👀" },
        session: {
          store: "/tmp/openclaw-discord-process-test-sessions.json",
          dmScope: "main",
        },
      },
      channelConfig: { users: ["user:111"] },
      baseSessionKey: "agent:main:main",
      author: {
        id: "222",
        username: "bob",
        discriminator: "0",
        globalName: "Bob",
      },
      sender: { id: "222", label: "bob" },
      route: {
        agentId: "main",
        channel: "discord",
        accountId: "default",
        sessionKey: "agent:main:main",
        mainSessionKey: "agent:main:main",
      },
    });

    await runProcessDiscordMessage(ctx);

    expectRecordFields(requireRecord(getLastRouteUpdate(), "last route update"), {
      sessionKey: "agent:main:main",
      channel: "discord",
      to: "user:222",
      accountId: "default",
    });
    expectRecordFields(
      requireRecord(
        requireRecord(getLastRouteUpdate(), "last route update").mainDmOwnerPin,
        "main DM owner pin",
      ),
      {
        ownerRecipient: "111",
        senderRecipient: "222",
      },
    );
  });

  it("stores group lastRoute with channel target", async () => {
    const ctx = await createBaseContext({
      baseSessionKey: "agent:main:discord:channel:c1",
      route: BASE_CHANNEL_ROUTE,
    });

    await runProcessDiscordMessage(ctx);

    expect(getLastRouteUpdate()).toEqual({
      sessionKey: "agent:main:discord:channel:c1",
      channel: "discord",
      to: "channel:c1",
      accountId: "default",
    });
  });

  it("marks explicit message-tool guild replies as message-tool-only and disables source streaming", async () => {
    const ctx = await createBaseContext({
      shouldRequireMention: false,
      effectiveWasMentioned: false,
      discordConfig: { streaming: { mode: "partial", block: { enabled: true } } },
      cfg: {
        messages: {
          groupChat: { visibleReplies: "message_tool" },
        },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
      route: BASE_CHANNEL_ROUTE,
    });

    await runProcessDiscordMessage(ctx);

    expectRecordFields(requireRecord(getLastDispatchReplyOptions(), "dispatch reply options"), {
      sourceReplyDeliveryMode: "message_tool_only",
      typingKeepalive: false,
      disableBlockStreaming: true,
    });
    expect(createDiscordDraftStream).not.toHaveBeenCalled();
  });

  it("sends the configured ack while suppressing automatic status reactions for always-on guild replies", async () => {
    const ctx = await createBaseContext({
      shouldRequireMention: false,
      effectiveWasMentioned: false,
      ackReactionScope: "all",
      cfg: {
        messages: {
          ackReaction: "👀",
          ackReactionScope: "all",
          groupChat: { visibleReplies: "message_tool" },
          statusReactions: {
            timing: { debounceMs: 0 },
          },
        },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
      route: BASE_CHANNEL_ROUTE,
    });

    await runProcessDiscordMessage(ctx);

    expect(getLastDispatchReplyOptions()?.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(getReactionEmojis()).toEqual(["👀"]);
    expect(sendMocks.removeReactionDiscord).not.toHaveBeenCalled();
  });

  it("honors explicit status reactions for always-on guild replies", async () => {
    vi.useFakeTimers();
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onReasoningStream?.();
      await new Promise((resolve) => {
        setTimeout(resolve, 1_000);
      });
      return createNoQueuedDispatchResult();
    });
    const ctx = await createBaseContext({
      shouldRequireMention: false,
      effectiveWasMentioned: false,
      ackReactionScope: "all",
      cfg: {
        messages: {
          ackReaction: "👀",
          ackReactionScope: "all",
          groupChat: { visibleReplies: "message_tool" },
          statusReactions: {
            enabled: true,
            timing: { debounceMs: 0 },
          },
        },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
      route: BASE_CHANNEL_ROUTE,
    });

    const runPromise = runProcessDiscordMessage(ctx);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.runAllTimersAsync();
    await runPromise;

    expect(getLastDispatchReplyOptions()?.sourceReplyDeliveryMode).toBe("message_tool_only");
    const emojis = getReactionEmojis();
    expect(emojis).toContain("👀");
    expect(emojis).toContain(DEFAULT_EMOJIS.thinking);
    expect(emojis).toContain(DEFAULT_EMOJIS.done);
  });
});
