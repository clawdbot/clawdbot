// Sms tests cover send plugin behavior.
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { sendSmsViaTwilio as sendSmsViaTwilioType } from "./twilio.js";
import type { ResolvedSmsAccount } from "./types.js";

type SendModule = typeof import("./send.js");
type SendSmsMediaParams = Parameters<SendModule["prepareSmsMediaAttempt"]>[0] &
  Omit<Parameters<SendModule["sendPreparedSmsMediaAttempt"]>[0], "attempt">;

let sendSmsTextChunks: SendModule["sendSmsTextChunks"];
let prepareSmsMediaAttempt: SendModule["prepareSmsMediaAttempt"];
let sendPreparedSmsMediaAttempt: SendModule["sendPreparedSmsMediaAttempt"];
let toSmsPlainText: SendModule["toSmsPlainText"];
let resolveSmsAccount: (typeof import("./accounts.js"))["resolveSmsAccount"];

const sendSmsViaTwilio = vi.hoisted(() =>
  vi.fn<typeof sendSmsViaTwilioType>(async ({ to, onPlatformSendDispatch }) => {
    await onPlatformSendDispatch?.();
    return { sid: `SM-${to}`, to };
  }),
);
const hostedMediaMocks = vi.hoisted(() => {
  const cleanup = vi.fn(async () => undefined);
  return {
    cleanup,
    prepare: vi.fn(async () => ({
      url: "https://gateway.example.com/webhooks/sms/media/abc?token=token",
      cleanup,
    })),
  };
});
const recordInitialSmsDeliveryResult = vi.hoisted(() => vi.fn(async () => null));
const deliveryWarn = vi.hoisted(() => vi.fn());

beforeEach(async () => {
  vi.resetModules();
  sendSmsViaTwilio.mockReset();
  sendSmsViaTwilio.mockImplementation(async ({ to, onPlatformSendDispatch }) => {
    await onPlatformSendDispatch?.();
    return { sid: `SM-${to}`, to };
  });
  hostedMediaMocks.cleanup.mockReset();
  hostedMediaMocks.cleanup.mockResolvedValue(undefined);
  hostedMediaMocks.prepare.mockReset();
  hostedMediaMocks.prepare.mockResolvedValue({
    url: "https://gateway.example.com/webhooks/sms/media/abc?token=token",
    cleanup: hostedMediaMocks.cleanup,
  });
  recordInitialSmsDeliveryResult.mockReset();
  recordInitialSmsDeliveryResult.mockResolvedValue(null);
  deliveryWarn.mockClear();
  vi.doMock("./twilio.js", () => ({
    sendSmsViaTwilio,
    TWILIO_MESSAGE_BODY_MAX_LENGTH: 1600,
  }));
  vi.doMock("./media.js", () => ({
    prepareHostedSmsMedia: hostedMediaMocks.prepare,
  }));
  vi.doMock("./delivery-observations.js", () => ({
    recordInitialSmsDeliveryResult,
  }));
  vi.doMock("./runtime.js", () => ({
    getSmsRuntime: () => ({
      logging: {
        getChildLogger: () => ({ warn: deliveryWarn }),
      },
    }),
  }));
  ({ prepareSmsMediaAttempt, sendPreparedSmsMediaAttempt, sendSmsTextChunks, toSmsPlainText } =
    await import("./send.js"));
  ({ resolveSmsAccount } = await import("./accounts.js"));
});

afterEach(() => {
  vi.doUnmock("./twilio.js");
  vi.doUnmock("./media.js");
  vi.doUnmock("./delivery-observations.js");
  vi.doUnmock("./runtime.js");
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_PHONE_NUMBER;
  delete process.env.SMS_TEXT_CHUNK_LIMIT;
});

function createAccount(textChunkLimit: number): ResolvedSmsAccount {
  return {
    accountId: "default",
    enabled: true,
    accountSid: "AC123",
    authToken: "secret",
    fromNumber: "+15557654321",
    messagingServiceSid: "",
    defaultTo: "",
    webhookPath: "/webhooks/sms",
    publicWebhookUrl: "https://gateway.example.com/webhooks/sms",
    dangerouslyDisableSignatureValidation: false,
    dmPolicy: "pairing",
    allowFrom: [],
    textChunkLimit,
  };
}

