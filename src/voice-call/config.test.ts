import { describe, expect, it } from "vitest";

import {
  E164Schema,
  InboundPolicySchema,
  VoiceCallConfigSchema,
  validateProviderConfig,
} from "./config.js";

describe("E164Schema", () => {
  it("accepts valid E.164 phone numbers", () => {
    expect(E164Schema.parse("+15551234567")).toBe("+15551234567");
    expect(E164Schema.parse("+15550001234")).toBe("+15550001234");
    expect(E164Schema.parse("+123456789012345")).toBe("+123456789012345"); // max 15 digits
  });

  it("rejects invalid phone numbers", () => {
    expect(() => E164Schema.parse("5551234567")).toThrow(); // missing +
    expect(() => E164Schema.parse("+0551234567")).toThrow(); // starts with 0
    expect(() => E164Schema.parse("")).toThrow(); // empty
    expect(() => E164Schema.parse("+1")).toThrow(); // too short
    expect(() => E164Schema.parse("+1234567890123456789")).toThrow(); // too long
  });
});

describe("InboundPolicySchema", () => {
  it("accepts valid policies", () => {
    expect(InboundPolicySchema.parse("disabled")).toBe("disabled");
    expect(InboundPolicySchema.parse("allowlist")).toBe("allowlist");
    expect(InboundPolicySchema.parse("pairing")).toBe("pairing");
    expect(InboundPolicySchema.parse("open")).toBe("open");
  });

  it("rejects invalid policies", () => {
    expect(() => InboundPolicySchema.parse("invalid")).toThrow();
    expect(() => InboundPolicySchema.parse("")).toThrow();
  });
});

describe("VoiceCallConfigSchema", () => {
  it("provides sensible defaults", () => {
    const config = VoiceCallConfigSchema.parse({});

    expect(config.enabled).toBe(false);
    expect(config.inboundPolicy).toBe("disabled");
    expect(config.maxDurationSeconds).toBe(300);
    expect(config.silenceTimeoutMs).toBe(800);
    expect(config.maxConcurrentCalls).toBe(1);
    expect(config.serve.port).toBe(3334);
    expect(config.serve.bind).toBe("127.0.0.1");
    expect(config.tts.voice).toBe("onyx");
    expect(config.outbound.defaultMode).toBe("notify");
    expect(config.outbound.notifyHangupDelaySec).toBe(3);
  });

  it("accepts full configuration", () => {
    const config = VoiceCallConfigSchema.parse({
      enabled: true,
      provider: "twilio",
      fromNumber: "+15551234567",
      toNumber: "+15550001234",
      inboundPolicy: "allowlist",
      allowFrom: ["+15550001234"],
      twilio: {
        accountSid: "AC123",
        authToken: "token123",
      },
    });

    expect(config.enabled).toBe(true);
    expect(config.provider).toBe("twilio");
    expect(config.fromNumber).toBe("+15551234567");
    expect(config.allowFrom).toEqual(["+15550001234"]);
  });
});

describe("validateProviderConfig", () => {
  it("returns valid for disabled config", () => {
    const config = VoiceCallConfigSchema.parse({ enabled: false });
    const result = validateProviderConfig(config);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("requires provider when enabled", () => {
    const config = VoiceCallConfigSchema.parse({
      enabled: true,
      fromNumber: "+15551234567",
    });
    const result = validateProviderConfig(config);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "voiceCall.provider is required when enabled",
    );
  });

  it("requires fromNumber when enabled", () => {
    const config = VoiceCallConfigSchema.parse({
      enabled: true,
      provider: "twilio",
    });
    const result = validateProviderConfig(config);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "voiceCall.fromNumber is required when enabled",
    );
  });

  it("requires Telnyx credentials for telnyx provider", () => {
    const config = VoiceCallConfigSchema.parse({
      enabled: true,
      provider: "telnyx",
      fromNumber: "+15551234567",
    });
    const result = validateProviderConfig(config);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "voiceCall.telnyx.apiKey is required (or set TELNYX_API_KEY env)",
    );
    expect(result.errors).toContain(
      "voiceCall.telnyx.connectionId is required (or set TELNYX_CONNECTION_ID env)",
    );
  });

  it("requires Twilio credentials for twilio provider", () => {
    const config = VoiceCallConfigSchema.parse({
      enabled: true,
      provider: "twilio",
      fromNumber: "+15551234567",
    });
    const result = validateProviderConfig(config);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "voiceCall.twilio.accountSid is required (or set TWILIO_ACCOUNT_SID env)",
    );
    expect(result.errors).toContain(
      "voiceCall.twilio.authToken is required (or set TWILIO_AUTH_TOKEN env)",
    );
  });

  it("validates complete Twilio config", () => {
    const config = VoiceCallConfigSchema.parse({
      enabled: true,
      provider: "twilio",
      fromNumber: "+15551234567",
      twilio: {
        accountSid: "AC123",
        authToken: "token123",
      },
    });
    const result = validateProviderConfig(config);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("validates complete Telnyx config", () => {
    const config = VoiceCallConfigSchema.parse({
      enabled: true,
      provider: "telnyx",
      fromNumber: "+15551234567",
      telnyx: {
        apiKey: "KEY123",
        connectionId: "conn123",
      },
    });
    const result = validateProviderConfig(config);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
