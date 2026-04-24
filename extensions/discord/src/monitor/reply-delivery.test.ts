import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __testing as threadBindingTesting,
  createThreadBindingManager,
} from "./thread-bindings.js";

const sendMessageDiscordMock = vi.hoisted(() => vi.fn());
const sendVoiceMessageDiscordMock = vi.hoisted(() => vi.fn());
const sendWebhookMessageDiscordMock = vi.hoisted(() => vi.fn());
const sendDiscordTextMock = vi.hoisted(() => vi.fn());
const buildDiscordSendErrorMock = vi.hoisted(() =>
  vi.fn<(err: unknown, ctx?: unknown) => Promise<unknown>>(async (err: unknown) => err),
);
const retryAsyncMock = vi.hoisted(() =>
  vi.fn(
    async (
      fn: () => Promise<unknown>,
      opts?: {
        attempts?: number;
        shouldRetry?: (err: unknown) => boolean;
      },
    ) => {
      const attempts = Math.max(1, opts?.attempts ?? 1);
      let lastError: unknown;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          return await fn();
        } catch (error) {
          lastError = error;
          if (attempt >= attempts || opts?.shouldRetry?.(error) === false) {
            throw error;
          }
        }
      }
      throw lastError;
    },
  ),
);

vi.mock("../send.js", async () => {
  const actual = await vi.importActual<typeof import("../send.js")>("../send.js");
  return {
    ...actual,
    sendMessageDiscord: (...args: unknown[]) => sendMessageDiscordMock(...args),
    sendVoiceMessageDiscord: (...args: unknown[]) => sendVoiceMessageDiscordMock(...args),
    sendWebhookMessageDiscord: (...args: unknown[]) => sendWebhookMessageDiscordMock(...args),
  };
});

vi.mock("../send.shared.js", () => ({
  buildDiscordSendError: (err: unknown, ctx: unknown) => buildDiscordSendErrorMock(err, ctx),
  sendDiscordText: (...args: unknown[]) => sendDiscordTextMock(...args),
}));

vi.mock("openclaw/plugin-sdk/retry-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/retry-runtime")>(
    "openclaw/plugin-sdk/retry-runtime",
  );
  return {
    ...actual,
    retryAsync: retryAsyncMock,
  };
});

let deliverDiscordReply: typeof import("./reply-delivery.js").deliverDiscordReply;

