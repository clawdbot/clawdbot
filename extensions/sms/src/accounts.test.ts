// Sms tests cover accounts plugin behavior.
import { afterEach, describe, expect, it } from "vitest";
import { listSmsAccountIds, resolveSmsAccount } from "./accounts.js";
import { SmsChannelConfigSchema } from "./config-schema.js";
import type { SmsChannelConfig } from "./types.js";

const smsRuntimeConfigSchema = (() => {
  const schema = SmsChannelConfigSchema.runtime;
  if (!schema) {
    throw new Error("expected SMS runtime config schema");
  }
  return schema;
})();

function parseSmsConfig(value: unknown): SmsChannelConfig {
  const parsed = smsRuntimeConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(parsed.issues.map((issue) => issue.message).join("; "));
  }
  return parsed.data as SmsChannelConfig;
}

const ENV_KEYS = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_PHONE_NUMBER",
  "TWILIO_SMS_FROM",
  "TWILIO_MESSAGING_SERVICE_SID",
  "SMS_PUBLIC_WEBHOOK_URL",
  "SMS_WEBHOOK_PATH",
  "SMS_ALLOWED_USERS",
  "SMS_DANGEROUSLY_DISABLE_SIGNATURE_VALIDATION",
  "SMS_TEXT_CHUNK_LIMIT",
] as const;

afterEach(() => {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
});

