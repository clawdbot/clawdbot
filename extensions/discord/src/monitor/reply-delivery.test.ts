import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestClient } from "../internal/discord.js";

const sendDurableMessageBatchMock = vi.hoisted(() =>
  vi.fn(async () => ({
    status: "sent" as const,
    results: [{ messageId: "msg-1", channelId: "channel-1" }],
  })),
);
const sendMessageDiscordMock = vi.hoisted(() => vi.fn());
const sendVoiceMessageDiscordMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/channel-message", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/channel-message")>(
    "openclaw/plugin-sdk/channel-message",
  );
  return {
    ...actual,
    sendDurableMessageBatch: sendDurableMessageBatchMock,
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

type DeliverParams = Record<string, unknown> & {
  cfg?: OpenClawConfig;
  formatting?: unknown;
  deps?: Record<string, (...args: unknown[]) => Promise<unknown>>;
};

function firstDeliverParams() {
  const calls = sendDurableMessageBatchMock.mock.calls as unknown as Array<[DeliverParams]>;
  const params = calls[0]?.[0];
  if (!params) {
    throw new Error("sendDurableMessageBatch was not called");
  }
  return params;
}

function recordField(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${field} to be an object`);
  }
  return value as Record<string, unknown>;
}

function objectArgAt(
  mock: { mock: { calls: unknown[][] } },
  index: number,
): Record<string, unknown> {
  const value = mock.mock.calls[0]?.[index];
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected call argument ${index} to be an object`);
  }
  return value as Record<string, unknown>;
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
    sendDurableMessageBatchMock.mockClear();
    sendDurableMessageBatchMock.mockResolvedValue({
      status: "sent",
      results: [{ messageId: "msg-1", channelId: "channel-1" }],
    });
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

    const params = firstDeliverParams();
    expect(params.channel).toBe("discord");
    expect(params.to).toBe("channel:101");
    expect(params.accountId).toBe("default");
    expect(params.payloads).toEqual(replies);
    expect(params.replyToId).toBe("reply-1");
    expect(params.replyToMode).toBe("all");

    const deps = params.deps!;
    await deps.discord("channel:101", "probe", { verbose: false });
    expect(sendMessageDiscordMock.mock.calls[0]?.[0]).toBe("channel:101");
    expect(sendMessageDiscordMock.mock.calls[0]?.[1]).toBe("probe");
    const sendOptions = objectArgAt(sendMessageDiscordMock, 2);
    expect(sendOptions.cfg).toBe(params.cfg);
    expect(sendOptions.token).toBe("token");
    expect(sendOptions.rest).toBe(rest);
  });

  it("fails when shared outbound accepts a final reply but delivers no Discord message", async () => {
    sendDurableMessageBatchMock.mockResolvedValueOnce({ status: "sent", results: [] });

    await expect(
      deliverDiscordReply({
        replies: [{ text: "lost reply" }],
        target: "channel:101",
        token: "token",
        accountId: "default",
        runtime,
        cfg,
        textLimit: 2000,
      }),
    ).rejects.toThrow("discord final reply produced no delivered message for channel:101");
  });

  it("strips internal execution trace lines at the final Discord send boundary", async () => {
    await deliverDiscordReply({
      replies: [
        {
          text: [
            "📊 Session Status: current",
            "🛠️ run git status",
            "🛠️ `gh pr view`",
            "🛠️ `docker compose up`",
            "🛠️ elevated · `cd /tmp && pnpm test`",
            "🛠️ pty · `apply_patch update`",
            "📖 Read: lines 1-40 from secret.md",
            "Visible reply.",
          ].join("\n"),
        },
      ],
      target: "channel:101",
      token: "token",
      accountId: "default",
      runtime,
      cfg,
      textLimit: 2000,
    });

    expect(firstDeliverParams().payloads).toEqual([{ text: "Visible reply." }]);
  });

  it("drops pure internal trace text while preserving media-only delivery", async () => {
    await deliverDiscordReply({
      replies: [
        {
          text: "commentary: calling tool\nanalysis: inspect private state",
          mediaUrl: "https://example.com/result.png",
        },
      ],
      target: "channel:101",
      token: "token",
      accountId: "default",
      runtime,
      cfg,
      textLimit: 2000,
    });

    expect(firstDeliverParams().payloads).toEqual([
      { mediaUrl: "https://example.com/result.png", text: undefined },
    ]);
  });

  it("preserves component-only channelData payloads when text scrubs empty", async () => {
    const channelData = {
      discord: {
        components: [
          {
            type: 1,
            components: [
              {
                type: 2,
                style: 1,
                label: "Open",
                custom_id: "open",
              },
            ],
          },
        ],
      },
    };

    await deliverDiscordReply({
      replies: [
        {
          text: "analysis: internal only",
          channelData,
        },
      ],
      target: "channel:101",
      token: "token",
      accountId: "default",
      runtime,
      cfg,
      textLimit: 2000,
    });

    expect(firstDeliverParams().payloads).toEqual([{ channelData, text: undefined }]);
  });

  it("preserves presentation-only payloads when text scrubs empty", async () => {
    const presentation = {
      title: "Action required",
      blocks: [
        {
          type: "buttons" as const,
          buttons: [{ label: "Approve", value: "approve", style: "primary" as const }],
        },
      ],
    };

    await deliverDiscordReply({
      replies: [
        {
          text: "commentary: hidden",
          presentation,
        },
      ],
      target: "channel:101",
      token: "token",
      accountId: "default",
      runtime,
      cfg,
      textLimit: 2000,
    });

    expect(firstDeliverParams().payloads).toEqual([{ presentation, text: undefined }]);
  });

  it("does not strip ordinary code-fenced examples of tool-call labels", async () => {
    const text = ["Example:", "```", "🛠️ Exec: run ls", "```"].join("\n");

    await deliverDiscordReply({
      replies: [{ text }],
      target: "channel:101",
      token: "token",
      accountId: "default",
      runtime,
      cfg,
      textLimit: 2000,
    });

    expect(firstDeliverParams().payloads).toEqual([{ text }]);
  });

  it("does not strip ordinary visible labeled lines", async () => {
    const text = [
      "Command: restart the gateway",
      "Search: check recent Discord logs",
      "Open: the channel status page",
      "Find: the failing account",
    ].join("\n");

    await deliverDiscordReply({
      replies: [{ text }],
      target: "channel:101",
      token: "token",
      accountId: "default",
      runtime,
      cfg,
      textLimit: 2000,
    });

    expect(firstDeliverParams().payloads).toEqual([{ text }]);
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

    const params = firstDeliverParams();
    expect(params.payloads).toEqual(replies);
    expect(params.replyToId).toBeUndefined();
    expect(params.replyToMode).toBe("off");
    expect(params.mediaAccess).toEqual({ localRoots: ["/tmp/openclaw-media"] });
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

    expect(sendVoiceMessageDiscordMock.mock.calls[0]?.[0]).toBe("channel:123");
    expect(sendVoiceMessageDiscordMock.mock.calls[0]?.[1]).toBe("https://example.com/voice.ogg");
    const voiceOptions = objectArgAt(sendVoiceMessageDiscordMock, 2);
    expect(voiceOptions.cfg).toBe(cfg);
    expect(voiceOptions.token).toBe("token");
    expect(voiceOptions.replyTo).toBe("reply-1");
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

    const params = firstDeliverParams();
    expect(params.to).toBe("channel:parent-1");
    expect(params.threadId).toBe("thread-1");
    expect(params.replyToId).toBe("reply-1");
    expect(recordField(params.identity, "identity").name).toBe("🤖 child");
    const session = recordField(params.session, "session");
    expect(session.key).toBe("agent:main:subagent:child");
    expect(session.agentId).toBe("main");
  });
});
