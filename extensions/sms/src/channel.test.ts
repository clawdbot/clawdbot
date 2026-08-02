// Sms tests cover channel plugin behavior.
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { sendSmsViaTwilio as sendSmsViaTwilioType } from "./twilio.js";

type ChannelModule = typeof import("./channel.js");

let smsPlugin: ChannelModule["smsPlugin"];

const sendSmsViaTwilio = vi.hoisted(() =>
  vi.fn<typeof sendSmsViaTwilioType>(async ({ to, onPlatformSendDispatch }) => {
    await onPlatformSendDispatch?.();
    return {
      sid: "SM-default",
      to,
      from: "+15557654321",
      status: "queued",
    };
  }),
);
const prepareHostedSmsMediaUrl = vi.hoisted(() =>
  vi.fn(async () => "https://gateway.example.com/webhooks/sms/media/abc?token=token"),
);

beforeEach(async () => {
  vi.resetModules();
  sendSmsViaTwilio.mockReset();
  sendSmsViaTwilio.mockImplementation(async ({ to, onPlatformSendDispatch }) => {
    await onPlatformSendDispatch?.();
    return {
      sid: "SM-default",
      to,
      from: "+15557654321",
      status: "queued",
    };
  });
  prepareHostedSmsMediaUrl.mockReset();
  prepareHostedSmsMediaUrl.mockResolvedValue(
    "https://gateway.example.com/webhooks/sms/media/abc?token=token",
  );
  vi.doMock("./twilio.js", () => ({
    sendSmsViaTwilio,
    TWILIO_MESSAGE_BODY_MAX_LENGTH: 1600,
  }));
  vi.doMock("./media.js", () => ({
    prepareHostedSmsMediaUrl,
  }));
  ({ smsPlugin } = await import("./channel.js"));
});

afterEach(() => {
  vi.doUnmock("./twilio.js");
  vi.doUnmock("./media.js");
});

describe("smsPlugin status", () => {
  it("builds a status snapshot for configured SMS accounts", async () => {
    const snapshot = await smsPlugin.status?.buildAccountSnapshot?.({
      cfg: {},
      account: {
        accountId: "support",
        enabled: true,
        accountSid: "AC123",
        authToken: "secret",
        fromNumber: "+15557654321",
        messagingServiceSid: "",
        defaultTo: "",
        webhookPath: "/webhooks/sms",
        publicWebhookUrl: "",
        dangerouslyDisableSignatureValidation: false,
        dmPolicy: "pairing",
        allowFrom: [],
        textChunkLimit: 1500,
      },
    });

    expect(snapshot).toMatchObject({
      accountId: "support",
      name: "+15557654321",
      enabled: true,
      configured: true,
      statusState: "configured",
    });
  });

  it("projects lifecycle from the runtime status record", async () => {
    const snapshot = await smsPlugin.status?.buildAccountSnapshot?.({
      cfg: {},
      account: {
        accountId: "support",
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
        textChunkLimit: 1500,
      },
      runtime: { accountId: "support", lifecycle: "blocked", terminalDisconnect: true },
    });

    expect(snapshot).toMatchObject({ lifecycle: "blocked", terminalDisconnect: true });
  });
});

