import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
// Voice Call tests cover telephony tts plugin behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { describe, expect, it, vi } from "vitest";
import type { VoiceCallTtsConfig } from "./config.js";
import { createTelephonyTtsProvider, type TelephonyTtsRuntime } from "./telephony-tts.js";

function createCoreConfig(): OpenClawConfig {
  const tts: VoiceCallTtsConfig = {
    provider: "openai",
    providers: {
      openai: {
        model: "gpt-4o-mini-tts",
        voice: "alloy",
      },
    },
  };
  return { tts };
}

const passthroughPreparation: TelephonyTtsRuntime["prepareTtsRequest"] = async ({ cfg, text }) => ({
  cfg,
  directives: {
    cleanedText: text,
    hasDirective: false,
    overrides: {},
    warnings: [],
  },
});

function createRuntime(
  textToSpeechTelephony: TelephonyTtsRuntime["textToSpeechTelephony"],
  prepareTtsRequest: TelephonyTtsRuntime["prepareTtsRequest"] = passthroughPreparation,
): TelephonyTtsRuntime {
  return { prepareTtsRequest, textToSpeechTelephony };
}

describe("createTelephonyTtsProvider", () => {
  it("uses shared preparation for the surface override and request text", async () => {
    const effectiveConfig: OpenClawConfig = {
      tts: { provider: "openai", timeoutMs: 15_000 },
    };
    const prepareTtsRequest = vi.fn<TelephonyTtsRuntime["prepareTtsRequest"]>(
      async ({ cfg, override, text }) => ({
        cfg: override ? effectiveConfig : cfg,
        directives: {
          cleanedText: text,
          hasDirective: false,
          overrides: {},
          warnings: [],
        },
      }),
    );
    const textToSpeechTelephony = vi.fn(async () => ({
      success: true,
      audioBuffer: Buffer.alloc(2),
      sampleRate: 8000,
    }));
    const override: VoiceCallTtsConfig = { timeoutMs: 15_000 };
    const provider = await createTelephonyTtsProvider({
      coreConfig: createCoreConfig(),
      ttsOverride: override,
      runtime: createRuntime(textToSpeechTelephony, prepareTtsRequest),
    });

    await provider.synthesizeForTelephony("hello");

    expect(provider.synthesisTimeoutMs).toBe(15_000);
    expect(prepareTtsRequest).toHaveBeenNthCalledWith(1, {
      cfg: createCoreConfig(),
      override,
      text: "",
    });
    expect(prepareTtsRequest).toHaveBeenNthCalledWith(2, {
      cfg: effectiveConfig,
      text: "hello",
    });
    expect(textToSpeechTelephony).toHaveBeenCalledWith({
      text: "hello",
      cfg: effectiveConfig,
      overrides: {},
    });
  });

  it("logs fallback metadata when telephony TTS uses a fallback provider", async () => {
    const warn = vi.fn();
    const provider = await createTelephonyTtsProvider({
      coreConfig: createCoreConfig(),
      runtime: createRuntime(async () => ({
        success: true,
        audioBuffer: Buffer.alloc(2),
        sampleRate: 8000,
        provider: "microsoft",
        fallbackFrom: "elevenlabs",
        attemptedProviders: ["elevenlabs", "microsoft"],
      })),
      logger: { warn },
    });

    await provider.synthesizeForTelephony("hello");
    expect(warn).toHaveBeenCalledWith(
      "[voice-call] Telephony TTS fallback used from=elevenlabs to=microsoft attempts=elevenlabs -> microsoft",
    );
  });

  it("uses prepared directive-stripped text for synthesis", async () => {
    const textToSpeechTelephony = vi.fn(async () => ({
      success: true,
      audioBuffer: Buffer.alloc(2),
      sampleRate: 8000,
    }));
    const provider = await createTelephonyTtsProvider({
      coreConfig: createCoreConfig(),
      runtime: createRuntime(textToSpeechTelephony, async ({ cfg, text }) => ({
        cfg,
        directives: {
          cleanedText: text ? "Hello caller" : "",
          hasDirective: text.length > 0,
          overrides: {},
          warnings: [],
        },
      })),
    });

    await provider.synthesizeForTelephony("[[tts]]Hello caller[[/tts]]");

    expect(textToSpeechTelephony).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Hello caller" }),
    );
  });

  it("uses prepared hidden directive text and overrides for synthesis", async () => {
    const textToSpeechTelephony = vi.fn(async () => ({
      success: true,
      audioBuffer: Buffer.alloc(2),
      sampleRate: 8000,
    }));
    const provider = await createTelephonyTtsProvider({
      coreConfig: createCoreConfig(),
      runtime: createRuntime(textToSpeechTelephony, async ({ cfg, text }) => ({
        cfg,
        directives: {
          cleanedText: text ? "Visible text " : "",
          ttsText: text ? "Speak this instead" : undefined,
          hasDirective: text.length > 0,
          overrides: text ? { ttsText: "Speak this instead" } : {},
          warnings: [],
        },
      })),
    });

    await provider.synthesizeForTelephony(
      "Visible text [[tts:text]]Speak this instead[[/tts:text]]",
    );

    expect(textToSpeechTelephony).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Speak this instead",
        overrides: { ttsText: "Speak this instead" },
      }),
    );
  });

  it("exposes configured timeoutMs as synthesisTimeoutMs", async () => {
    const provider = await createTelephonyTtsProvider({
      coreConfig: { tts: { provider: "openai", timeoutMs: 15000 } },
      runtime: createRuntime(async () => ({
        success: true,
        audioBuffer: Buffer.alloc(2),
        sampleRate: 8000,
      })),
    });

    expect(provider.synthesisTimeoutMs).toBe(15000);
  });

  it("clamps oversized configured timeoutMs", async () => {
    const provider = await createTelephonyTtsProvider({
      coreConfig: {
        tts: { provider: "openai", timeoutMs: Number.MAX_SAFE_INTEGER },
      },
      runtime: createRuntime(async () => ({
        success: true,
        audioBuffer: Buffer.alloc(2),
        sampleRate: 8000,
      })),
    });

    expect(provider.synthesisTimeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("keeps the telephony timeout default when timeoutMs is not configured", async () => {
    const provider = await createTelephonyTtsProvider({
      coreConfig: createCoreConfig(),
      runtime: createRuntime(async () => ({
        success: true,
        audioBuffer: Buffer.alloc(2),
        sampleRate: 8000,
      })),
    });

    expect(provider.synthesisTimeoutMs).toBe(8000);
  });
});
