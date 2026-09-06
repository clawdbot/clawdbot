// Discord tests cover outbound payload.contract plugin behavior.
import { ChannelType } from "discord-api-types/v10";
import {
  installChannelOutboundPayloadContractSuite,
  primeChannelOutboundSendMock,
  type OutboundPayloadHarnessParams,
} from "openclaw/plugin-sdk/channel-contract-testing";
import { describe, expect, it, vi } from "vitest";
import { DiscordError, RateLimitError, RequestClient } from "./internal/discord.js";
import { discordOutbound } from "./outbound-adapter.js";
import { recordDiscordMessageCreateAmbiguity } from "./retry.js";
import { sendMessageDiscord } from "./send.outbound.js";

type DiscordSendPayload = NonNullable<typeof discordOutbound.sendPayload>;

function requireDiscordSendPayload(): DiscordSendPayload {
  const sendPayload = discordOutbound.sendPayload;
  if (!sendPayload) {
    throw new Error("Expected Discord outbound sendPayload");
  }
  return sendPayload;
}

function createDiscordHarness(params: OutboundPayloadHarnessParams) {
  const sendDiscord = vi.fn();
  primeChannelOutboundSendMock(
    sendDiscord,
    { messageId: "dc-1", channelId: "123456" },
    params.sendResults,
  );
  const ctx = {
    cfg: {},
    to: "channel:123456",
    text: "",
    payload: params.payload,
    deps: {
      sendDiscord,
    },
  };
  const sendPayload = requireDiscordSendPayload();
  return {
    run: async () => await sendPayload(ctx),
    sendMock: sendDiscord,
    to: ctx.to,
  };
}

describe("Discord outbound payload contract", () => {
  installChannelOutboundPayloadContractSuite({
    channel: "discord",
    chunking: { mode: "split", longTextLength: 3000, maxChunkLength: 2000 },
    createHarness: createDiscordHarness,
  });
});

