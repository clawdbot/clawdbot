import { describe, expect, it } from "vitest";
import { buildZaiModelDefinition, ZAI_DEFAULT_COST } from "./model-definitions.js";

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
  it("uses current Pi metadata for the new GLM-5.1 model", () => {
    expectZaiModelFields({
      id: "glm-5.1",
      reasoning: true,
      input: ["text"],
      contextWindow: 202800,
      maxTokens: 131100,
      cost: { input: 1.2, output: 4, cacheRead: 0.24, cacheWrite: 0 },
    });
  });

  it("uses current Pi metadata for the new GLM-5V Turbo model", () => {
    expectZaiModelFields({
      id: "glm-5v-turbo",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 202800,
      maxTokens: 131100,
      cost: { input: 1.2, output: 4, cacheRead: 0.24, cacheWrite: 0 },
    });
  });

  it("uses current Pi metadata for the GLM-5 model", () => {
    expectZaiModelFields({
      id: "glm-5",
      reasoning: true,
      input: ["text"],
      contextWindow: 202800,
      maxTokens: 131100,
      cost: ZAI_DEFAULT_COST,
    });
  });

  it("publishes newer GLM 4.5/4.6 family metadata from Pi", () => {
    expectZaiModelFields({
      id: "glm-4.6v",
      input: ["text", "image"],
      contextWindow: 128000,
      maxTokens: 32768,
      cost: { input: 0.3, output: 0.9, cacheRead: 0, cacheWrite: 0 },
    });
    expectZaiModelFields({
      id: "glm-4.5-air",
      input: ["text"],
      contextWindow: 131072,
      maxTokens: 98304,
      cost: { input: 0.2, output: 1.1, cacheRead: 0.03, cacheWrite: 0 },
    });
  });

  it("keeps the remaining GLM 4.7/5 pricing and token limits aligned with Pi", () => {
    expectZaiModelFields({
      id: "glm-4.7-flash",
      cost: { input: 0.07, output: 0.4, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 131072,
    });
    expectZaiModelFields({
      id: "glm-4.7-flashx",
      cost: { input: 0.06, output: 0.4, cacheRead: 0.01, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 128000,
    });
    expectZaiModelFields({
      id: "glm-5-turbo",
      contextWindow: 202800,
      maxTokens: 131100,
      cost: { input: 1.2, output: 4, cacheRead: 0.24, cacheWrite: 0 },
    });
  });
});
