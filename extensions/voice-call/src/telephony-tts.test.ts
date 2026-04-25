import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceCallTtsConfig } from "./config.js";
import type { CoreConfig } from "./core-bridge.js";
import { createTelephonyTtsProvider } from "./telephony-tts.js";

function createCoreConfig(): CoreConfig {
  const tts: VoiceCallTtsConfig = {
    provider: "openai",
    providers: {
      openai: {
        model: "gpt-4o-mini-tts",
        voice: "alloy",
      },
    },
  };
  return { messages: { tts } };
}

function requireMergedTtsConfig(mergedConfig: CoreConfig | undefined) {
  const tts = mergedConfig?.messages?.tts;
  if (!tts) {
    throw new Error("telephony TTS runtime did not receive merged TTS config");
  }
  return tts as Record<string, unknown>;
}

function requireOpenAIProviderConfig(tts: Record<string, unknown>): Record<string, unknown> {
  const providers =
    tts.providers && typeof tts.providers === "object"
      ? (tts.providers as Record<string, unknown>)
      : null;
  const openai = providers?.openai;
  if (!openai || typeof openai !== "object") {
    throw new Error("merged TTS config did not preserve providers.openai");
  }
  return openai as Record<string, unknown>;
}

async function mergeOverride(override: unknown): Promise<Record<string, unknown>> {
  let mergedConfig: CoreConfig | undefined;
  const provider = createTelephonyTtsProvider({
    coreConfig: createCoreConfig(),
    ttsOverride: override as VoiceCallTtsConfig,
    runtime: {
      textToSpeechTelephony: async ({ cfg }) => {
        mergedConfig = cfg;
        return {
          success: true,
          audioBuffer: Buffer.alloc(2),
          sampleRate: 8000,
        };
      },
    },
  });

  await provider.synthesizeForTelephony("hello");
  return requireMergedTtsConfig(mergedConfig);
}

afterEach(() => {
  delete (Object.prototype as Record<string, unknown>).polluted;
});

describe("createTelephonyTtsProvider deepMerge hardening", () => {
  it("merges safe nested overrides", async () => {
    const tts = await mergeOverride({
      providers: { openai: { voice: "coral" } },
    });
    const openai = requireOpenAIProviderConfig(tts);

    expect(openai.voice).toBe("coral");
    expect(openai.model).toBe("gpt-4o-mini-tts");
  });

  it("blocks top-level __proto__ keys", async () => {
    const tts = await mergeOverride(
      JSON.parse('{"__proto__":{"polluted":"top"},"providers":{"openai":{"voice":"coral"}}}'),
    );
    const openai = requireOpenAIProviderConfig(tts);

    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
    expect(tts.polluted).toBeUndefined();
    expect(openai.voice).toBe("coral");
  });

  it("blocks nested __proto__ keys", async () => {
    const tts = await mergeOverride(
      JSON.parse('{"providers":{"openai":{"model":"safe","__proto__":{"polluted":"nested"}}}}'),
    );
    const openai = requireOpenAIProviderConfig(tts);

    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
    expect(openai.polluted).toBeUndefined();
    expect(openai.model).toBe("safe");
  });

  it("logs fallback metadata when telephony TTS uses a fallback provider", async () => {
    const warn = vi.fn();
    const provider = createTelephonyTtsProvider({
      coreConfig: createCoreConfig(),
      runtime: {
        textToSpeechTelephony: async () => ({
          success: true,
          audioBuffer: Buffer.alloc(2),
          sampleRate: 8000,
          provider: "microsoft",
          fallbackFrom: "elevenlabs",
          attemptedProviders: ["elevenlabs", "microsoft"],
        }),
      },
      logger: { warn },
    });

    await provider.synthesizeForTelephony("hello");
    expect(warn).toHaveBeenCalledWith(
      "[voice-call] Telephony TTS fallback used from=elevenlabs to=microsoft attempts=elevenlabs -> microsoft",
    );
  });

  it("exposes configured timeoutMs as synthesisTimeoutMs", () => {
    const provider = createTelephonyTtsProvider({
      coreConfig: { messages: { tts: { provider: "openai", timeoutMs: 15000 } } },
      runtime: {
        textToSpeechTelephony: async () => ({
          success: true,
          audioBuffer: Buffer.alloc(2),
          sampleRate: 8000,
        }),
      },
    });

    expect(provider.synthesisTimeoutMs).toBe(15000);
  });

  it("keeps the telephony timeout default when timeoutMs is not configured", () => {
    const provider = createTelephonyTtsProvider({
      coreConfig: createCoreConfig(),
      runtime: {
        textToSpeechTelephony: async () => ({
          success: true,
          audioBuffer: Buffer.alloc(2),
          sampleRate: 8000,
        }),
      },
    });

    expect(provider.synthesisTimeoutMs).toBe(8000);
  });
});
