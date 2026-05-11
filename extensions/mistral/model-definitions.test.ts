import { describe, expect, it } from "vitest";
import {
  buildMistralCatalogModels,
  buildMistralModelDefinition,
  MISTRAL_DEFAULT_CONTEXT_WINDOW,
  MISTRAL_DEFAULT_COST,
  MISTRAL_DEFAULT_MAX_TOKENS,
  MISTRAL_DEFAULT_MODEL_ID,
} from "./model-definitions.js";

function catalogModelById(models: ReturnType<typeof buildMistralCatalogModels>, id: string) {
  const model = models.find((candidate) => candidate.id === id);
  if (!model) {
    throw new Error(`expected Mistral catalog model ${id}`);
  }
  return model;
}

describe("mistral model definitions", () => {
  it("uses current Pi pricing for the bundled default model", () => {
    const model = buildMistralModelDefinition();
    expect(model.id).toBe(MISTRAL_DEFAULT_MODEL_ID);
    expect(model.contextWindow).toBe(MISTRAL_DEFAULT_CONTEXT_WINDOW);
    expect(model.maxTokens).toBe(MISTRAL_DEFAULT_MAX_TOKENS);
    expect(model.cost).toEqual(MISTRAL_DEFAULT_COST);

    expect(MISTRAL_DEFAULT_COST).toEqual({
      input: 0.5,
      output: 1.5,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it("publishes a curated set of current Mistral catalog models", () => {
    const models = buildMistralCatalogModels();
    const codestral = catalogModelById(models, "codestral-latest");
    expect(codestral.input).toEqual(["text"]);
    expect(codestral.contextWindow).toBe(256000);
    expect(codestral.maxTokens).toBe(4096);

    const magistralSmall = catalogModelById(models, "magistral-small");
    expect(magistralSmall.reasoning).toBe(true);
    expect(magistralSmall.input).toEqual(["text"]);
    expect(magistralSmall.contextWindow).toBe(128000);
    expect(magistralSmall.maxTokens).toBe(40000);

    const medium = catalogModelById(models, "mistral-medium-3-5");
    expect(medium.reasoning).toBe(true);
    expect(medium.input).toEqual(["text", "image"]);
    expect(medium.contextWindow).toBe(262144);
    expect(medium.maxTokens).toBe(8192);

    const smallLatest = catalogModelById(models, "mistral-small-latest");
    expect(smallLatest.reasoning).toBe(true);
    expect(smallLatest.input).toEqual(["text", "image"]);
    expect(smallLatest.contextWindow).toBe(128000);
    expect(smallLatest.maxTokens).toBe(16384);

    const pixtralLarge = catalogModelById(models, "pixtral-large-latest");
    expect(pixtralLarge.input).toEqual(["text", "image"]);
    expect(pixtralLarge.contextWindow).toBe(128000);
    expect(pixtralLarge.maxTokens).toBe(32768);
  });
});
