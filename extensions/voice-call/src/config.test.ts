import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  validateProviderConfig,
  normalizeVoiceCallConfig,
  resolveVoiceCallConfig,
  type VoiceCallConfig,
} from "./config.js";
import { createVoiceCallBaseConfig } from "./test-fixtures.js";

function createBaseConfig(provider: "telnyx" | "twilio" | "plivo" | "mock"): VoiceCallConfig {
  return createVoiceCallBaseConfig({ provider });
}

function requireElevenLabsTtsConfig(config: Pick<VoiceCallConfig, "tts">) {
  const tts = config.tts;
  const elevenlabs = tts?.providers?.elevenlabs;
  if (!elevenlabs || typeof elevenlabs !== "object") {
    throw new Error("voice-call config did not preserve nested elevenlabs TTS config");
  }
  return { tts, elevenlabs };
}

describe("validateProviderConfig", () => {
  const originalEnv = { ...process.env };
  const clearProviderEnv = () => {
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_FROM_NUMBER;
    delete process.env.TELNYX_API_KEY;
    delete process.env.TELNYX_CONNECTION_ID;
    delete process.env.TELNYX_PUBLIC_KEY;
    delete process.env.PLIVO_AUTH_ID;
    delete process.env.PLIVO_AUTH_TOKEN;
  };

  beforeEach(() => {
    clearProviderEnv();
  });

  afterEach(() => {
    // Restore original env
    process.env = { ...originalEnv };
  });

  describe("provider credential sources", () => {
    it("passes validation when credentials come from config or environment", () => {
      for (const provider of ["twilio", "telnyx", "plivo"] as const) {
        clearProviderEnv();
        const fromConfig = createBaseConfig(provider);
        if (provider === "twilio") {
          fromConfig.twilio = { accountSid: "AC123", authToken: "secret" };
        } else if (provider === "telnyx") {
          fromConfig.telnyx = {
            apiKey: "KEY123",
            connectionId: "CONN456",
            publicKey: "public-key",
          };
        } else {
          fromConfig.plivo = { authId: "MA123", authToken: "secret" };
        }
        expect(validateProviderConfig(fromConfig)).toMatchObject({ valid: true, errors: [] });

        clearProviderEnv();
        if (provider === "twilio") {
          process.env.TWILIO_ACCOUNT_SID = "AC123";
          process.env.TWILIO_AUTH_TOKEN = "secret";
          process.env.TWILIO_FROM_NUMBER = "+15550001234";
        } else if (provider === "telnyx") {
          process.env.TELNYX_API_KEY = "KEY123";
          process.env.TELNYX_CONNECTION_ID = "CONN456";
          process.env.TELNYX_PUBLIC_KEY = "public-key";
        } else {
          process.env.PLIVO_AUTH_ID = "MA123";
          process.env.PLIVO_AUTH_TOKEN = "secret";
        }
        const fromEnv = resolveVoiceCallConfig(createBaseConfig(provider));
        expect(validateProviderConfig(fromEnv)).toMatchObject({ valid: true, errors: [] });
      }
    });
  });

  describe("twilio provider", () => {
    it("passes validation with mixed config and env vars", () => {
      process.env.TWILIO_AUTH_TOKEN = "secret";
      let config = createBaseConfig("twilio");
      config.twilio = { accountSid: "AC123" };
      config = resolveVoiceCallConfig(config);

      const result = validateProviderConfig(config);

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("resolves the Twilio from number from environment", () => {
      process.env.TWILIO_ACCOUNT_SID = "AC123";
      process.env.TWILIO_AUTH_TOKEN = "secret";
      process.env.TWILIO_FROM_NUMBER = "+15550001234";

      const config = resolveVoiceCallConfig({
        ...createBaseConfig("twilio"),
        fromNumber: undefined,
      });

      expect(config.fromNumber).toBe("+15550001234");
      expect(validateProviderConfig(config)).toMatchObject({ valid: true, errors: [] });
    });

    it("fails validation when required twilio credentials are missing", () => {
      process.env.TWILIO_AUTH_TOKEN = "secret";
      const missingSid = validateProviderConfig(resolveVoiceCallConfig(createBaseConfig("twilio")));
      expect(missingSid.valid).toBe(false);
      expect(missingSid.errors).toContain(
        "plugins.entries.voice-call.config.twilio.accountSid is required (or set TWILIO_ACCOUNT_SID env)",
      );

      delete process.env.TWILIO_AUTH_TOKEN;
      process.env.TWILIO_ACCOUNT_SID = "AC123";
      const missingToken = validateProviderConfig(
        resolveVoiceCallConfig(createBaseConfig("twilio")),
      );
      expect(missingToken.valid).toBe(false);
      expect(missingToken.errors).toContain(
        "plugins.entries.voice-call.config.twilio.authToken is required (or set TWILIO_AUTH_TOKEN env)",
      );
    });
  });

  describe("telnyx provider", () => {
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

    it("requires a public key unless signature verification is skipped", () => {
      const missingPublicKey = createBaseConfig("telnyx");
      missingPublicKey.inboundPolicy = "allowlist";
      missingPublicKey.telnyx = { apiKey: "KEY123", connectionId: "CONN456" };
      const missingPublicKeyResult = validateProviderConfig(missingPublicKey);
      expect(missingPublicKeyResult.valid).toBe(false);
      expect(missingPublicKeyResult.errors).toContain(
        "plugins.entries.voice-call.config.telnyx.publicKey is required (or set TELNYX_PUBLIC_KEY env)",
      );

      const withPublicKey = createBaseConfig("telnyx");
      withPublicKey.inboundPolicy = "allowlist";
      withPublicKey.telnyx = {
        apiKey: "KEY123",
        connectionId: "CONN456",
        publicKey: "public-key",
      };
      expect(validateProviderConfig(withPublicKey)).toMatchObject({ valid: true, errors: [] });

      const skippedVerification = createBaseConfig("telnyx");
      skippedVerification.skipSignatureVerification = true;
      skippedVerification.telnyx = { apiKey: "KEY123", connectionId: "CONN456" };
      expect(validateProviderConfig(skippedVerification)).toMatchObject({
        valid: true,
        errors: [],
      });
    });
  });

  describe("plivo provider", () => {
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

  describe("realtime config", () => {
    it("rejects disabled inbound policy for realtime mode", () => {
      const config = createBaseConfig("twilio");
      config.realtime.enabled = true;
      config.inboundPolicy = "disabled";

      const result = validateProviderConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        'plugins.entries.voice-call.config.inboundPolicy must not be "disabled" when realtime.enabled is true',
      );
    });

    it("rejects enabling realtime and streaming together", () => {
      const config = createBaseConfig("twilio");
      config.realtime.enabled = true;
      config.streaming.enabled = true;
      config.inboundPolicy = "allowlist";

      const result = validateProviderConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        "plugins.entries.voice-call.config.realtime.enabled and plugins.entries.voice-call.config.streaming.enabled cannot both be true",
      );
    });
  });
});

describe("resolveVoiceCallConfig", () => {
  it("enables the pre-answer stale call reaper by default", () => {
    const config = resolveVoiceCallConfig({ enabled: true, provider: "mock" });

    expect(config.staleCallReaperSeconds).toBe(120);
  });
});

describe("normalizeVoiceCallConfig", () => {
  it("fills nested runtime defaults from a partial config boundary", () => {
    const normalized = normalizeVoiceCallConfig({
      enabled: true,
      provider: "mock",
      streaming: {
        enabled: true,
        streamPath: "/custom-stream",
      },
    });

    expect(normalized.serve.path).toBe("/voice/webhook");
    expect(normalized.streaming.streamPath).toBe("/custom-stream");
    expect(normalized.streaming.provider).toBeUndefined();
    expect(normalized.streaming.providers).toEqual({});
    expect(normalized.realtime.streamPath).toBe("/voice/stream/realtime");
    expect(normalized.realtime.toolPolicy).toBe("safe-read-only");
    expect(normalized.realtime.instructions).toContain("openclaw_agent_consult");
    expect(normalized.tunnel.provider).toBe("none");
    expect(normalized.webhookSecurity.allowedHosts).toEqual([]);
  });

  it("derives the realtime stream path from a custom webhook path", () => {
    const normalized = normalizeVoiceCallConfig({
      enabled: true,
      provider: "twilio",
      serve: {
        path: "/custom/webhook",
      },
    });

    expect(normalized.realtime.streamPath).toBe("/custom/stream/realtime");
  });

  it("accepts partial nested TTS overrides and preserves nested objects", () => {
    const normalized = normalizeVoiceCallConfig({
      tts: {
        provider: "elevenlabs",
        providers: {
          elevenlabs: {
            apiKey: {
              source: "env",
              provider: "elevenlabs",
              id: "ELEVENLABS_API_KEY",
            },
            voiceSettings: {
              speed: 1.1,
            },
          },
        },
      },
    });

    const { tts, elevenlabs } = requireElevenLabsTtsConfig(normalized);
    expect(tts.provider).toBe("elevenlabs");
    expect(elevenlabs.apiKey).toEqual({
      source: "env",
      provider: "elevenlabs",
      id: "ELEVENLABS_API_KEY",
    });
    expect(elevenlabs.voiceSettings).toEqual({ speed: 1.1 });
  });
});

describe("resolveVoiceCallConfig", () => {
  it("preserves configured realtime instructions without env indirection", () => {
    const resolved = resolveVoiceCallConfig({
      enabled: true,
      provider: "twilio",
      realtime: {
        enabled: true,
        instructions: "Stay concise.",
      },
    });

    expect(resolved.realtime.instructions).toBe("Stay concise.");
    expect(resolved.realtime.toolPolicy).toBe("safe-read-only");
    expect(resolved.realtime.provider).toBeUndefined();
  });

  it("leaves responseModel unset so voice responses can inherit runtime defaults", () => {
    const resolved = resolveVoiceCallConfig({
      enabled: true,
      provider: "mock",
    });

    expect(resolved.responseModel).toBeUndefined();
  });

  it("preserves the configured voice response agent id", () => {
    const resolved = resolveVoiceCallConfig({
      enabled: true,
      provider: "mock",
      agentId: "voice",
    });

    expect(resolved.agentId).toBe("voice");
  });
});