describe("SMS account config", () => {
  it("resolves default account config and pairing policy", () => {
    const account = resolveSmsAccount({
      channels: {
        sms: {
          accountSid: " AC123 ",
          authToken: " token ",
          fromNumber: "(555) 123-4567",
          defaultTo: "sms:+1 (555) 000-1111",
          publicWebhookUrl: " https://example.com/webhooks/sms ",
        },
      },
    });

    expect(account).toMatchObject({
      accountId: "default",
      accountSid: "AC123",
      authToken: "token",
      fromNumber: "+5551234567",
      messagingServiceSid: "",
      defaultTo: "+15550001111",
      webhookPath: "/webhooks/sms",
      publicWebhookUrl: "https://example.com/webhooks/sms",
      dmPolicy: "pairing",
      allowFrom: [],
      textChunkLimit: 1500,
    });
  });

  it("merges named accounts over the top-level defaults", () => {
    const cfg = {
      channels: {
        sms: {
          accountSid: "AC-parent",
          authToken: "parent-token",
          fromNumber: "+15550000000",
          accounts: {
            support: {
              fromNumber: "+15551112222",
              webhookPath: "/webhooks/sms/support",
              dmPolicy: "allowlist",
              allowFrom: ["sms:+15553334444"],
            },
          },
        },
      },
    };

    expect(listSmsAccountIds(cfg)).toEqual(["default", "support"]);
    expect(resolveSmsAccount(cfg, "support")).toMatchObject({
      accountId: "support",
      accountSid: "AC-parent",
      authToken: "parent-token",
      fromNumber: "+15551112222",
      webhookPath: "/webhooks/sms/support",
      dmPolicy: "allowlist",
      allowFrom: ["+15553334444"],
    });
  });

  it("normalizes numeric allowFrom entries accepted by config schema", () => {
    const cfg = {
      channels: {
        sms: {
          accountSid: "AC-parent",
          authToken: "parent-token",
          fromNumber: "+15550000000",
          allowFrom: [1_555_333_4444],
        },
      },
    };

    expect(parseSmsConfig(cfg.channels.sms).allowFrom).toEqual([1_555_333_4444]);
    expect(resolveSmsAccount(cfg)).toMatchObject({
      allowFrom: ["+15553334444"],
    });
  });

  it("uses the configured default account when accountId is omitted", () => {
    const cfg = {
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
    };

    expect(resolveSmsAccount(cfg)).toMatchObject({
      accountId: "support",
      accountSid: "AC-support",
      authToken: "support-token",
      fromNumber: "+15551112222",
      textChunkLimit: 700,
    });
  });

  it("treats top-level enabled false as a channel kill switch", () => {
    const cfg = {
      channels: {
        sms: {
          enabled: false,
          accounts: {
            support: {
              enabled: true,
              accountSid: "AC-support",
              authToken: "support-token",
              fromNumber: "+15551112222",
            },
          },
        },
      },
    };

    expect(resolveSmsAccount(cfg, "support")).toMatchObject({
      accountId: "support",
      enabled: false,
    });
  });

  it("uses env fallbacks for the default account only", () => {
    process.env.TWILIO_ACCOUNT_SID = "AC-env";
    process.env.TWILIO_AUTH_TOKEN = "env-token";
    process.env.TWILIO_PHONE_NUMBER = "+15550001111";
    process.env.TWILIO_MESSAGING_SERVICE_SID = "MG-env";
    process.env.SMS_WEBHOOK_PATH = "/webhooks/sms/env";
    process.env.SMS_PUBLIC_WEBHOOK_URL = "https://sms.example.com/webhook";
    process.env.SMS_ALLOWED_USERS = "sms:+15552223333,+15554445555";
    process.env.SMS_DANGEROUSLY_DISABLE_SIGNATURE_VALIDATION = "true";
    process.env.SMS_TEXT_CHUNK_LIMIT = "800";

    const cfg = { channels: { sms: { accounts: { support: { enabled: true } } } } };

    expect(listSmsAccountIds(cfg)).toEqual(["default", "support"]);
    expect(resolveSmsAccount(cfg)).toMatchObject({
      accountSid: "AC-env",
      authToken: "env-token",
      fromNumber: "+15550001111",
      messagingServiceSid: "MG-env",
      webhookPath: "/webhooks/sms/env",
      publicWebhookUrl: "https://sms.example.com/webhook",
      dangerouslyDisableSignatureValidation: true,
      allowFrom: ["+15552223333", "+15554445555"],
      textChunkLimit: 800,
    });
    expect(resolveSmsAccount(cfg, "support")).toMatchObject({
      accountId: "support",
      accountSid: "",
      authToken: "",
      fromNumber: "",
      messagingServiceSid: "",
      webhookPath: "/webhooks/sms",
      publicWebhookUrl: "",
      dangerouslyDisableSignatureValidation: false,
      allowFrom: [],
      textChunkLimit: 1500,
    });
  });

  it("coerces numeric allowFrom entries accepted by the config schema", () => {
    const parsed = parseSmsConfig({
      accountSid: "AC123",
      authToken: "token",
      fromNumber: "+15550001111",
      allowFrom: [15551234567],
    });

    expect(resolveSmsAccount({ channels: { sms: parsed } })).toMatchObject({
      allowFrom: ["+15551234567"],
    });
  });

  it("discovers env-only SMS credentials as the implicit default account", () => {
    process.env.TWILIO_ACCOUNT_SID = "AC-env";
    process.env.TWILIO_AUTH_TOKEN = "env-token";
    process.env.TWILIO_SMS_FROM = "+15550001111";

    expect(listSmsAccountIds({})).toEqual(["default"]);
    expect(resolveSmsAccount({})).toMatchObject({
      accountId: "default",
      accountSid: "AC-env",
      authToken: "env-token",
      fromNumber: "+15550001111",
    });
  });

  it("does not discover blank credential strings as the implicit default account", () => {
    process.env.TWILIO_ACCOUNT_SID = " ";
    process.env.TWILIO_AUTH_TOKEN = "\t";
    process.env.TWILIO_PHONE_NUMBER = " ";
    process.env.TWILIO_SMS_FROM = "\n";
    process.env.TWILIO_MESSAGING_SERVICE_SID = " ";

    expect(listSmsAccountIds({})).toEqual([]);
    expect(
      listSmsAccountIds({
        channels: {
          sms: {
            accountSid: " ",
            authToken: "\t",
            fromNumber: "\n",
            messagingServiceSid: " ",
          },
        },
      }),
    ).toEqual([]);
    expect(
      listSmsAccountIds({
        channels: {
          sms: {
            accounts: {
              support: {
                enabled: true,
              },
            },
          },
        },
      }),
    ).toEqual(["support"]);
  });

  it("uses TWILIO_SMS_FROM when the legacy from-number env var is blank", () => {
    process.env.TWILIO_ACCOUNT_SID = "AC-env";
    process.env.TWILIO_AUTH_TOKEN = "env-token";
    process.env.TWILIO_PHONE_NUMBER = " ";
    process.env.TWILIO_SMS_FROM = "+15550001111";

    expect(resolveSmsAccount({})).toMatchObject({
      fromNumber: "+15550001111",
    });
  });

  it("accepts a Twilio Messaging Service SID instead of a from number", () => {
    process.env.TWILIO_ACCOUNT_SID = "AC-env";
    process.env.TWILIO_AUTH_TOKEN = "env-token";
    process.env.TWILIO_MESSAGING_SERVICE_SID = "MG-env";

    expect(listSmsAccountIds({})).toEqual(["default"]);
    expect(resolveSmsAccount({})).toMatchObject({
      accountSid: "AC-env",
      authToken: "env-token",
      fromNumber: "",
      messagingServiceSid: "MG-env",
    });
  });

  it("accepts secret references for Twilio auth tokens", () => {
    expect(() =>
      parseSmsConfig({
        accountSid: "AC123",
        authToken: { source: "env", provider: "default", id: "TWILIO_AUTH_TOKEN" },
        fromNumber: "+15550001111",
      }),
    ).not.toThrow();
    expect(() =>
      resolveSmsAccount({
        channels: {
          sms: {
            accountSid: "AC123",
            authToken: { source: "env", provider: "default", id: "TWILIO_AUTH_TOKEN" },
            fromNumber: "+15550001111",
          },
        },
      }),
    ).toThrow('channels.sms.authToken: unresolved SecretRef "env:default:TWILIO_AUTH_TOKEN"');
  });
});
