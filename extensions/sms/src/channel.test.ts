// Sms tests cover channel plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ChannelModule = typeof import("./channel.js");

let smsPlugin: ChannelModule["smsPlugin"];

const sendSmsViaTwilio = vi.hoisted(() =>
  vi.fn(async ({ to }) => ({
    sid: "SM-default",
    to,
    from: "+15557654321",
    status: "queued",
  })),
);

beforeEach(async () => {
  vi.resetModules();
  sendSmsViaTwilio.mockClear();
  vi.doMock("./twilio.js", () => ({
    sendSmsViaTwilio,
  }));
  ({ smsPlugin } = await import("./channel.js"));
});

afterEach(() => {
  vi.doUnmock("./twilio.js");
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

    expect(snapshot).toEqual({
      accountId: "support",
      name: "+15557654321",
      enabled: true,
      configured: true,
      statusState: "configured",
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
});
