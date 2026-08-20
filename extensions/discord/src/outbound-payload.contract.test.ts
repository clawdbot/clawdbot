// Discord tests cover outbound payload.contract plugin behavior.
import {
  installChannelOutboundPayloadContractSuite,
  primeChannelOutboundSendMock,
  type OutboundPayloadHarnessParams,
} from "openclaw/plugin-sdk/channel-contract-testing";
import { describe, expect, it, vi } from "vitest";
import { DiscordError, RateLimitError } from "./internal/discord.js";
import { discordOutbound } from "./outbound-adapter.js";
import { recordDiscordMessageCreateAmbiguity } from "./retry.js";

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

describe("Discord voice fallback delivery safety", () => {
  function runVoicePayload(
    error: unknown,
    options: { deliveredText?: boolean; messageCreateAmbiguous?: boolean } = {},
  ) {
    const voiceDelivery = vi.fn(async () => {
      if (options.messageCreateAmbiguous) {
        recordDiscordMessageCreateAmbiguity(error);
      }
      throw error;
    });
    const textDelivery = vi.fn(async () => ({
      messageId: "fallback-text",
      channelId: "123456",
    }));
    const sendPayload = requireDiscordSendPayload();
    const promise = sendPayload({
      cfg: {},
      to: "channel:123456",
      text: "",
      payload: {
        ...(options.deliveredText
          ? { ttsSupplement: { spokenText: "answer", visibleTextAlreadyDelivered: true } }
          : { text: "answer" }),
        mediaUrls: ["https://example.test/voice.ogg"],
        audioAsVoice: true,
      },
      deps: {
        discord: textDelivery,
        discordVoice: voiceDelivery,
      },
    });
    return { promise, textDelivery, voiceDelivery };
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
  ])("preserves text fallback when $label", async ({ error }) => {
    const { promise, textDelivery, voiceDelivery } = runVoicePayload(error);

    await expect(promise).resolves.toMatchObject({ messageId: "fallback-text" });
    expect(voiceDelivery).toHaveBeenCalledOnce();
    expect(textDelivery).toHaveBeenCalledOnce();
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
  ])("retains the text fallback after $label", async ({ error }) => {
    const { promise, textDelivery, voiceDelivery } = runVoicePayload(error);

    await expect(promise).resolves.toMatchObject({ messageId: "fallback-text" });
    expect(voiceDelivery).toHaveBeenCalledOnce();
    expect(textDelivery).toHaveBeenCalledWith(
      "channel:123456",
      "answer",
      expect.objectContaining({ cfg: {} }),
    );
  });

  it("keeps an existing transcript when an audio encoder fails before voice delivery", async () => {
    const { promise, textDelivery, voiceDelivery } = runVoicePayload(
      new Error("ffmpeg unavailable"),
      {
        deliveredText: true,
      },
    );

    await expect(promise).resolves.toMatchObject({ messageId: "" });
    expect(voiceDelivery).toHaveBeenCalledOnce();
    expect(textDelivery).not.toHaveBeenCalled();
  });
});
