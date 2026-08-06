// Plugin SDK tests cover vendor token-limit field mapping in live discovery.
import { describe, expect, it } from "vitest";
import { buildOpenAICompatibleLiveModels } from "./provider-catalog-live-normalize.internal.js";
import type { ModelProviderConfig } from "./provider-model-shared.js";

/** Seed with no context/output hints so resolution comes from the row alone. */
const fallback = {
  baseUrl: "https://api.example.com",
  api: "anthropic-messages",
  models: [],
} as unknown as ModelProviderConfig;

function firstModel(row: Record<string, unknown>) {
  const [model] = buildOpenAICompatibleLiveModels([{ object: "model", ...row }], fallback);
  return model;
}

describe("live discovery vendor token-limit fields", () => {
  it("reads Anthropic's max_input_tokens and max_tokens", () => {
    // Anthropic names the context window by its input side and the output cap
    // as max_tokens; before this mapping both fell back to generic defaults.
    const model = firstModel({
      id: "claude-future-1",
      max_input_tokens: 1_000_000,
      max_tokens: 128_000,
    });
    expect(model?.contextWindow).toBe(1_000_000);
    expect(model?.maxTokens).toBe(128_000);
  });

  it("still prefers completion-specific output names when a row carries both", () => {
    const model = firstModel({
      id: "dual-field-model",
      context_length: 200_000,
      max_completion_tokens: 16_000,
      max_tokens: 999_999,
    });
    expect(model?.contextWindow).toBe(200_000);
    expect(model?.maxTokens).toBe(16_000);
  });

  it("leaves OpenAI-shaped rows resolving exactly as before", () => {
    const model = firstModel({
      id: "openai-shaped-model",
      context_window: 128_000,
      max_output_tokens: 32_000,
    });
    expect(model?.contextWindow).toBe(128_000);
    expect(model?.maxTokens).toBe(32_000);
  });

  it("keeps the previous defaults when a row advertises no limits", () => {
    const model = firstModel({ id: "bare-model" });
    expect(model?.contextWindow).toBe(128_000);
    expect(model?.maxTokens).toBe(8192);
  });
});
