// Zai tests cover model definitions plugin behavior.
import { describe, expect, it } from "vitest";
import {
  buildZaiCatalogModels,
  buildZaiModelDefinition,
  ZAI_DEFAULT_COST,
} from "./model-definitions.js";

type ExpectedZaiModelFields = {
  id: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: typeof ZAI_DEFAULT_COST;
};

function expectZaiModelFields(expected: ExpectedZaiModelFields) {
  const model = buildZaiModelDefinition({ id: expected.id });
  expect(model.id).toBe(expected.id);
  if ("reasoning" in expected) {
    expect(model.reasoning).toBe(expected.reasoning);
  }
  if (expected.input) {
    expect(model.input).toEqual(expected.input);
  }
  if (expected.contextWindow !== undefined) {
    expect(model.contextWindow).toBe(expected.contextWindow);
  }
  if (expected.maxTokens !== undefined) {
    expect(model.maxTokens).toBe(expected.maxTokens);
  }
  if (expected.cost) {
    expect(model.cost).toEqual(expected.cost);
  }
}

describe("zai model definitions", () => {
  it("uses GLM-5.3 Coding Plan catalog metadata", () => {
    expectZaiModelFields({
      id: "glm-5.3",
      reasoning: true,
      input: ["text"],
      contextWindow: 1_048_576,
      maxTokens: 131_072,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    expect(buildZaiCatalogModels().find((model) => model.id === "glm-5.3")?.compat).toEqual({
      codeMode: "preferred",
    });
  });

  it("uses official GLM-5.2 Coding Plan metadata", () => {
    expectZaiModelFields({
      id: "glm-5.2",
      reasoning: true,
      input: ["text"],
      contextWindow: 1_000_000,
      maxTokens: 131_072,
      cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
    });
  });

  it("uses current OpenClaw metadata for the new GLM-5.1 model", () => {
    expectZaiModelFields({
      id: "glm-5.1",
      reasoning: true,
      input: ["text"],
      contextWindow: 200_000,
      maxTokens: 131_072,
      cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
    });
  });

  it("uses official GLM-5-Turbo metadata", () => {
    expectZaiModelFields({
      id: "glm-5-turbo",
      reasoning: true,
      input: ["text"],
      contextWindow: 200_000,
      maxTokens: 131_072,
      cost: { input: 1.2, output: 4, cacheRead: 0.24, cacheWrite: 0 },
    });
  });

  it("uses official GLM-5V-Turbo metadata", () => {
    expectZaiModelFields({
      id: "glm-5v-turbo",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 200_000,
      maxTokens: 131_072,
      cost: { input: 1.2, output: 4, cacheRead: 0.24, cacheWrite: 0 },
    });
  });
});