describe("Discord forum outbound payload ownership", () => {
  function createForumDelivery(params: {
    channelType?: ChannelType;
    channelData: Record<string, unknown>;
    threadId?: string;
    withProgress?: boolean;
    voiceError?: Error;
  }) {
    const requests: string[] = [];
    let threadCount = 0;
    let mediaCount = 0;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input : input.url,
      );
      const route = url.pathname.replace("/api/v10", "");
      const method = init?.method ?? "GET";
      requests.push(`${method} ${route}`);
      let response: Record<string, unknown>;
      if (method === "GET") {
        response = {
          type:
            route === "/channels/forum1"
              ? (params.channelType ?? ChannelType.GuildForum)
              : ChannelType.PublicThread,
        };
      } else if (route === "/channels/forum1/threads") {
        threadCount += 1;
        const threadId = `thread${threadCount}`;
        response = {
          id: threadId,
          message: { id: `starter${threadCount}`, channel_id: threadId },
        };
      } else {
        mediaCount += 1;
        response = { id: `media${mediaCount}`, channel_id: route.split("/")[2] };
      }
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const rest = new RequestClient("discord-fixture-token", { fetch, queueRequests: false });
    const readFile = vi.fn(async () => Buffer.from("forum attachment"));
    const mediaAccess = {
      localRoots: [process.cwd()],
      readFile,
      workspaceDir: process.cwd(),
    };
    const onDeliveryResult = vi.fn();
    const sendPayload = requireDiscordSendPayload();
    const voiceError = params.voiceError;
    const sendDiscord: typeof sendMessageDiscord = async (target, text, options) =>
      await sendMessageDiscord(target, text, {
        ...options,
        rest,
        token: "discord-fixture-token",
      });
    const run = () =>
      sendPayload({
        cfg: { channels: { discord: { token: "discord-fixture-token" } } },
        to: "channel:forum1",
        text: "",
        ...(params.threadId ? { threadId: params.threadId } : {}),
        payload: {
          text: "one forum conversation",
          mediaUrls: ["./package.json", "./package.json"],
          channelData: { discord: params.channelData },
          ...(params.voiceError ? { audioAsVoice: true } : {}),
        },
        mediaAccess,
        mediaLocalRoots: mediaAccess.localRoots,
        mediaReadFile: readFile,
        deps: {
          discord: sendDiscord,
          ...(voiceError
            ? {
                discordVoice: async () => {
                  throw voiceError;
                },
              }
            : {}),
        },
        ...(params.withProgress === false ? {} : { onDeliveryResult }),
      });
    return { fetch, onDeliveryResult, requests, run };
  }

  it.each([
    {
      label: "named forum attachments",
      channelData: { filename: "first.txt" },
    },
    {
      label: "embedded forum attachments",
      channelData: { embeds: [{ description: "forum embed" }] },
    },
    {
      label: "classic text components downgraded to forum messages",
      channelData: {
        presentationComponents: {
          text: "one forum conversation",
          blocks: [{ type: "text", text: "classic component body" }],
        },
      },
    },
    {
      label: "media-channel attachments without an external progress callback",
      channelData: { filename: "first.txt" },
      channelType: ChannelType.GuildMedia,
      withProgress: false,
    },
  ])("keeps $label and their complete receipt in their first created thread", async (params) => {
    const delivery = createForumDelivery(params);
    const globalFetch = vi.spyOn(globalThis, "fetch").mockImplementation(delivery.fetch);
    try {
      const result = await delivery.run();

      expect(delivery.requests.filter((request) => request.startsWith("POST"))).toEqual([
        "POST /channels/forum1/threads",
        "POST /channels/thread1/messages",
        "POST /channels/thread1/messages",
      ]);
      expect(result).toMatchObject({
        target: { kind: "channel", id: "thread1" },
        receipt: {
          threadId: "thread1",
          platformMessageIds: ["starter1", "media1", "media2"],
          primaryPlatformMessageId: "starter1",
        },
      });
      if (params.withProgress !== false) {
        expect(
          delivery.onDeliveryResult.mock.calls.map(([progressResult]) => progressResult.messageId),
        ).toEqual(["starter1", "media1", "media2"]);
      }
    } finally {
      globalFetch.mockRestore();
    }
  });

  it("keeps voice fallback text and remaining media together before reporting the voice error", async () => {
    const voiceError = new Error("fixture encoder unavailable");
    const delivery = createForumDelivery({ channelData: {}, voiceError });

    await expect(delivery.run()).rejects.toBe(voiceError);
    expect(delivery.requests.filter((request) => request.startsWith("POST"))).toEqual([
      "POST /channels/forum1/threads",
      "POST /channels/thread1/messages",
    ]);
    expect(delivery.onDeliveryResult.mock.calls.map(([result]) => result.messageId)).toEqual([
      "starter1",
      "media1",
    ]);
  });

  it.each([
    {
      label: "ordinary channels",
      channelType: ChannelType.GuildText,
      route: "POST /channels/forum1/messages",
    },
    {
      label: "explicit existing threads",
      threadId: "existing-thread",
      route: "POST /channels/existing-thread/messages",
    },
  ])("preserves direct attachment delivery for $label", async ({ route, ...params }) => {
    const delivery = createForumDelivery({ channelData: { filename: "first.txt" }, ...params });

    await delivery.run();

    expect(delivery.requests.filter((request) => request.startsWith("POST"))).toEqual([
      route,
      route,
    ]);
  });

  it("still rejects actual interactive components on a forum parent before creating a thread", async () => {
    const delivery = createForumDelivery({
      channelData: {
        presentationComponents: {
          text: "interactive message",
          blocks: [{ type: "actions", buttons: [] }],
        },
      },
    });
    const globalFetch = vi.spyOn(globalThis, "fetch").mockImplementation(delivery.fetch);
    try {
      await expect(delivery.run()).rejects.toThrow(
        "Discord components are not supported in forum-style channels",
      );
      expect(delivery.requests.filter((request) => request.startsWith("POST"))).toEqual([]);
    } finally {
      globalFetch.mockRestore();
    }
  });

  it.each([
    {
      label: "classic component overrides",
      components: { blocks: [{ type: "file", file: "attachment://declared.txt" }] },
    },
    {
      label: "matching Components V2 overrides",
      components: {
        container: { accentColor: 0x123456 },
        blocks: [{ type: "file", file: "attachment://first.txt" }],
      },
    },
  ])("applies $label only to the first media upload", async ({ components }) => {
    const delivery = createForumDelivery({
      channelType: ChannelType.GuildText,
      channelData: { components, filename: " first.txt " },
    });
    const globalFetch = vi.spyOn(globalThis, "fetch").mockImplementation(delivery.fetch);
    try {
      await delivery.run();

      const filenames = delivery.fetch.mock.calls.flatMap(([, init]) => {
        if (!(init?.body instanceof FormData)) {
          return [];
        }
        const file = init.body.get("files[0]");
        return file && typeof file !== "string" ? [file.name] : [];
      });
      expect(filenames).toEqual(["first.txt", "package.json"]);
    } finally {
      globalFetch.mockRestore();
    }
  });

  it("rejects a conflicting Components V2 filename before uploading", async () => {
    const delivery = createForumDelivery({
      channelType: ChannelType.GuildText,
      channelData: {
        filename: "other.txt",
        components: {
          container: { accentColor: 0x123456 },
          blocks: [{ type: "file", file: "attachment://declared.txt" }],
        },
      },
    });
    const globalFetch = vi.spyOn(globalThis, "fetch").mockImplementation(delivery.fetch);
    try {
      await expect(delivery.run()).rejects.toThrow(
        'Component file block expects attachment "declared.txt", but the uploaded file is "other.txt"',
      );
      expect(delivery.requests.filter((request) => request.startsWith("POST"))).toEqual([]);
    } finally {
      globalFetch.mockRestore();
    }
  });
});

