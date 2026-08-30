// TTS core tests cover provider selection, synthesis, and error handling.
import { readFileSync } from "node:fs";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it, vi } from "vitest";
import * as modelNormalization from "../agents/provider-model-normalization.runtime.js";
import type { OpenClawConfig } from "../config/types.js";
import type { AssistantMessage, Model, Usage } from "../llm/types.js";
import type { SpeechModelOverridePolicy } from "./provider-types.js";
import { resolveSpeechProviderApiKey, summarizeText } from "./tts-core.js";
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

function createSummarizationFixture(cfg: OpenClawConfig = {}) {
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
  const auth = { apiKey: "key", source: "test", mode: "api-key" } as const;
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
  return {
    params: {
      text: "Long text that should be summarized for speech.",
      targetLength: 120,
      cfg,
      config,
      timeoutMs: MAX_TIMER_TIMEOUT_MS + 1,
    },
    deps: {
      completeWithPreparedSimpleCompletionModel: vi.fn(async () => assistant),
      prepareSimpleCompletionModel: vi.fn(async () => ({ model, auth })),
      requireApiKey: vi.fn(() => "key"),
    },
  };
}

describe("TTS core", () => {
  it("keeps summarization-only LLM modules lazy", () => {
    const source = readFileSync(new URL("./tts-core.ts", import.meta.url), "utf8");

    expect(source).toContain('import("../agents/simple-completion-runtime.js")');
    expect(source).not.toContain('from "../llm/stream.js"');
    expect(source).not.toContain('from "../agents/simple-completion-runtime.js"');
    expect(source).not.toContain('from "../agents/model-auth.js"');
  });

  it("resolves the first non-blank speech provider API key", () => {
    expect(resolveSpeechProviderApiKey(undefined, " \t", "  provider-key  ", "fallback")).toBe(
      "provider-key",
    );
    expect(resolveSpeechProviderApiKey(undefined, "\n")).toBeUndefined();
  });

  it("clamps oversized summarization timeout timers", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const { params, deps } = createSummarizationFixture();
      const result = await summarizeText(params, deps);

      expect(result.summary).toBe("Short summary.");
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it.each(["test-provider/test-model", "speech-summary", "test-provider/speech-summary"])(
    "keeps the summary override %s in its configured model-normalization scope",
    async (summaryModel) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: "unused-provider/default-model" },
            models: {
              "unused-provider/another-model": { alias: "unused" },
              "test-provider/test-model": { alias: "speech-summary" },
            },
          },
        },
      };
      const { params, deps } = createSummarizationFixture(cfg);
      params.config.summaryModel = summaryModel;
      const normalize = vi
        .spyOn(modelNormalization, "normalizeProviderModelIdWithRuntime")
        .mockImplementation((request) => {
          if (request.provider === "unused-provider") {
            throw new Error("A summary override must not initialize the primary provider");
          }
          return request.config === cfg && request.context.modelId === "test-model"
            ? "normalized-summary"
            : undefined;
        });
      try {
        await expect(summarizeText(params, deps)).resolves.toMatchObject({
          summary: "Short summary.",
        });
        expect(deps.prepareSimpleCompletionModel).toHaveBeenCalledWith({
          cfg,
          provider: "test-provider",
          modelId: "normalized-summary",
        });
      } finally {
        normalize.mockRestore();
      }
    },
  );

  it.each(["", "/"])(
    "normalizes the selected primary when summary override is %j",
    async (summaryModel) => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "test-provider/primary-model" } } },
      };
      const { params, deps } = createSummarizationFixture(cfg);
      params.config.summaryModel = summaryModel;
      const normalize = vi
        .spyOn(modelNormalization, "normalizeProviderModelIdWithRuntime")
        .mockReturnValue("normalized-primary");
      try {
        await summarizeText(params, deps);
        expect(deps.prepareSimpleCompletionModel).toHaveBeenCalledWith({
          cfg,
          provider: "test-provider",
          modelId: "normalized-primary",
        });
      } finally {
        normalize.mockRestore();
      }
    },
  );
});
