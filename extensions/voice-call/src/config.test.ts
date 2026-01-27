import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { validateProviderConfig, resolveVoiceCallConfig, type VoiceCallConfig } from "./config.js";

function createBaseConfig(
  provider: "telnyx" | "twilio" | "plivo" | "mock",
): VoiceCallConfig {
  return {
    enabled: true,
    provider,
    fromNumber: "+15550001234",
    inboundPolicy: "disabled",
    allowFrom: [],
    outbound: { defaultMode: "notify", notifyHangupDelaySec: 3 },
    maxDurationSeconds: 300,
    silenceTimeoutMs: 800,
    transcriptTimeoutMs: 180000,
    ringTimeoutMs: 30000,
    maxConcurrentCalls: 1,
    serve: { port: 3334, bind: "127.0.0.1", path: "/voice/webhook" },
    tailscale: { mode: "off", path: "/voice/webhook" },
    tunnel: { provider: "none", allowNgrokFreeTierLoopbackBypass: false },
    streaming: {
      enabled: false,
      sttProvider: "openai-realtime",
      sttModel: "gpt-4o-transcribe",
      silenceDurationMs: 800,
      vadThreshold: 0.5,
      streamPath: "/voice/stream",
    },
    skipSignatureVerification: false,
    stt: { provider: "openai", model: "whisper-1" },
    tts: { provider: "openai", model: "gpt-4o-mini-tts", voice: "coral" },
    responseModel: "openai/gpt-4o-mini",
    responseTimeoutMs: 30000,
  };
}

describe("validateProviderConfig", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear all relevant env vars before each test
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TELNYX_API_KEY;
    delete process.env.TELNYX_CONNECTION_ID;
    delete process.env.PLIVO_AUTH_ID;
    delete process.env.PLIVO_AUTH_TOKEN;
  });

  afterEach(() => {
    // Restore original env
    process.env = { ...originalEnv };
  });

  describe("twilio provider", () => {
    it("passes validation when credentials are in config", () => {
      const config = createBaseConfig("twilio");
      config.twilio = { accountSid: "AC123", authToken: "secret" };

      const result = validateProviderConfig(config);

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("passes validation when credentials are in environment variables", () => {
      process.env.TWILIO_ACCOUNT_SID = "AC123";
      process.env.TWILIO_AUTH_TOKEN = "secret";
      let config = createBaseConfig("twilio");
      config = resolveVoiceCallConfig(config);

      const result = validateProviderConfig(config);

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("passes validation with mixed config and env vars", () => {
      process.env.TWILIO_AUTH_TOKEN = "secret";
      let config = createBaseConfig("twilio");
      config.twilio = { accountSid: "AC123" };
      config = resolveVoiceCallConfig(config);

      const result = validateProviderConfig(config);

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("fails validation when accountSid is missing everywhere", () => {
      process.env.TWILIO_AUTH_TOKEN = "secret";
      let config = createBaseConfig("twilio");
      config = resolveVoiceCallConfig(config);

      const result = validateProviderConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        "plugins.entries.voice-call.config.twilio.accountSid is required (or set TWILIO_ACCOUNT_SID env)",
      );
    });

    it("fails validation when authToken is missing everywhere", () => {
      process.env.TWILIO_ACCOUNT_SID = "AC123";
      let config = createBaseConfig("twilio");
      config = resolveVoiceCallConfig(config);

      const result = validateProviderConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        "plugins.entries.voice-call.config.twilio.authToken is required (or set TWILIO_AUTH_TOKEN env)",
      );
    });
  });

  describe("telnyx provider", () => {
    it("passes validation when credentials are in config", () => {
      const config = createBaseConfig("telnyx");
      config.telnyx = { apiKey: "KEY123", connectionId: "CONN456" };

      const result = validateProviderConfig(config);

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("passes validation when credentials are in environment variables", () => {
      process.env.TELNYX_API_KEY = "KEY123";
      process.env.TELNYX_CONNECTION_ID = "CONN456";
      let config = createBaseConfig("telnyx");
      config = resolveVoiceCallConfig(config);

      const result = validateProviderConfig(config);

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("fails validation when apiKey is missing everywhere", () => {
      process.env.TELNYX_CONNECTION_ID = "CONN456";
      let config = createBaseConfig("telnyx");
      config = resolveVoiceCallConfig(config);

      const result = validateProviderConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        "plugins.entries.voice-call.config.telnyx.apiKey is required (or set TELNYX_API_KEY env)",
      );
    });
  });

  describe("plivo provider", () => {
    it("passes validation when credentials are in config", () => {
      const config = createBaseConfig("plivo");
      config.plivo = { authId: "MA123", authToken: "secret" };

      const result = validateProviderConfig(config);

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("passes validation when credentials are in environment variables", () => {
      process.env.PLIVO_AUTH_ID = "MA123";
      process.env.PLIVO_AUTH_TOKEN = "secret";
      let config = createBaseConfig("plivo");
      config = resolveVoiceCallConfig(config);

      const result = validateProviderConfig(config);

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("fails validation when authId is missing everywhere", () => {
      process.env.PLIVO_AUTH_TOKEN = "secret";
      let config = createBaseConfig("plivo");
      config = resolveVoiceCallConfig(config);

      const result = validateProviderConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        "plugins.entries.voice-call.config.plivo.authId is required (or set PLIVO_AUTH_ID env)",
      );
    });
  });

  describe("disabled config", () => {
    it("skips validation when enabled is false", () => {
      const config = createBaseConfig("twilio");
      config.enabled = false;

      const result = validateProviderConfig(config);

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });
  });
});
