// Sms tests cover channel plugin behavior.
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SmsDeliveryRecord } from "./delivery-observations.js";
import type { probeSmsAccount as probeSmsAccountType } from "./status.js";
import type { sendSmsViaTwilio as sendSmsViaTwilioType } from "./twilio.js";

type ChannelModule = typeof import("./channel.js");
type PlatformMessageNotDispatchedErrorConstructor =
  (typeof import("openclaw/plugin-sdk/error-runtime"))["PlatformMessageNotDispatchedError"];

let smsPlugin: ChannelModule["smsPlugin"];
let PlatformMessageNotDispatchedError: PlatformMessageNotDispatchedErrorConstructor;

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
const listRecentSmsDeliveryRecords = vi.hoisted(() =>
  vi.fn(async (): Promise<SmsDeliveryRecord[]> => []),
);
const recordInitialSmsDeliveryResult = vi.hoisted(() => vi.fn(async () => null));
const probeSmsAccount = vi.hoisted(() =>
  vi.fn<typeof probeSmsAccountType>(async () => ({
    ok: true,
    webhook: { status: "skipped" as const, reason: "test" },
    hints: [],
  })),
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
  hostedMediaMocks.cleanup.mockReset();
  hostedMediaMocks.cleanup.mockResolvedValue(undefined);
  hostedMediaMocks.prepare.mockReset();
  hostedMediaMocks.prepare.mockResolvedValue({
    url: "https://gateway.example.com/webhooks/sms/media/abc?token=token",
    cleanup: hostedMediaMocks.cleanup,
  });
  listRecentSmsDeliveryRecords.mockClear();
  recordInitialSmsDeliveryResult.mockReset();
  recordInitialSmsDeliveryResult.mockResolvedValue(null);
  probeSmsAccount.mockClear();
  vi.doMock("./twilio.js", () => ({
    sendSmsViaTwilio,
    TWILIO_MESSAGE_BODY_MAX_LENGTH: 1600,
  }));
  vi.doMock("./media.js", () => ({
    prepareHostedSmsMedia: hostedMediaMocks.prepare,
  }));
  vi.doMock("./delivery-observations.js", () => ({
    listRecentSmsDeliveryRecords,
    recordInitialSmsDeliveryResult,
  }));
  vi.doMock("./status.js", () => ({
    probeSmsAccount,
    formatSmsProbeLines: vi.fn(() => []),
  }));
  ({ PlatformMessageNotDispatchedError } = await import("openclaw/plugin-sdk/error-runtime"));
  ({ smsPlugin } = await import("./channel.js"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock("./twilio.js");
  vi.doUnmock("./media.js");
  vi.doUnmock("./delivery-observations.js");
  vi.doUnmock("./status.js");
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

  it("loads delivery observations with the full Twilio account identity", async () => {
    const account = {
      accountId: "support",
      enabled: true,
      accountSid: "AC-support",
      authToken: "secret",
      fromNumber: "+15557654321",
      messagingServiceSid: "",
      defaultTo: "",
      webhookPath: "/webhooks/sms",
      publicWebhookUrl: "https://gateway.example.com/webhooks/sms",
      dangerouslyDisableSignatureValidation: false,
      dmPolicy: "pairing" as const,
      allowFrom: [],
      textChunkLimit: 1500,
    };
    const records = [
      {
        accountId: "support",
        accountSidHash: "account-sid-hash",
        messageSid: "SM123",
        status: "delivered",
        firstObservedAt: 1,
        lastObservedAt: 2,
        observations: [],
      },
    ];
    listRecentSmsDeliveryRecords.mockResolvedValueOnce(records);

    await smsPlugin.status?.probeAccount?.({
      cfg: {},
      account,
      timeoutMs: 1000,
    });

    expect(listRecentSmsDeliveryRecords).toHaveBeenCalledWith(account);
    expect(probeSmsAccount).toHaveBeenCalledWith({
      account,
      timeoutMs: expect.any(Number),
      options: { deliveryRecords: records },
    });
    const remainingTimeoutMs = probeSmsAccount.mock.calls[0]?.[0]?.timeoutMs;
    expect(remainingTimeoutMs).toBeGreaterThan(0);
    expect(remainingTimeoutMs).toBeLessThanOrEqual(1000);
  });

  it("passes only the remaining probe budget after loading delivery observations", async () => {
    vi.useFakeTimers();
    const account = {
      accountId: "support",
      enabled: true,
      accountSid: "AC-support",
      authToken: "secret",
      fromNumber: "+15557654321",
      messagingServiceSid: "",
      defaultTo: "",
      webhookPath: "/webhooks/sms",
      publicWebhookUrl: "https://gateway.example.com/webhooks/sms",
      dangerouslyDisableSignatureValidation: false,
      dmPolicy: "pairing" as const,
      allowFrom: [],
      textChunkLimit: 1500,
    };
    listRecentSmsDeliveryRecords.mockImplementationOnce(
      async () =>
        await new Promise<SmsDeliveryRecord[]>((resolve) => {
          setTimeout(() => resolve([]), 250);
        }),
    );

    const probe = smsPlugin.status?.probeAccount?.({
      cfg: {},
      account,
      timeoutMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(250);
    await probe;

    expect(probeSmsAccount).toHaveBeenCalledWith({
      account,
      timeoutMs: 750,
      options: { deliveryRecords: [] },
    });
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

    expect(hostedMediaMocks.prepare).toHaveBeenCalledWith(
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
    hostedMediaMocks.prepare.mockImplementationOnce(async () => {
      events.push("prepare");
      return {
        url: "https://gateway.example.com/webhooks/sms/media/abc?token=token",
        cleanup: hostedMediaMocks.cleanup,
      };
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

    expect(hostedMediaMocks.prepare).toHaveBeenCalledOnce();
    expect(events).toEqual(["prepare", "platform-start", "dispatch", "send"]);
    await expect(smsPlugin.message?.send?.media?.(ctx)).rejects.toThrow(
      "SMS message lifecycle did not prepare the MMS attachment.",
    );
  });

  it("discards staged MMS media when the durable dispatch marker fails", async () => {
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
      onPlatformSendDispatch: async () => {
        throw new Error("delivery marker failed");
      },
    };
    const lifecycle = smsPlugin.message?.send?.lifecycle;
    const attemptToken = await lifecycle?.beforeSendAttempt?.(ctx);
    let observed: unknown;
    try {
      await smsPlugin.message?.send?.media?.(ctx);
    } catch (error) {
      observed = error;
    }

    expect(observed).toBeInstanceOf(PlatformMessageNotDispatchedError);
    await lifecycle?.afterSendFailure?.({
      ...ctx,
      error: observed,
      attemptToken,
    });

    expect(hostedMediaMocks.cleanup).toHaveBeenCalledOnce();
  });

  it("discards staged MMS media when core fails before entering the adapter", async () => {
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
    };
    const lifecycle = smsPlugin.message?.send?.lifecycle;
    const attemptToken = await lifecycle?.beforeSendAttempt?.(ctx);

    await lifecycle?.afterSendFailure?.({
      ...ctx,
      error: new Error("queue state rejected before adapter dispatch"),
      attemptToken,
    });

    expect(hostedMediaMocks.cleanup).toHaveBeenCalledOnce();
    expect(sendSmsViaTwilio).not.toHaveBeenCalled();
  });

  it("retains staged MMS media after an ambiguous Twilio failure", async () => {
    const failure = new Error("Twilio response was lost");
    sendSmsViaTwilio.mockImplementationOnce(async ({ onPlatformSendDispatch }) => {
      await onPlatformSendDispatch?.();
      throw failure;
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
      onPlatformSendDispatch: async () => undefined,
    };
    const lifecycle = smsPlugin.message?.send?.lifecycle;
    const attemptToken = await lifecycle?.beforeSendAttempt?.(ctx);
    let observed: unknown;
    try {
      await smsPlugin.message?.send?.media?.(ctx);
    } catch (error) {
      observed = error;
    }

    expect(observed).toBe(failure);
    await lifecycle?.afterSendFailure?.({
      ...ctx,
      error: observed,
      attemptToken,
    });

    expect(hostedMediaMocks.cleanup).not.toHaveBeenCalled();
  });

  it("retains staged MMS media after a partial delivery", async () => {
    sendSmsViaTwilio
      .mockImplementationOnce(async ({ to, onPlatformSendDispatch }) => {
        await onPlatformSendDispatch?.();
        return { sid: "MM-first", to };
      })
      .mockRejectedValueOnce(
        new PlatformMessageNotDispatchedError("second chunk rejected before dispatch", {
          cause: new Error("provider rejected chunk"),
        }),
      );
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
      onPlatformSendDispatch: async () => undefined,
    };
    const lifecycle = smsPlugin.message?.send?.lifecycle;
    const attemptToken = await lifecycle?.beforeSendAttempt?.(ctx);
    let observed: unknown;
    try {
      await smsPlugin.message?.send?.media?.(ctx);
    } catch (error) {
      observed = error;
    }

    expect(isChannelPartialDeliveryError(observed)).toBe(true);
    await lifecycle?.afterSendFailure?.({
      ...ctx,
      error: observed,
      attemptToken,
    });

    expect(hostedMediaMocks.cleanup).not.toHaveBeenCalled();
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