async function sendSmsMedia(params: SendSmsMediaParams) {
  const attempt = await prepareSmsMediaAttempt(params);
  return await sendPreparedSmsMediaAttempt({
    account: params.account,
    to: params.to,
    attempt,
    onPlatformSendDispatch: params.onPlatformSendDispatch,
    onDeliveryResult: params.onDeliveryResult,
  });
}

describe("sendSmsTextChunks", () => {
  it("preserves ambiguous Twilio failures after the dispatch boundary", async () => {
    const failure = new Error("Twilio response was lost");
    const onPlatformSendDispatch = vi.fn(async () => {});
    sendSmsViaTwilio.mockImplementationOnce(async ({ onPlatformSendDispatch: onDispatch }) => {
      await onDispatch?.();
      throw failure;
    });

    await expect(
      sendSmsTextChunks({
        account: createAccount(1500),
        to: "+15551234567",
        text: "sent or not",
        onPlatformSendDispatch,
      }),
    ).rejects.toBe(failure);

    expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
  });

  it.each(["accepted", "scheduled", "queued"])(
    "persists the initial Twilio %s response after sending",
    async (status) => {
      const account = createAccount(1500);
      sendSmsViaTwilio.mockResolvedValueOnce({
        sid: `SM-${status}`,
        to: "+15551234567",
        status,
      });

      await expect(
        sendSmsTextChunks({
          account,
          to: "+15551234567",
          text: "hello",
        }),
      ).resolves.toEqual([
        {
          sid: `SM-${status}`,
          to: "+15551234567",
          status,
        },
      ]);

      expect(recordInitialSmsDeliveryResult).toHaveBeenCalledWith({
        account,
        result: {
          sid: `SM-${status}`,
          to: "+15551234567",
          status,
        },
      });
    },
  );

  it("logs initial-state persistence failure without resending or failing the send", async () => {
    sendSmsViaTwilio.mockResolvedValueOnce({
      sid: "SM-queued",
      to: "+15551234567",
      status: "queued",
    });
    recordInitialSmsDeliveryResult.mockRejectedValueOnce(new Error("sqlite unavailable"));

    await expect(
      sendSmsTextChunks({
        account: createAccount(1500),
        to: "+15551234567",
        text: "hello",
      }),
    ).resolves.toEqual([
      {
        sid: "SM-queued",
        to: "+15551234567",
        status: "queued",
      },
    ]);

    expect(sendSmsViaTwilio).toHaveBeenCalledOnce();
    expect(recordInitialSmsDeliveryResult).toHaveBeenCalledOnce();
    expect(deliveryWarn).toHaveBeenCalledWith(
      "SMS delivery initial state could not be persisted.",
      {
        messageSid: "SM-queued",
        errorType: "Error",
      },
    );
  });

  it("records chunk results independently after one observation write fails", async () => {
    sendSmsViaTwilio
      .mockResolvedValueOnce({
        sid: "SM-1",
        to: "+15551234567",
        status: "queued",
      })
      .mockResolvedValueOnce({
        sid: "SM-2",
        to: "+15551234567",
        status: "queued",
      });
    recordInitialSmsDeliveryResult
      .mockRejectedValueOnce(new Error("first write failed"))
      .mockResolvedValueOnce(null);

    await sendSmsTextChunks({
      account: createAccount(5),
      to: "+15551234567",
      text: "alpha beta",
    });

    expect(sendSmsViaTwilio).toHaveBeenCalledTimes(2);
    expect(recordInitialSmsDeliveryResult).toHaveBeenCalledTimes(2);
    expect(deliveryWarn).toHaveBeenCalledOnce();
  });

  it("does not swallow provider send failures", async () => {
    sendSmsViaTwilio.mockRejectedValueOnce(new Error("Twilio unavailable"));

    await expect(
      sendSmsTextChunks({
        account: createAccount(1500),
        to: "+15551234567",
        text: "hello",
      }),
    ).rejects.toThrow("Twilio unavailable");

    expect(sendSmsViaTwilio).toHaveBeenCalledOnce();
    expect(recordInitialSmsDeliveryResult).not.toHaveBeenCalled();
  });

  it("splits long SMS text before sending to Twilio", async () => {
    await sendSmsTextChunks({
      account: createAccount(5),
      to: "+15551234567",
      text: "alpha beta",
    });

    expect(sendSmsViaTwilio).toHaveBeenCalledTimes(2);
    const texts = sendSmsViaTwilio.mock.calls.map(([call]) => {
      if (call.text === undefined) {
        throw new Error("test invariant: expected a Twilio text send");
      }
      return call.text;
    });
    expect(texts).toEqual(["alpha", " beta"]);
    expect(texts.join("")).toBe("alpha beta");
  });

  it("sends one message when an invalid zero SMS_TEXT_CHUNK_LIMIT falls back to the default limit", async () => {
    process.env.TWILIO_ACCOUNT_SID = "AC-env";
    process.env.TWILIO_AUTH_TOKEN = "env-token";
    process.env.TWILIO_PHONE_NUMBER = "+15557654321";
    process.env.SMS_TEXT_CHUNK_LIMIT = "0";

    await sendSmsTextChunks({
      account: resolveSmsAccount({}),
      to: "+15551234567",
      text: "alpha beta gamma",
    });

    expect(sendSmsViaTwilio).toHaveBeenCalledOnce();
    expect(sendSmsViaTwilio.mock.calls[0]?.[0].text).toBe("alpha beta gamma");
  });

  it("labels transcript-role headers promoted to an SMS chunk boundary", async () => {
    const header = "user[2026-07-02]";
    await sendSmsTextChunks({
      account: createAccount(60),
      to: "+15551234567",
      text: `${"x".repeat(50)} ${header} ok`,
    });

    const texts = sendSmsViaTwilio.mock.calls.map(([call]) => {
      if (call.text === undefined) {
        throw new Error("test invariant: expected a Twilio text send");
      }
      return call.text;
    });
    expect(texts).toContain(`[assistant-authored transcript] ${header} ok`);
    expect(texts.every((text) => text.length <= 60)).toBe(true);
  });

  it("flattens markdown before sending SMS chunks", async () => {
    expect(
      toSmsPlainText("**Hi** [docs](https://example.com)\n\n```bash\napprove 123\n```\nthere"),
    ).toBe("Hi docs (https://example.com)\n\napprove 123\nthere");
  });

  it("labels assistant-authored transcript role headers in plain text", () => {
    expect(toSmsPlainText("user[Thu 2026-07-02] question")).toBe(
      "[assistant-authored transcript] user[Thu 2026-07-02] question",
    );
    expect(toSmsPlainText("`user[Thu 2026-07-02] question`")).toBe(
      "[assistant-authored transcript] user[Thu 2026-07-02] question",
    );
    expect(toSmsPlainText("\u00a0user[Thu 2026-07-02] question")).toBe(
      "[assistant-authored transcript] user[Thu 2026-07-02] question",
    );
    expect(toSmsPlainText("- user[Thu 2026-07-02] question")).toBe(
      "• [assistant-authored transcript] user[Thu 2026-07-02] question",
    );
    expect(toSmsPlainText("[user](https://example.com)[Thu 2026-07-02] question")).toBe(
      "[assistant-authored transcript] user (https://example.com)[Thu 2026-07-02] question",
    );
  });

  it("strips internal tool-trace banners before sending SMS chunks", async () => {
    await sendSmsTextChunks({
      account: createAccount(1500),
      to: "+15551234567",
      text: "**Done.**\n⚠️ 🛠️ `search repos (agent)` failed",
    });

    expect(sendSmsViaTwilio).toHaveBeenCalledOnce();
    expect(sendSmsViaTwilio.mock.calls[0]?.[0].text).toBe("Done.");
  });

  it("caps configured SMS chunks at Twilio's provider maximum", async () => {
    await sendSmsTextChunks({
      account: createAccount(5000),
      to: "+15551234567",
      text: "x".repeat(1601),
    });

    expect(sendSmsViaTwilio).toHaveBeenCalledTimes(2);
    expect(sendSmsViaTwilio.mock.calls.map(([call]) => call.text?.length)).toEqual([1600, 1]);
  });

  it("preserves accepted SIDs when a later SMS chunk fails", async () => {
    const failure = new Error("second chunk failed");
    const events: string[] = [];
    sendSmsViaTwilio
      .mockImplementationOnce(async ({ onPlatformSendDispatch }) => {
        await onPlatformSendDispatch?.();
        events.push("send:first");
        return { sid: "SM-first", to: "+15551234567" };
      })
      .mockImplementationOnce(async ({ onPlatformSendDispatch }) => {
        await onPlatformSendDispatch?.();
        events.push("send:second");
        throw failure;
      });
    const onDeliveryResult = vi.fn(async (result) => {
      events.push(`delivery:${result.messageId}`);
    });
    const onPlatformSendDispatch = vi.fn(async () => {
      events.push("dispatch");
    });

    let observed: unknown;
    try {
      await sendSmsTextChunks({
        account: createAccount(5),
        to: "+15551234567",
        text: "alpha beta",
        onPlatformSendDispatch,
        onDeliveryResult,
      });
    } catch (error) {
      observed = error;
    }

    expect(isChannelPartialDeliveryError(observed)).toBe(true);
    if (!isChannelPartialDeliveryError(observed)) {
      throw observed;
    }
    expect(observed.deliveryResult).toMatchObject({
      messageIds: ["SM-first"],
      visibleReplySent: true,
      receipt: {
        parts: [{ platformMessageId: "SM-first", kind: "text" }],
      },
    });
    expect(onDeliveryResult).toHaveBeenCalledExactlyOnceWith({
      channel: "sms",
      messageId: "SM-first",
      chatId: "+15551234567",
      receipt: expect.objectContaining({
        platformMessageIds: ["SM-first"],
        parts: [expect.objectContaining({ platformMessageId: "SM-first", kind: "text" })],
      }),
    });
    expect(onPlatformSendDispatch).toHaveBeenCalledTimes(2);
    expect(events).toEqual([
      "dispatch",
      "send:first",
      "delivery:SM-first",
      "dispatch",
      "send:second",
    ]);
  });
});

