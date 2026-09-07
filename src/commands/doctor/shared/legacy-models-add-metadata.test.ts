// Legacy model metadata tests cover doctor migration that adds model metadata.
import { describe, expect, it } from "vitest";
import type { ModelDefinitionConfig } from "../../../config/types.models.js";
import { isLegacyModelsAddCodexMetadataModel } from "./legacy-models-add-metadata.js";

function buildLegacyModel(
  id: string,
  api: "openai-codex-responses" | "openai-chatgpt-responses" = "openai-codex-responses",
): Partial<ModelDefinitionConfig> {
  return {
    id,
    api: api as ModelDefinitionConfig["api"],
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
    contextWindow: 400_000,
    contextTokens: 272_000,
    maxTokens: 128_000,
  };
}

describe("isLegacyModelsAddCodexMetadataModel", () => {
  it("matches the legacy gpt-5.5-pro models-add fingerprint", () => {
    expect(
      isLegacyModelsAddCodexMetadataModel({
        provider: "openai-codex",
        model: buildLegacyModel("gpt-5.5-pro"),
      }),
    ).toBe(true);
  });

  it("also matches the normalized ChatGPT API value before rewrite", () => {
    expect(
      isLegacyModelsAddCodexMetadataModel({
        provider: "openai-codex",
        model: buildLegacyModel("gpt-5.5-pro", "openai-chatgpt-responses"),
      }),
    ).toBe(true);
  });

  it("does not match current pro pricing as legacy models-add metadata", () => {
    expect(
      isLegacyModelsAddCodexMetadataModel({
        provider: "openai-codex",
        model: {
          ...buildLegacyModel("gpt-5.5-pro"),
          cost: { input: 30, output: 180, cacheRead: 0, cacheWrite: 0 },
        },
      }),
    ).toBe(false);
  });
});
