import { describe, expect, it } from "vitest";
import { TALK_TEST_PROVIDER_ID } from "../test-utils/talk-test-provider.js";
import { buildTalkConfigResponse, normalizeTalkSection } from "./talk.js";

describe("talk normalization", () => {
  it("keeps core Talk normalization generic and ignores legacy provider-flat fields", () => {
    const normalized = normalizeTalkSection({
      voiceId: "voice-123",
      voiceAliases: { Clawd: "VoiceAlias1234567890" },
      modelId: "eleven_v3",
      outputFormat: "pcm_44100",
      apiKey: "secret-key", // pragma: allowlist secret
      consultThinkingLevel: " low ",
      consultFastMode: true,
      speechLocale: " ru-RU ",
      interruptOnSpeech: false,
      silenceTimeoutMs: 1500,
    } as unknown as never);

    expect(normalized).toEqual({
      speechLocale: "ru-RU",
      consultThinkingLevel: "low",
      consultFastMode: true,
      interruptOnSpeech: false,
      silenceTimeoutMs: 1500,
    });
  });

  it("uses new provider/providers shape directly when present", () => {
    const normalized = normalizeTalkSection({
      provider: "acme",
      providers: {
        acme: {
          voiceId: "acme-voice",
          custom: true,
        },
      },
      realtime: {
        provider: "openai",
        providers: {
          openai: {
            model: "gpt-realtime",
          },
        },
        model: "gpt-realtime",
        voice: "alloy",
        mode: "realtime",
        transport: "webrtc",
        brain: "agent-consult",
      },
      interruptOnSpeech: true,
    });

    expect(normalized).toEqual({
      provider: "acme",
      providers: {
        acme: {
          voiceId: "acme-voice",
          custom: true,
        },
      },
      realtime: {
        provider: "openai",
        providers: {
          openai: {
            model: "gpt-realtime",
          },
        },
        model: "gpt-realtime",
        voice: "alloy",
        mode: "realtime",
        transport: "webrtc",
        brain: "agent-consult",
      },
      interruptOnSpeech: true,
    });
  });

  it("merges duplicate provider ids after trimming", () => {
    const normalized = normalizeTalkSection({
      provider: " elevenlabs ",
      providers: {
        " elevenlabs ": {
          voiceId: "voice-123",
        },
        elevenlabs: {
          apiKey: "secret-key",
        },
      },
    });

    expect(normalized).toEqual({
      provider: "elevenlabs",
      providers: {
        elevenlabs: {
          voiceId: "voice-123",
          apiKey: "secret-key",
        },
      },
    });
  });

  it("builds a canonical resolved talk payload for clients", () => {
    const payload = buildTalkConfigResponse({
      provider: "acme",
      providers: {
        acme: {
          voiceId: "acme-voice",
          modelId: "acme-model",
        },
      },
      speechLocale: "ru-RU",
      interruptOnSpeech: true,
    });

    expect(payload).toEqual({
      provider: "acme",
      providers: {
        acme: {
          voiceId: "acme-voice",
          modelId: "acme-model",
        },
      },
      resolved: {
        provider: "acme",
        config: {
          voiceId: "acme-voice",
          modelId: "acme-model",
        },
      },
      speechLocale: "ru-RU",
      interruptOnSpeech: true,
    });
  });

  it("preserves normalized realtime instructions in talk.config payloads", () => {
    const payload = buildTalkConfigResponse({
      realtime: {
        provider: "openai",
        providers: {
          openai: {
            model: "gpt-realtime",
            voice: "alloy",
          },
        },
        instructions: " Speak with crisp diction. ",
      },
    });

    expect(payload?.realtime?.provider).toBe("openai");
    expect(payload?.realtime?.instructions).toBe("Speak with crisp diction.");
  });

  it("does not report an active provider when the configured speech provider cannot resolve", () => {
    const mismatchPayload = buildTalkConfigResponse({
      provider: "acme",
      providers: {
        elevenlabs: {
          voiceId: "voice-123",
        },
      },
    });
    expect(mismatchPayload).toEqual({
      providers: {
        elevenlabs: {
          voiceId: "voice-123",
        },
      },
    });

    const ambiguousPayload = buildTalkConfigResponse({
      providers: {
        acme: {
          voiceId: "voice-acme",
        },
        elevenlabs: {
          voiceId: "voice-123",
        },
      },
    });
    expect(ambiguousPayload).toEqual({
      providers: {
        acme: {
          voiceId: "voice-acme",
        },
        elevenlabs: {
          voiceId: "voice-123",
        },
      },
    });
  });

  it("preserves SecretRef apiKey values during normalization", () => {
    const normalized = normalizeTalkSection({
      provider: TALK_TEST_PROVIDER_ID,
      providers: {
        [TALK_TEST_PROVIDER_ID]: {
          apiKey: { source: "env", provider: "default", id: "ELEVENLABS_API_KEY" },
        },
      },
    });

    expect(normalized).toEqual({
      provider: TALK_TEST_PROVIDER_ID,
      providers: {
        [TALK_TEST_PROVIDER_ID]: {
          apiKey: { source: "env", provider: "default", id: "ELEVENLABS_API_KEY" },
        },
      },
    });
  });

  it("does not inject provider apiKey defaults during snapshot materialization", () => {
    const payload = buildTalkConfigResponse({
      voiceId: "voice-123",
    });

    expect(payload?.provider).toBe("elevenlabs");
    expect(payload?.resolved?.config.voiceId).toBe("voice-123");
    expect(payload?.resolved?.config.apiKey).toBeUndefined();
  });
});
