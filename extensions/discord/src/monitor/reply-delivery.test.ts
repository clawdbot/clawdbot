import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestClient } from "../internal/discord.js";

const deliverOutboundPayloadsMock = vi.hoisted(() => vi.fn(async () => []));
const sendMessageDiscordMock = vi.hoisted(() => vi.fn());
const sendVoiceMessageDiscordMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/outbound-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/outbound-runtime")>(
    "openclaw/plugin-sdk/outbound-runtime",
  );
  return {
    ...actual,
    deliverOutboundPayloads: deliverOutboundPayloadsMock,
  };
});

vi.mock("../send.js", async () => {
  const actual = await vi.importActual<typeof import("../send.js")>("../send.js");
  return {
    ...actual,
    sendMessageDiscord: (...args: unknown[]) => sendMessageDiscordMock(...args),
    sendVoiceMessageDiscord: (...args: unknown[]) => sendVoiceMessageDiscordMock(...args),
  };
});

let deliverDiscordReply: typeof import("./reply-delivery.js").deliverDiscordReply;

function firstDeliverParams() {
  const calls = deliverOutboundPayloadsMock.mock.calls as unknown as Array<
    [
      {
        cfg?: OpenClawConfig;
        formatting?: unknown;
        deps?: Record<string, (...args: unknown[]) => Promise<unknown>>;
      },
    ]
  >;
  const params = calls[0]?.[0];
  if (!params) {
    throw new Error("deliverOutboundPayloads was not called");
  }
  return params;
}

describe("deliverDiscordReply", () => {
  const runtime = {} as RuntimeEnv;
  const cfg = {
    channels: { discord: { token: "test-token" } },
  } as OpenClawConfig;

  beforeAll(async () => {
    ({ deliverDiscordReply } = await import("./reply-delivery.js"));
  });

  beforeEach(() => {
    deliverOutboundPayloadsMock.mockClear();
    deliverOutboundPayloadsMock.mockResolvedValue([]);
    sendMessageDiscordMock.mockReset().mockResolvedValue({
      messageId: "msg-1",
      channelId: "channel-1",
    });
    sendVoiceMessageDiscordMock.mockReset().mockResolvedValue({
      messageId: "voice-1",
      channelId: "channel-1",
    });
  });

  it("bridges regular replies to shared outbound with Discord package deps", async () => {
    const rest = {} as RequestClient;
    const replies = [{ text: "shared path" }];

    await deliverDiscordReply({
      replies,
      target: "channel:101",
      token: "token",
      accountId: "default",
      rest,
      runtime,
      cfg,
      textLimit: 2000,
      replyToId: "reply-1",
      replyToMode: "all",
    });

    expect(deliverOutboundPayloadsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "discord",
        to: "channel:101",
        accountId: "default",
        payloads: replies,
        replyToId: "reply-1",
        replyToMode: "all",
      }),
    );

    const deps = firstDeliverParams().deps!;
    await deps.discord("channel:101", "probe", { verbose: false });
    expect(sendMessageDiscordMock).toHaveBeenCalledWith(
      "channel:101",
      "probe",
      expect.objectContaining({ cfg: firstDeliverParams().cfg, token: "token", rest }),
    );
  });

  it("passes resolved Discord formatting options as explicit delivery options", async () => {
    const baseCfg = {
      channels: {
        discord: {
          token: "test-token",
          markdown: { tables: "code" },
          accounts: {
            default: {
              token: "account-token",
              maxLinesPerMessage: 99,
              streaming: { chunkMode: "length" },
            },
          },
        },
      },
    } as OpenClawConfig;

    await deliverDiscordReply({
      replies: [{ text: "formatted" }],
      target: "channel:101",
      token: "token",
      accountId: "default",
      runtime,
      cfg: baseCfg,
      textLimit: 1234,
      maxLinesPerMessage: 7,
      tableMode: "off",
      chunkMode: "newline",
    });

    expect(firstDeliverParams().cfg).toBe(baseCfg);
    expect(firstDeliverParams().formatting).toEqual({
      textLimit: 1234,
      maxLinesPerMessage: 7,
      tableMode: "off",
      chunkMode: "newline",
    });
  });

  it("passes media roots and explicit off-mode payload reply tags to shared outbound", async () => {
    const replies = [
      {
        text: "explicit reply",
        replyToId: "reply-explicit-1",
        replyToTag: true,
      },
    ];

    await deliverDiscordReply({
      replies,
      target: "channel:202",
      token: "token",
      runtime,
      cfg,
      textLimit: 2000,
      replyToMode: "off",
      mediaLocalRoots: ["/tmp/openclaw-media"],
    });

    expect(deliverOutboundPayloadsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payloads: replies,
        replyToId: undefined,
        replyToMode: "off",
        mediaAccess: { localRoots: ["/tmp/openclaw-media"] },
      }),
    );
  });

  it("bridges Discord voice sends through the outbound dependency bag", async () => {
    await deliverDiscordReply({
      replies: [{ text: "voice", mediaUrl: "https://example.com/voice.ogg", audioAsVoice: true }],
      target: "channel:123",
      token: "token",
      runtime,
      cfg,
      textLimit: 2000,
      replyToId: "reply-1",
    });

    const deps = firstDeliverParams().deps!;
    await deps.discordVoice("channel:123", "https://example.com/voice.ogg", {
      cfg,
      replyTo: "reply-1",
    });

    expect(sendVoiceMessageDiscordMock).toHaveBeenCalledWith(
      "channel:123",
      "https://example.com/voice.ogg",
      expect.objectContaining({ cfg, token: "token", replyTo: "reply-1" }),
    );
  });

  it("rewrites bound thread replies to parent target plus thread id and persona", async () => {
    const threadBindings = {
      listBySessionKey: vi.fn(() => [
        {
          accountId: "default",
          channelId: "parent-1",
          threadId: "thread-1",
          targetSessionKey: "agent:main:subagent:child",
          agentId: "main",
          label: "child",
          webhookId: "wh_1",
          webhookToken: "tok_1",
        },
      ]),
      touchThread: vi.fn(),
    };

    await deliverDiscordReply({
      replies: [{ text: "Hello from subagent" }],
      target: "channel:thread-1",
      token: "token",
      accountId: "default",
      runtime,
      cfg,
      textLimit: 2000,
      replyToId: "reply-1",
      sessionKey: "agent:main:subagent:child",
      threadBindings,
    });

    expect(deliverOutboundPayloadsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "channel:parent-1",
        threadId: "thread-1",
        replyToId: "reply-1",
        identity: expect.objectContaining({ name: "🤖 child" }),
        session: expect.objectContaining({
          key: "agent:main:subagent:child",
          agentId: "main",
        }),
      }),
    );
  });
});