describe("deliverDiscordReply", () => {
  const runtime = {} as RuntimeEnv;
  const cfg = {
    channels: { discord: { token: "test-token" } },
  } as OpenClawConfig;
  const expectBotSendRetrySuccess = async (status: number, message: string) => {
    sendMessageDiscordMock
      .mockRejectedValueOnce(Object.assign(new Error(message), { status }))
      .mockResolvedValueOnce({ messageId: "msg-1", channelId: "channel-1" });

    await deliverDiscordReply({
      replies: [{ text: "retry me" }],
      target: "channel:123",
      token: "token",
      runtime,
      cfg,
      textLimit: 2000,
    });

    expect(sendMessageDiscordMock).toHaveBeenCalledTimes(2);
  };
  const createBoundThreadBindings = async (
    overrides: Partial<{
      threadId: string;
      channelId: string;
      targetSessionKey: string;
      agentId: string;
      label: string;
      webhookId: string;
      webhookToken: string;
      introText: string;
    }> = {},
  ) => {
    const threadBindings = createThreadBindingManager({
      accountId: "default",
      persist: false,
      enableSweeper: false,
    });
    await threadBindings.bindTarget({
      threadId: "thread-1",
      channelId: "parent-1",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:child",
      agentId: "main",
      webhookId: "wh_1",
      webhookToken: "tok_1",
      introText: "",
      ...overrides,
    });
    return threadBindings;
  };

  beforeAll(async () => {
    ({ deliverDiscordReply } = await import("./reply-delivery.js"));
  });

  beforeEach(() => {
    sendMessageDiscordMock.mockClear().mockResolvedValue({
      messageId: "msg-1",
      channelId: "channel-1",
    });
    sendVoiceMessageDiscordMock.mockClear().mockResolvedValue({
      messageId: "voice-1",
      channelId: "channel-1",
    });
    sendWebhookMessageDiscordMock.mockClear().mockResolvedValue({
      messageId: "webhook-1",
      channelId: "thread-1",
    });
    sendDiscordTextMock.mockClear().mockResolvedValue({
      id: "msg-direct-1",
      channel_id: "channel-1",
    });
    buildDiscordSendErrorMock.mockClear().mockImplementation(async (err: unknown) => err);
    retryAsyncMock.mockClear();
    threadBindingTesting.resetThreadBindingsForTests();
  });

  it("routes audioAsVoice payloads through the voice API and sends text separately", async () => {
    await deliverDiscordReply({
      replies: [
        {
          text: "Hello there",
          mediaUrls: ["https://example.com/voice.ogg", "https://example.com/extra.mp3"],
          audioAsVoice: true,
        },
      ],
      target: "channel:123",
      token: "token",
      runtime,
      cfg,
      textLimit: 2000,
      replyToId: "reply-1",
    });

    expect(sendVoiceMessageDiscordMock).toHaveBeenCalledTimes(1);
    expect(sendVoiceMessageDiscordMock).toHaveBeenCalledWith(
      "channel:123",
      "https://example.com/voice.ogg",
      expect.objectContaining({ token: "token", replyTo: "reply-1" }),
    );

    expect(sendMessageDiscordMock).toHaveBeenCalledTimes(2);
    expect(sendMessageDiscordMock).toHaveBeenNthCalledWith(
      1,
      "channel:123",
      "Hello there",
      expect.objectContaining({ token: "token", replyTo: "reply-1" }),
    );
    expect(sendMessageDiscordMock).toHaveBeenNthCalledWith(
      2,
      "channel:123",
      "",
      expect.objectContaining({
        token: "token",
        mediaUrl: "https://example.com/extra.mp3",
        replyTo: "reply-1",
      }),
    );
  });

  it("skips follow-up text when the voice payload text is blank", async () => {
    await deliverDiscordReply({
      replies: [
        {
          text: "   ",
          mediaUrl: "https://example.com/voice.ogg",
          audioAsVoice: true,
        },
      ],
      target: "channel:456",
      token: "token",
      runtime,
      cfg,
      textLimit: 2000,
    });

    expect(sendVoiceMessageDiscordMock).toHaveBeenCalledTimes(1);
    expect(sendMessageDiscordMock).not.toHaveBeenCalled();
  });

  it("passes mediaLocalRoots through media sends", async () => {
    const mediaLocalRoots = ["/tmp/workspace-agent"] as const;
    await deliverDiscordReply({
      replies: [
        {
          text: "Media reply",
          mediaUrls: ["https://example.com/first.png", "https://example.com/second.png"],
        },
      ],
      target: "channel:654",
      token: "token",
      runtime,
      cfg,
      textLimit: 2000,
      mediaLocalRoots,
    });

    expect(sendMessageDiscordMock).toHaveBeenCalledTimes(2);
    expect(sendMessageDiscordMock).toHaveBeenNthCalledWith(
      1,
      "channel:654",
      "Media reply",
      expect.objectContaining({
        token: "token",
        mediaUrl: "https://example.com/first.png",
        mediaLocalRoots,
      }),
    );
    expect(sendMessageDiscordMock).toHaveBeenNthCalledWith(
      2,
      "channel:654",
      "",
      expect.objectContaining({
        token: "token",
        mediaUrl: "https://example.com/second.png",
        mediaLocalRoots,
      }),
    );
  });

  it("sends text first and videos as a separate media-only follow-up", async () => {
    await deliverDiscordReply({
      replies: [
        {
          text: "done — i kicked off a 5s Molty clip",
          mediaUrls: ["/tmp/molty.mp4"],
        },
      ],
      target: "channel:654",
      token: "token",
      runtime,
      cfg,
      textLimit: 2000,
      replyToId: "reply-1",
    });

    expect(sendMessageDiscordMock).toHaveBeenCalledTimes(2);
    expect(sendMessageDiscordMock).toHaveBeenNthCalledWith(
      1,
      "channel:654",
      "done — i kicked off a 5s Molty clip",
      expect.objectContaining({
        token: "token",
        replyTo: "reply-1",
      }),
    );
    expect(sendMessageDiscordMock).toHaveBeenNthCalledWith(
      2,
      "channel:654",
      "",
      expect.objectContaining({
        token: "token",
        mediaUrl: "/tmp/molty.mp4",
        replyTo: "reply-1",
      }),
    );
  });

  it("forwards cfg to Discord send helpers", async () => {
    await deliverDiscordReply({
      replies: [{ text: "cfg path" }],
      target: "channel:101",
      token: "token",
      runtime,
      cfg,
      textLimit: 2000,
    });

    expect(sendMessageDiscordMock).toHaveBeenCalledWith(
      "channel:101",
      "cfg path",
      expect.objectContaining({ cfg }),
    );
  });

  it("honors payload reply targets even when replyToMode is off", async () => {
    await deliverDiscordReply({
      replies: [
        {
          text: "explicit reply",
          replyToId: "reply-explicit-1",
          replyToTag: true,
          replyToCurrent: true,
        },
      ],
      target: "channel:202",
      token: "token",
      runtime,
      cfg,
      textLimit: 2000,
      replyToMode: "off",
    });

    expect(sendMessageDiscordMock).toHaveBeenCalledWith(
      "channel:202",
      "explicit reply",
      expect.objectContaining({ replyTo: "reply-explicit-1" }),
    );
  });

  it.each(["first", "batched"] as const)(
    "uses replyToId only for the first chunk when replyToMode is %s",
    async (replyToMode) => {
      await deliverDiscordReply({
        replies: [
          {
            text: "1234567890",
          },
        ],
        target: "channel:789",
        token: "token",
        runtime,
        cfg,
        textLimit: 5,
        replyToId: "reply-1",
        replyToMode,
      });

      expect(sendMessageDiscordMock).toHaveBeenCalledTimes(2);
      expect(sendMessageDiscordMock.mock.calls).toEqual([
        expect.arrayContaining([
          "channel:789",
          "12345",
          expect.objectContaining({ replyTo: "reply-1" }),
        ]),
        expect.arrayContaining([
          "channel:789",
          "67890",
          expect.not.objectContaining({ replyTo: expect.anything() }),
        ]),
      ]);
    },
  );

  it("does not consume replyToId for replyToMode=first on whitespace-only payloads", async () => {
    await deliverDiscordReply({
      replies: [{ text: "   " }, { text: "actual reply" }],
      target: "channel:789",
      token: "token",
      runtime,
      cfg,
      textLimit: 2000,
      replyToId: "reply-1",
      replyToMode: "first",
    });

    expect(sendMessageDiscordMock).toHaveBeenCalledTimes(1);
    expect(sendMessageDiscordMock).toHaveBeenCalledWith(
      "channel:789",
      "actual reply",
      expect.objectContaining({ token: "token", replyTo: "reply-1" }),
    );
  });

  it("preserves leading whitespace in delivered text chunks", async () => {
    await deliverDiscordReply({
      replies: [{ text: "  leading text" }],
      target: "channel:789",
      token: "token",
      runtime,
      cfg,
      textLimit: 2000,
    });

    expect(sendMessageDiscordMock).toHaveBeenCalledTimes(1);
    expect(sendMessageDiscordMock).toHaveBeenCalledWith(
      "channel:789",
      "  leading text",
      expect.objectContaining({ token: "token" }),
    );
  });

  it("sends text chunks in order via sendDiscordText when rest is provided", async () => {
    const fakeRest = {} as import("@buape/carbon").RequestClient;
    const callOrder: string[] = [];
    sendDiscordTextMock.mockImplementation(
      async (_rest: unknown, _channelId: unknown, text: string) => {
        callOrder.push(text);
        return { id: `msg-${callOrder.length}`, channel_id: "789" };
      },
    );

    await deliverDiscordReply({
      replies: [{ text: "1234567890" }],
      target: "channel:789",
      token: "token",
      rest: fakeRest,
      runtime,
      cfg,
      textLimit: 5,
    });

    expect(sendMessageDiscordMock).not.toHaveBeenCalled();
    expect(sendDiscordTextMock).toHaveBeenCalledTimes(2);
    expect(callOrder).toEqual(["12345", "67890"]);
    expect(sendDiscordTextMock.mock.calls[0]?.[1]).toBe("789");
    expect(sendDiscordTextMock.mock.calls[1]?.[1]).toBe("789");
  });

  it("passes maxLinesPerMessage and chunkMode through the fast path", async () => {
    const fakeRest = {} as import("@buape/carbon").RequestClient;

    await deliverDiscordReply({
      replies: [{ text: Array.from({ length: 18 }, (_, index) => `line ${index + 1}`).join("\n") }],
      target: "channel:789",
      token: "token",
      rest: fakeRest,
      runtime,
      cfg,
      textLimit: 2000,
      maxLinesPerMessage: 120,
      chunkMode: "newline",
    });

    expect(sendMessageDiscordMock).not.toHaveBeenCalled();
    expect(sendDiscordTextMock).toHaveBeenCalledTimes(1);
    const firstSendDiscordTextCall = sendDiscordTextMock.mock.calls[0];
    const [, , , , , maxLinesPerMessageArg, , , chunkModeArg] = firstSendDiscordTextCall ?? [];

    expect(maxLinesPerMessageArg).toBe(120);
    expect(chunkModeArg).toBe("newline");
  });

  it("falls back to sendMessageDiscord when rest is not provided", async () => {
    await deliverDiscordReply({
      replies: [{ text: "single chunk" }],
      target: "channel:789",
      token: "token",
      runtime,
      cfg,
      textLimit: 2000,
    });

    expect(sendMessageDiscordMock).toHaveBeenCalledTimes(1);
    expect(sendDiscordTextMock).not.toHaveBeenCalled();
  });

  it("retries bot send on 429 rate limit then succeeds", async () => {
    await expectBotSendRetrySuccess(429, "rate limited");
  });

  it("retries bot send on 500 server error then succeeds", async () => {
    await expectBotSendRetrySuccess(500, "internal");
  });

  it("does not retry on 4xx client errors", async () => {
    const clientErr = Object.assign(new Error("bad request"), { status: 400 });
    sendMessageDiscordMock.mockRejectedValueOnce(clientErr);

    await expect(
      deliverDiscordReply({
        replies: [{ text: "fail" }],
        target: "channel:123",
        token: "token",
        runtime,
        cfg,
        textLimit: 2000,
      }),
    ).rejects.toThrow("bad request");

    expect(sendMessageDiscordMock).toHaveBeenCalledTimes(1);
  });

  it("wraps direct REST permission errors with channel context", async () => {
    const apiErr = Object.assign(new Error("Missing Permissions"), {
      code: 50013,
      status: 403,
    });
    const wrappedErr = new Error(
      "discord missing permissions in channel 789; permission probe did not identify missing ViewChannel/SendMessages (code=50013 status=403)",
    );
    sendDiscordTextMock.mockRejectedValueOnce(apiErr);
    buildDiscordSendErrorMock.mockResolvedValueOnce(wrappedErr);

    const fakeRest = {
      post: vi.fn(),
      get: vi.fn(),
    } as unknown as import("@buape/carbon").RequestClient;

    await expect(
      deliverDiscordReply({
        replies: [{ text: "fail" }],
        target: "channel:789",
        token: "token",
        rest: fakeRest,
        runtime,
        cfg,
        textLimit: 2000,
      }),
    ).rejects.toThrow("discord missing permissions in channel 789");

    expect(buildDiscordSendErrorMock).toHaveBeenCalledWith(
      apiErr,
      expect.objectContaining({ channelId: "789", hasMedia: false }),
    );
  });

  it("throws after exhausting retry attempts", async () => {
    const rateLimitErr = Object.assign(new Error("rate limited"), { status: 429 });
    sendMessageDiscordMock.mockRejectedValue(rateLimitErr);

    await expect(
      deliverDiscordReply({
        replies: [{ text: "persistent failure" }],
        target: "channel:123",
        token: "token",
        runtime,
        cfg,
        textLimit: 2000,
      }),
    ).rejects.toThrow("rate limited");

    expect(sendMessageDiscordMock).toHaveBeenCalledTimes(3);
  });

  it("delivers remaining chunks after a mid-sequence retry", async () => {
    sendMessageDiscordMock
      .mockResolvedValueOnce({ messageId: "c1" })
      .mockRejectedValueOnce(Object.assign(new Error("rate limited"), { status: 429 }))
      .mockResolvedValueOnce({ messageId: "c2-retry" })
      .mockResolvedValueOnce({ messageId: "c3" });

    await deliverDiscordReply({
      replies: [{ text: "A".repeat(6) }],
      target: "channel:123",
      token: "token",
      runtime,
      cfg,
      textLimit: 2,
    });

    expect(sendMessageDiscordMock).toHaveBeenCalledTimes(4);
  });

  it("sends bound-session text replies through webhook delivery", async () => {
    const threadBindings = await createBoundThreadBindings({ label: "codex-refactor" });

    await deliverDiscordReply({
      replies: [{ text: "Hello from subagent" }],
      target: "channel:thread-1",
      token: "token",
      runtime,
      cfg,
      textLimit: 2000,
      replyToId: "reply-1",
      sessionKey: "agent:main:subagent:child",
      threadBindings,
    });

    expect(sendWebhookMessageDiscordMock).toHaveBeenCalledTimes(1);
    expect(sendWebhookMessageDiscordMock).toHaveBeenCalledWith(
      "Hello from subagent",
      expect.objectContaining({
        cfg,
        webhookId: "wh_1",
        webhookToken: "tok_1",
        accountId: "default",
        threadId: "thread-1",
        replyTo: "reply-1",
      }),
    );
    expect(sendMessageDiscordMock).not.toHaveBeenCalled();
  });

  it("touches bound-thread activity after outbound delivery", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));
      const threadBindings = await createBoundThreadBindings();
      vi.setSystemTime(new Date("2026-02-20T00:02:00.000Z"));

      await deliverDiscordReply({
        replies: [{ text: "Activity ping" }],
        target: "channel:thread-1",
        token: "token",
        runtime,
        cfg,
        textLimit: 2000,
        sessionKey: "agent:main:subagent:child",
        threadBindings,
      });

      expect(threadBindings.getByThreadId("thread-1")?.lastActivityAt).toBe(
        new Date("2026-02-20T00:02:00.000Z").getTime(),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to bot send when webhook delivery fails", async () => {
    const threadBindings = await createBoundThreadBindings();
    sendWebhookMessageDiscordMock.mockRejectedValueOnce(new Error("rate limited"));

    await deliverDiscordReply({
      replies: [{ text: "Fallback path" }],
      target: "channel:thread-1",
      token: "token",
      accountId: "default",
      runtime,
      cfg,
      textLimit: 2000,
      sessionKey: "agent:main:subagent:child",
      threadBindings,
    });

    expect(sendWebhookMessageDiscordMock).toHaveBeenCalledTimes(1);
    expect(sendWebhookMessageDiscordMock.mock.calls[0]?.[1]?.cfg).toBe(cfg);
    expect(sendMessageDiscordMock).toHaveBeenCalledTimes(1);
    expect(sendMessageDiscordMock).toHaveBeenCalledWith(
      "channel:thread-1",
      "Fallback path",
      expect.objectContaining({ token: "token", accountId: "default" }),
    );
  });

  it("does not use thread webhook when outbound target is not a bound thread", async () => {
    const threadBindings = await createBoundThreadBindings();

    await deliverDiscordReply({
      replies: [{ text: "Parent channel delivery" }],
      target: "channel:parent-1",
      token: "token",
      accountId: "default",
      runtime,
      cfg,
      textLimit: 2000,
      sessionKey: "agent:main:subagent:child",
      threadBindings,
    });

    expect(sendWebhookMessageDiscordMock).not.toHaveBeenCalled();
    expect(sendMessageDiscordMock).toHaveBeenCalledTimes(1);
    expect(sendMessageDiscordMock).toHaveBeenCalledWith(
      "channel:parent-1",
      "Parent channel delivery",
      expect.objectContaining({ token: "token", accountId: "default" }),
    );
  });
});
