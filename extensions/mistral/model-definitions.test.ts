// Mistral tests cover model definitions plugin behavior.
import { describe, expect, it } from "vitest";
import { buildMistralModelDefinition, MISTRAL_DEFAULT_MODEL_ID } from "./model-definitions.js";
import { buildMistralProvider } from "./provider-catalog.js";

function buildCatalogModels() {
  return buildMistralProvider().models;
}

function catalogModelById(models: ReturnType<typeof buildCatalogModels>, id: string) {
  const model = models.find((candidate) => candidate.id === id);
  if (!model) {
    throw new Error(`expected Mistral catalog model ${id}`);
  }
  return model;
}

describe("mistral model definitions", () => {
  it("uses current OpenClaw pricing for the bundled default model", () => {
    const model = buildMistralModelDefinition();
    expect(model.id).toBe(MISTRAL_DEFAULT_MODEL_ID);
    expect(model.contextWindow).toBe(262144);
    expect(model.maxTokens).toBe(16384);
    expect(model.cost).toEqual({
      input: 0.5,
      output: 1.5,
      cacheRead: 0.05,
      cacheWrite: 0,
    });
  });

  it("prices cached Mistral input tokens at ten percent of standard input tokens", () => {
    const models = buildCatalogModels();

    for (const model of models) {
      expect(model.cost.cacheRead).toBeCloseTo(model.cost.input * 0.1, 10);
      expect(model.cost.cacheWrite).toBe(0);
    }
  });

  it("charges nonzero cost for cached-token usage on the default model", () => {
    const model = buildMistralModelDefinition();
    const cacheReadTokens = 20_000;
    const cacheReadCost = (model.cost.cacheRead / 1_000_000) * cacheReadTokens;

    expect(cacheReadCost).toBeCloseTo(0.001, 10);
    expect(cacheReadCost).toBeGreaterThan(0);
  });

  it("publishes a curated set of current Mistral catalog models", () => {
    const models = buildCatalogModels();
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
    expect(smallLatest.contextWindow).toBe(262144);
    expect(smallLatest.maxTokens).toBe(16384);
    expect(smallLatest.cost).toEqual({
      input: 0.15,
      output: 0.6,
      cacheRead: 0.015,
      cacheWrite: 0,
    });

    const small4 = catalogModelById(models, "mistral-small-2603");
    expect(small4.reasoning).toBe(true);
    expect(small4.input).toEqual(["text", "image"]);
    expect(small4.contextWindow).toBe(262144);
    expect(small4.maxTokens).toBe(16384);
    expect(small4.cost).toEqual(smallLatest.cost);

    const pixtralLarge = catalogModelById(models, "pixtral-large-latest");
    expect(pixtralLarge.input).toEqual(["text", "image"]);
    expect(pixtralLarge.contextWindow).toBe(128000);
    expect(pixtralLarge.maxTokens).toBe(32768);
  });
});
