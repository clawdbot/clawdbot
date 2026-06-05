// TTS core tests cover provider selection, synthesis, and error handling.
import { describe, expect, it, vi } from "vitest";
import type { ResolvedProviderAuth } from "../agents/model-auth-runtime-shared.js";
import { AuthStorage, ModelRegistry } from "../agents/sessions/index.js";
import type { AssistantMessage, Model, Usage } from "../llm/types.js";
import { MAX_TIMER_TIMEOUT_MS } from "../shared/number-coercion.js";
import type { SpeechModelOverridePolicy } from "./provider-types.js";
import { summarizeText } from "./tts-core.js";
import type { ResolvedTtsConfig } from "./tts-types.js";

const modelOverridePolicy: SpeechModelOverridePolicy = {
  enabled: false,
  allowText: false,
  allowProvider: false,
  allowVoice: false,
  allowModelId: false,
  allowVoiceSettings: false,
  allowNormalization: false,
  allowSeed: false,
};

const usage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

describe("TTS core", () => {
  it("clamps oversized summarization timeout timers", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const model = {
        id: "test-model",
        name: "Test Model",
        api: "test-api",
        provider: "test-provider",
        baseUrl: "https://example.test",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4096,
        maxTokens: 1024,
      } satisfies Model;
      const config = {
        auto: "off",
        mode: "final",
        provider: "test-provider",
        providerSource: "config",
        personas: {},
        summaryModel: "test-provider/test-model",
        modelOverrides: modelOverridePolicy,
        providerConfigs: {},
        maxTextLength: 10_000,
        timeoutMs: 10_000,
      } satisfies ResolvedTtsConfig;
      const auth = {
        apiKey: "key",
        source: "test",
        mode: "api-key",
      } satisfies ResolvedProviderAuth;
      const authStorage = AuthStorage.inMemory();
      const modelRegistry = ModelRegistry.inMemory(authStorage);
      const assistant = {
        role: "assistant",
        content: [{ type: "text", text: "Short summary." }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        stopReason: "stop",
        usage,
        timestamp: Date.now(),
      } satisfies AssistantMessage;

      const result = await summarizeText(
        {
          text: "Long text that should be summarized for speech.",
          targetLength: 120,
          cfg: {},
          config,
          timeoutMs: MAX_TIMER_TIMEOUT_MS + 1,
        },
        {
          completeSimple: vi.fn(async () => assistant),
          getApiKeyForModel: vi.fn(async () => auth),
          prepareModelForSimpleCompletion: vi.fn(() => model),
          requireApiKey: vi.fn(() => "key"),
          resolveModelAsync: vi.fn(async () => ({
            model,
            authStorage,
            modelRegistry,
          })),
        },
      );

      expect(result.summary).toBe("Short summary.");
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });
});