describe("Discord voice fallback delivery safety", () => {
  function runVoicePayload(
    error: unknown,
    options: {
      additionalMedia?: boolean;
      additionalMediaFailure?: Error;
      deliveredText?: boolean;
      messageCreateAmbiguous?: boolean;
    } = {},
  ) {
    const onDeliveryResult = vi.fn();
    const voiceDelivery = vi.fn(async () => {
      if (options.messageCreateAmbiguous) {
        recordDiscordMessageCreateAmbiguity(error);
      }
      throw error;
    });
    let textDeliveryCalls = 0;
    const textDelivery = vi.fn(async (_to: string, _text: string, sendOptions?: unknown) => {
      const callIndex = textDeliveryCalls++;
      if (options.additionalMediaFailure && callIndex > 0) {
        throw options.additionalMediaFailure;
      }
      const result = {
        messageId: "fallback-text",
        channelId: "123456",
      };
      await (
        sendOptions as
          | { onDeliveryResult?: (deliveryResult: typeof result) => Promise<void> }
          | undefined
      )?.onDeliveryResult?.(result);
      return result;
    });
    const sendPayload = requireDiscordSendPayload();
    const promise = sendPayload({
      cfg: {},
      to: "channel:123456",
      text: "",
      payload: {
        ...(options.deliveredText
          ? { ttsSupplement: { spokenText: "answer", visibleTextAlreadyDelivered: true } }
          : { text: "answer" }),
        mediaUrls: [
          "https://example.test/voice.ogg",
          ...(options.additionalMedia ? ["https://example.test/remaining.png"] : []),
        ],
        audioAsVoice: true,
      },
      deps: {
        discord: textDelivery,
        discordVoice: voiceDelivery,
      },
      onDeliveryResult,
    });
    return { onDeliveryResult, promise, textDelivery, voiceDelivery };
  }

  it.each([
    {
      label: "a request timeout",
      error: Object.assign(new Error("voice create timed out"), { status: 408 }),
    },
    {
      label: "an actual Discord HTTP error",
      error: new DiscordError(new Response(null, { status: 502 }), {
        message: "voice create failed after acceptance",
      }),
    },
    {
      label: "a wrapped server error with a pre-connect cause",
      error: Object.assign(new Error("voice create failed after acceptance"), {
        status: 502,
        cause: Object.assign(new Error("proxy refused"), { code: "ECONNREFUSED" }),
      }),
    },
    {
      label: "a connection reset",
      error: Object.assign(new Error("voice create connection reset"), { code: "ECONNRESET" }),
    },
    {
      label: "an undici response body timeout",
      error: Object.assign(new Error("voice create response timed out"), {
        code: "UND_ERR_BODY_TIMEOUT",
      }),
    },
    {
      label: "a wrapped socket timeout",
      error: new Error("Discord voice request failed", {
        cause: Object.assign(new Error("socket timeout"), { code: "ETIMEDOUT" }),
      }),
    },
    {
      label: "an aborted request",
      error: Object.assign(new Error("voice request aborted"), { name: "AbortError" }),
    },
    {
      label: "an actual message-only fetch failure",
      error: new TypeError("fetch failed"),
    },
    {
      label: "a wrapped message-only fetch failure",
      error: new Error("Discord voice request failed", { cause: new TypeError("fetch failed") }),
    },
    ...[
      "network error",
      "NetworkError",
      "socket hang up",
      "bad gateway",
      "service unavailable",
      "temporarily unavailable",
      "timed out",
      "timeout",
      "connection closed",
      "connection reset",
      "connection refused",
    ].map((message) => ({
      label: `the existing Discord retry owner's message-only ${message} transport error`,
      error: new Error(message),
    })),
  ])("does not replay a potentially accepted voice message after $label", async ({ error }) => {
    const { promise, textDelivery, voiceDelivery } = runVoicePayload(error, {
      messageCreateAmbiguous: true,
    });

    await expect(promise).rejects.toBe(error);
    expect(voiceDelivery).toHaveBeenCalledOnce();
    expect(textDelivery).not.toHaveBeenCalled();
  });

  it("does not conceal an ambiguous voice failure behind an already-delivered transcript", async () => {
    const error = Object.assign(new Error("voice create failed after acceptance"), { status: 503 });
    const { promise, textDelivery, voiceDelivery } = runVoicePayload(error, {
      deliveredText: true,
      messageCreateAmbiguous: true,
    });

    await expect(promise).rejects.toBe(error);
    expect(voiceDelivery).toHaveBeenCalledOnce();
    expect(textDelivery).not.toHaveBeenCalled();
  });

  it("does not replay after an ambiguous create retry ends with a pre-connect failure", async () => {
    const error = Object.assign(new Error("final retry could not connect"), {
      code: "ECONNREFUSED",
    });
    const { promise, textDelivery, voiceDelivery } = runVoicePayload(error, {
      messageCreateAmbiguous: true,
    });

    await expect(promise).rejects.toBe(error);
    expect(voiceDelivery).toHaveBeenCalledOnce();
    expect(textDelivery).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "remote audio download failed with a server error",
      error: new DiscordError(new Response(null, { status: 503 }), {
        message: "audio source unavailable",
      }),
    },
    {
      label: "attachment negotiation failed before message creation",
      error: Object.assign(new Error("voice upload unavailable"), { status: 502 }),
    },
    {
      label: "the source fetch failed before message creation",
      error: new TypeError("fetch failed"),
    },
    {
      label: "voice preparation was aborted before message creation",
      error: Object.assign(new Error("audio source aborted"), { name: "AbortError" }),
    },
  ])("reports failure after preserving text fallback when $label", async ({ error }) => {
    const { onDeliveryResult, promise, textDelivery, voiceDelivery } = runVoicePayload(error);

    await expect(promise).rejects.toBe(error);
    expect(voiceDelivery).toHaveBeenCalledOnce();
    expect(textDelivery).toHaveBeenCalledOnce();
    expect(onDeliveryResult).toHaveBeenCalledOnce();
    expect(onDeliveryResult).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "discord", messageId: "fallback-text" }),
    );
  });

  it.each([
    {
      label: "an unavailable audio encoder",
      error: new Error("ffmpeg unavailable"),
    },
    {
      label: "a definitive voice rejection",
      error: Object.assign(new Error("voice payload rejected"), { status: 400 }),
    },
    {
      label: "an expired attachment",
      error: Object.assign(new Error("voice attachment not found"), { statusCode: 404 }),
    },
    {
      label: "a rate-limit rejection",
      error: new RateLimitError(new Response(null, { status: 429 }), {
        message: "voice create rate limited",
        retry_after: 1,
        global: false,
      }),
    },
    {
      label: "a pre-connect failure",
      error: Object.assign(new Error("voice connect refused"), { code: "ECONNREFUSED" }),
    },
    {
      label: "a wrapped DNS failure",
      error: new Error("voice connection failed", {
        cause: Object.assign(new Error("DNS lookup failed"), { code: "ENOTFOUND" }),
      }),
    },
    {
      label: "a fetch failure whose nested DNS error proves pre-connect rejection",
      error: new TypeError("fetch failed", {
        cause: Object.assign(new Error("DNS lookup failed"), { code: "ENOTFOUND" }),
      }),
    },
  ])("retains text progress before reporting $label", async ({ error }) => {
    const { onDeliveryResult, promise, textDelivery, voiceDelivery } = runVoicePayload(error);

    await expect(promise).rejects.toBe(error);
    expect(voiceDelivery).toHaveBeenCalledOnce();
    expect(textDelivery).toHaveBeenCalledWith(
      "channel:123456",
      "answer",
      expect.objectContaining({ cfg: {} }),
    );
    expect(onDeliveryResult).toHaveBeenCalledOnce();
    expect(onDeliveryResult).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "discord", messageId: "fallback-text" }),
    );
  });

  it("delivers remaining media before reporting a definitive voice failure", async () => {
    const error = new Error("ffmpeg unavailable");
    const { onDeliveryResult, promise, textDelivery, voiceDelivery } = runVoicePayload(error, {
      additionalMedia: true,
    });

    await expect(promise).rejects.toBe(error);
    expect(voiceDelivery).toHaveBeenCalledOnce();
    expect(textDelivery).toHaveBeenCalledTimes(2);
    expect(textDelivery).toHaveBeenNthCalledWith(
      2,
      "channel:123456",
      "",
      expect.objectContaining({ mediaUrl: "https://example.test/remaining.png" }),
    );
    expect(onDeliveryResult).toHaveBeenCalledTimes(2);
  });

  it("preserves the voice failure when a remaining media send also fails", async () => {
    const voiceError = new Error("ffmpeg unavailable");
    const remainingError = new Error("remaining media unavailable");
    const { promise, textDelivery, voiceDelivery } = runVoicePayload(voiceError, {
      additionalMedia: true,
      additionalMediaFailure: remainingError,
    });

    await expect(promise).rejects.toBe(voiceError);
    expect(voiceDelivery).toHaveBeenCalledOnce();
    expect(textDelivery).toHaveBeenCalledTimes(2);
    console.log(
      `discord-voice-partial-proof ${JSON.stringify({
        voiceAttempt: "failed",
        fallbackTextDelivered: true,
        remainingMediaAttempted: true,
        remainingMediaFailed: true,
        reportedError: "ffmpeg unavailable",
      })}`,
    );
  });

  it("keeps an existing transcript when an audio encoder fails before voice delivery", async () => {
    const error = new Error("ffmpeg unavailable");
    const { onDeliveryResult, promise, textDelivery, voiceDelivery } = runVoicePayload(error, {
      deliveredText: true,
    });

    await expect(promise).rejects.toBe(error);
    expect(voiceDelivery).toHaveBeenCalledOnce();
    expect(textDelivery).not.toHaveBeenCalled();
    expect(onDeliveryResult).not.toHaveBeenCalled();
  });
});
