// Plugin SDK tests cover the live-discovery unknown-model gate.
import { describe, expect, it } from "vitest";
import { buildOpenAICompatibleLiveModels } from "./provider-catalog-live-normalize.internal.js";
import type { ModelProviderConfig } from "./provider-model-shared.js";

const fallback = {
  baseUrl: "https://api.example.com",
  api: "anthropic-messages",
  models: [
    {
      id: "known-model",
      name: "Known",
      reasoning: true,
      input: ["text"],
      cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    },
  ],
} as unknown as ModelProviderConfig;

const rows = [
  { id: "known-model", object: "model" },
  { id: "brand-new-model", object: "model" },
];

describe("live discovery unknown-model gate", () => {
  it("publishes discovered models unchanged when no gate is supplied", () => {
    const ids = buildOpenAICompatibleLiveModels(rows, fallback).map((m) => m.id);
    expect(ids).toContain("known-model");
    expect(ids).toContain("brand-new-model");
  });

  it("drops only the ids the manifest does not publish when the gate rejects", () => {
    const seen: string[] = [];
    const models = buildOpenAICompatibleLiveModels(rows, fallback, ({ id }) => {
      seen.push(id);
      return false;
    });
    // The manifest-published row bypasses the gate entirely and survives.
    expect(models.map((m) => m.id)).toEqual(["known-model"]);
    expect(seen).toEqual(["brand-new-model"]);
  });

  it("keeps the manifest entry verbatim for published ids", () => {
    const [model] = buildOpenAICompatibleLiveModels(rows, fallback, () => false);
    expect(model).toEqual(fallback.models[0]);
  });

  it("admits unknown ids the gate accepts", () => {
    const ids = buildOpenAICompatibleLiveModels(rows, fallback, () => true).map((m) => m.id);
    expect(ids).toEqual(["brand-new-model", "known-model"]);
  });
});
