import { describe, expect, it } from "vitest";

import {
  buildXaiModelDefinition,
  discoverXaiModels,
  XAI_BASE_URL,
  XAI_DEFAULT_COST,
  XAI_DEFAULT_MODEL_ID,
  XAI_MODEL_CATALOG,
} from "./xai-models.js";

describe("XAI_MODEL_CATALOG", () => {
  it("contains expected model series", () => {
    const ids = XAI_MODEL_CATALOG.map((m) => m.id);

    // Grok 4.1 series
    expect(ids).toContain("grok-4-1-fast-reasoning");
    expect(ids).toContain("grok-4-1-fast-non-reasoning");

    // Grok 4 series
    expect(ids).toContain("grok-4-07-09");
    expect(ids).toContain("grok-4-fast-reasoning");
    expect(ids).toContain("grok-4-fast-non-reasoning");

    // Grok 3 series
    expect(ids).toContain("grok-3-beta");
    expect(ids).toContain("grok-3-mini-beta");

    // Grok 2 series
    expect(ids).toContain("grok-2-1212");
    expect(ids).toContain("grok-2-vision-1212");

    // Specialized
    expect(ids).toContain("grok-code-fast-1");
  });

  it("marks reasoning models correctly", () => {
    const reasoningModels = XAI_MODEL_CATALOG.filter((m) => m.reasoning);
    const reasoningIds = reasoningModels.map((m) => m.id);

    expect(reasoningIds).toContain("grok-4-1-fast-reasoning");
    expect(reasoningIds).toContain("grok-4-fast-reasoning");
    expect(reasoningIds).toContain("grok-code-fast-1");

    // Non-reasoning models should not be in this list
    expect(reasoningIds).not.toContain("grok-4-1-fast-non-reasoning");
    expect(reasoningIds).not.toContain("grok-3-beta");
  });

  it("marks vision models with image input", () => {
    const visionModels = XAI_MODEL_CATALOG.filter((m) => m.input.includes("image"));
    const visionIds = visionModels.map((m) => m.id);

    expect(visionIds).toContain("grok-4-1-fast-reasoning");
    expect(visionIds).toContain("grok-4-1-fast-non-reasoning");
    expect(visionIds).toContain("grok-2-vision-1212");

    // Text-only models should not have image input
    expect(visionIds).not.toContain("grok-3-beta");
    expect(visionIds).not.toContain("grok-4-07-09");
  });
});

describe("buildXaiModelDefinition", () => {
  it("builds a valid ModelDefinitionConfig from catalog entry", () => {
    const entry = XAI_MODEL_CATALOG.find((m) => m.id === "grok-3-beta")!;
    const config = buildXaiModelDefinition(entry);

    expect(config.id).toBe("grok-3-beta");
    expect(config.name).toBe("Grok 3");
    expect(config.reasoning).toBe(false);
    expect(config.input).toEqual(["text"]);
    expect(config.cost).toEqual(XAI_DEFAULT_COST);
    expect(config.contextWindow).toBe(131072);
    expect(config.maxTokens).toBe(8192);
  });

  it("preserves vision input for vision models", () => {
    const entry = XAI_MODEL_CATALOG.find((m) => m.id === "grok-2-vision-1212")!;
    const config = buildXaiModelDefinition(entry);

    expect(config.input).toEqual(["text", "image"]);
  });

  it("preserves reasoning flag for reasoning models", () => {
    const entry = XAI_MODEL_CATALOG.find((m) => m.id === "grok-4-fast-reasoning")!;
    const config = buildXaiModelDefinition(entry);

    expect(config.reasoning).toBe(true);
  });
});

describe("discoverXaiModels", () => {
  it("returns static catalog in test environment", async () => {
    // The function checks for test environment and returns static catalog
    const models = await discoverXaiModels("test-api-key");

    expect(models.length).toBe(XAI_MODEL_CATALOG.length);
    expect(models.map((m) => m.id)).toContain("grok-3-beta");
    expect(models.map((m) => m.id)).toContain("grok-4-1-fast-reasoning");
  });

  it("returns valid ModelDefinitionConfig objects", async () => {
    const models = await discoverXaiModels("test-api-key");

    for (const model of models) {
      expect(model.id).toBeDefined();
      expect(model.name).toBeDefined();
      expect(typeof model.reasoning).toBe("boolean");
      expect(Array.isArray(model.input)).toBe(true);
      expect(model.cost).toBeDefined();
      expect(typeof model.contextWindow).toBe("number");
      expect(typeof model.maxTokens).toBe("number");
    }
  });
});

describe("XAI constants", () => {
  it("has correct base URL", () => {
    expect(XAI_BASE_URL).toBe("https://api.x.ai/v1");
  });

  it("has correct default model ID", () => {
    expect(XAI_DEFAULT_MODEL_ID).toBe("grok-3-beta");
  });

  it("has zero costs (credit-based)", () => {
    expect(XAI_DEFAULT_COST).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });
});