describe("sendSmsMedia", () => {
  it("preserves existing pre-dispatch proof from hosted-media staging", async () => {
    const { PlatformMessageNotDispatchedError } = await import("openclaw/plugin-sdk/error-runtime");
    const rejection = new PlatformMessageNotDispatchedError("unsupported hosted media", {
      cause: new Error("unsupported content type"),
      retryable: false,
    });
    hostedMediaMocks.prepare.mockRejectedValueOnce(rejection);

    await expect(
      sendSmsMedia({
        account: createAccount(1500),
        to: "+15551234567",
        text: "photo",
        mediaUrl: "/tmp/photo.jpg",
        mediaLocalRoots: ["/tmp"],
      }),
    ).rejects.toBe(rejection);

    expect(sendSmsViaTwilio).not.toHaveBeenCalled();
  });

  it("attaches media only to the first caption chunk and returns every SID in order", async () => {
    sendSmsViaTwilio
      .mockResolvedValueOnce({ sid: "MM-first", to: "+15551234567" })
      .mockResolvedValueOnce({ sid: "SM-second", to: "+15551234567" });

    const results = await sendSmsMedia({
      account: createAccount(5000),
      to: "+15551234567",
      text: "x".repeat(1601),
      mediaUrl: "/tmp/photo.jpg",
      mediaLocalRoots: ["/tmp"],
    });

    expect(results.map((result) => result.sid)).toEqual(["MM-first", "SM-second"]);
    expect(sendSmsViaTwilio).toHaveBeenNthCalledWith(1, {
      account: createAccount(5000),
      to: "+15551234567",
      text: "x".repeat(1600),
      mediaUrls: ["https://gateway.example.com/webhooks/sms/media/abc?token=token"],
      onPlatformSendDispatch: expect.any(Function),
    });
    expect(sendSmsViaTwilio).toHaveBeenNthCalledWith(2, {
      account: createAccount(5000),
      to: "+15551234567",
      text: "x",
      onPlatformSendDispatch: expect.any(Function),
    });
    expect(recordInitialSmsDeliveryResult).toHaveBeenNthCalledWith(1, {
      account: createAccount(5000),
      result: { sid: "MM-first", to: "+15551234567" },
    });
    expect(recordInitialSmsDeliveryResult).toHaveBeenNthCalledWith(2, {
      account: createAccount(5000),
      result: { sid: "SM-second", to: "+15551234567" },
    });
  });

  it("sends media-only MMS without a Body", async () => {
    await sendSmsMedia({
      account: createAccount(1500),
      to: "+15551234567",
      text: " ",
      mediaUrl: "/tmp/photo.jpg",
      mediaLocalRoots: ["/tmp"],
    });

    expect(sendSmsViaTwilio).toHaveBeenCalledExactlyOnceWith({
      account: createAccount(1500),
      to: "+15551234567",
      mediaUrls: ["https://gateway.example.com/webhooks/sms/media/abc?token=token"],
      onPlatformSendDispatch: expect.any(Function),
    });
  });

  it("preserves the accepted MMS when a later caption chunk fails", async () => {
    const failure = new Error("second chunk failed");
    const events: string[] = [];
    sendSmsViaTwilio
      .mockImplementationOnce(async ({ onPlatformSendDispatch }) => {
        await onPlatformSendDispatch?.();
        events.push("send:first");
        return { sid: "MM-first", to: "+15551234567" };
      })
      .mockImplementationOnce(async ({ onPlatformSendDispatch }) => {
        await onPlatformSendDispatch?.();
        events.push("send:second");
        throw failure;
      });
    const onDeliveryResult = vi.fn(async (result) => {
      events.push(`delivery:${result.messageId}`);
    });
    const onPlatformSendDispatch = vi.fn(async () => {
      events.push("dispatch");
    });

    let observed: unknown;
    try {
      await sendSmsMedia({
        account: createAccount(5),
        to: "+15551234567",
        text: "alpha beta gamma",
        mediaUrl: "/tmp/photo.jpg",
        mediaLocalRoots: ["/tmp"],
        onPlatformSendDispatch,
        onDeliveryResult,
      });
    } catch (error) {
      observed = error;
    }

    expect(sendSmsViaTwilio).toHaveBeenCalledTimes(2);
    expect(sendSmsViaTwilio.mock.calls[0]?.[0]).toMatchObject({
      text: "alpha",
      mediaUrls: ["https://gateway.example.com/webhooks/sms/media/abc?token=token"],
    });
    expect(sendSmsViaTwilio.mock.calls[1]?.[0]).toMatchObject({
      text: " beta",
    });
    expect(sendSmsViaTwilio.mock.calls[1]?.[0]).not.toHaveProperty("mediaUrls");
    expect(isChannelPartialDeliveryError(observed)).toBe(true);
    if (!isChannelPartialDeliveryError(observed)) {
      throw observed;
    }
    expect(observed.deliveryResult).toMatchObject({
      messageIds: ["MM-first"],
      visibleReplySent: true,
      receipt: {
        parts: [{ platformMessageId: "MM-first", kind: "media" }],
      },
    });
    expect(onDeliveryResult).toHaveBeenCalledExactlyOnceWith({
      channel: "sms",
      messageId: "MM-first",
      chatId: "+15551234567",
      receipt: expect.objectContaining({
        platformMessageIds: ["MM-first"],
        parts: [expect.objectContaining({ platformMessageId: "MM-first", kind: "media" })],
      }),
    });
    expect(onPlatformSendDispatch).toHaveBeenCalledTimes(2);
    expect(events).toEqual([
      "dispatch",
      "send:first",
      "delivery:MM-first",
      "dispatch",
      "send:second",
    ]);
  });
});