describe("smsPlugin outbound", () => {
  it("declares an active text chunker and account-aware chunk limit", () => {
    expect(smsPlugin.configSchema).toBeDefined();
    expect(smsPlugin.status?.probeAccount).toBeDefined();
    expect(smsPlugin.status?.formatCapabilitiesProbe).toBeDefined();
    expect(smsPlugin.secrets?.secretTargetRegistryEntries?.map((entry) => entry.id)).toEqual([
      "channels.sms.accounts.*.authToken",
      "channels.sms.authToken",
    ]);
    expect(smsPlugin.messaging?.targetPrefixes).toEqual(["twilio-sms"]);
    expect(smsPlugin.outbound?.chunker?.("alpha beta", 6)).toEqual(["alpha", "beta"]);
    expect(
      smsPlugin.outbound?.resolveEffectiveTextChunkLimit?.({
        cfg: {
          channels: {
            sms: {
              accountSid: "AC123",
              authToken: "secret",
              fromNumber: "+15557654321",
              textChunkLimit: 42,
            },
          },
        },
      }),
    ).toBe(42);
    expect(
      smsPlugin.outbound?.resolveEffectiveTextChunkLimit?.({
        cfg: {
          channels: {
            sms: {
              defaultAccount: "support",
              accounts: {
                support: {
                  accountSid: "AC-support",
                  authToken: "support-token",
                  fromNumber: "+15551112222",
                  textChunkLimit: 700,
                },
              },
            },
          },
        },
      }),
    ).toBe(700);
  });

  it("uses defaultTo for targetless sends and preserves Twilio receipt metadata", async () => {
    const result = await smsPlugin.outbound?.sendText?.({
      cfg: {
        channels: {
          sms: {
            accountSid: "AC123",
            authToken: "secret",
            fromNumber: "+15557654321",
            defaultTo: "+15551234567",
          },
        },
      },
      to: "",
      text: "hello",
    });

    expect(sendSmsViaTwilio).toHaveBeenCalledWith(
      expect.objectContaining({ to: "+15551234567", text: "hello" }),
    );
    expect(result?.messageId).toBe("SM-default");
    expect(result?.receipt?.raw?.[0]).toMatchObject({
      messageId: "SM-default",
      chatId: "+15551234567",
      toJid: "+15551234567",
      meta: {
        from: "+15557654321",
        status: "queued",
      },
    });
  });

  it("resolves the configured default SMS target for outbound delivery", () => {
    expect(
      smsPlugin.outbound?.resolveTarget?.({
        cfg: {
          channels: {
            sms: {
              accountSid: "AC123",
              authToken: "secret",
              fromNumber: "+15557654321",
              defaultTo: "+15551234567",
            },
          },
        },
        to: "",
      }),
    ).toEqual({ ok: true, to: "+15551234567" });
  });

  it("hosts and sends outbound media as MMS with an ordered multipart receipt", async () => {
    sendSmsViaTwilio
      .mockResolvedValueOnce({
        sid: "MM-first",
        to: "+15551234567",
        from: "+15557654321",
        status: "queued",
      })
      .mockResolvedValueOnce({
        sid: "SM-second",
        to: "+15551234567",
        from: "+15557654321",
        status: "queued",
      });
    const ctx = {
      cfg: {
        channels: {
          sms: {
            accountSid: "AC123",
            authToken: "secret",
            fromNumber: "+15557654321",
            publicWebhookUrl: "https://gateway.example.com/webhooks/sms",
            textChunkLimit: 5,
          },
        },
      },
      to: "+15551234567",
      text: "alpha beta",
      kind: "media" as const,
      mediaUrl: "/tmp/photo.jpg",
      mediaLocalRoots: ["/tmp"],
      mediaReadFile: async () => Buffer.from("photo"),
    };
    await smsPlugin.message?.send?.lifecycle?.beforeSendAttempt?.(ctx);
    const result = await smsPlugin.message?.send?.media?.(ctx);

    expect(prepareHostedSmsMediaUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaUrl: "/tmp/photo.jpg",
        mediaLocalRoots: ["/tmp"],
      }),
    );
    expect(sendSmsViaTwilio).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        to: "+15551234567",
        text: "alpha",
        mediaUrls: ["https://gateway.example.com/webhooks/sms/media/abc?token=token"],
      }),
    );
    expect(sendSmsViaTwilio).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        to: "+15551234567",
        text: " beta",
      }),
    );
    expect(sendSmsViaTwilio.mock.calls[1]?.[0]).not.toHaveProperty("mediaUrls");
    expect(result?.messageId).toBe("MM-first");
    expect(result?.receipt.platformMessageIds).toEqual(["MM-first", "SM-second"]);
    expect(result?.receipt.parts.map((part) => part.kind)).toEqual(["media", "text"]);
  });

  it("hosts durable MMS media in the lifecycle before platform send starts", async () => {
    const events: string[] = [];
    prepareHostedSmsMediaUrl.mockImplementationOnce(async () => {
      events.push("prepare");
      return "https://gateway.example.com/webhooks/sms/media/abc?token=token";
    });
    sendSmsViaTwilio.mockImplementationOnce(async ({ to, onPlatformSendDispatch }) => {
      await onPlatformSendDispatch?.();
      events.push("send");
      return { sid: "MM-first", to };
    });
    const ctx = {
      cfg: {
        channels: {
          sms: {
            accountSid: "AC123",
            authToken: "secret",
            fromNumber: "+15557654321",
            publicWebhookUrl: "https://gateway.example.com/webhooks/sms",
          },
        },
      },
      to: "+15551234567",
      text: "caption",
      kind: "media" as const,
      mediaUrl: "/tmp/photo.jpg",
      mediaLocalRoots: ["/tmp"],
      onPlatformSendDispatch: async () => {
        events.push("dispatch");
      },
    };

    await smsPlugin.message?.send?.lifecycle?.beforeSendAttempt?.(ctx);
    events.push("platform-start");
    await smsPlugin.message?.send?.media?.(ctx);

    expect(prepareHostedSmsMediaUrl).toHaveBeenCalledOnce();
    expect(events).toEqual(["prepare", "platform-start", "dispatch", "send"]);
    await expect(smsPlugin.message?.send?.media?.(ctx)).rejects.toThrow(
      "SMS message lifecycle did not prepare the MMS attachment.",
    );
  });

  it("reports an accepted text chunk before a later durable send fails", async () => {
    const failure = new Error("second text chunk failed");
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
      await smsPlugin.message?.send?.text?.({
        cfg: {
          channels: {
            sms: {
              accountSid: "AC123",
              authToken: "secret",
              fromNumber: "+15557654321",
              textChunkLimit: 5,
            },
          },
        },
        to: "+15551234567",
        text: "alpha beta",
        onPlatformSendDispatch,
        onDeliveryResult,
      });
    } catch (error) {
      observed = error;
    }

    expect(isChannelPartialDeliveryError(observed)).toBe(true);
    expect(onDeliveryResult).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        messageId: "SM-first",
        receipt: expect.objectContaining({
          platformMessageIds: ["SM-first"],
        }),
      }),
    );
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
