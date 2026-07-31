import { describe, expect, it } from "vitest";
import {
  buildOllamaModelsConfig,
  findAvailableOllamaModelName,
  mergeUniqueModelNames,
  normalizeOllamaModelName,
} from "./setup-model-selection.js";

describe("Ollama onboarding model selection", () => {
  it("preserves catalog order while preferring an explicit latest tag", () => {
    expect(mergeUniqueModelNames(["gemma4", "qwen3:0.6b"], ["GEMMA4:latest"])).toEqual([
      "GEMMA4:latest",
      "qwen3:0.6b",
    ]);
  });

  it("resolves normalized custom model names to the installed latest tag", () => {
    expect(normalizeOllamaModelName("  OLLAMA/Gemma4  ")).toBe("Gemma4");
    expect(findAvailableOllamaModelName("Gemma4", ["qwen3:0.6b", "gemma4:latest"])).toBe(
      "gemma4:latest",
    );
  });

  it("keeps failed model inspections distinct from uninspected models", () => {
    const models = buildOllamaModelsConfig(
      ["deepseek-r1:14b", "uninspected"],
      new Map([["deepseek-r1:14b", { name: "deepseek-r1:14b", showInspectionFailed: true }]]),
    );

    expect(models[0]?.compat?.supportsTools).toBe(false);
    expect(models[0]?.reasoning).toBe(true);
    expect(models[1]?.compat?.supportsTools).toBe(true);
  });

  it("preserves discovered Gemma vision, reasoning, context, and tool capabilities", () => {
    const [model] = buildOllamaModelsConfig(
      ["gemma4:e2b"],
      new Map([
        [
          "gemma4:e2b",
          {
            name: "gemma4:e2b",
            contextWindow: 131_072,
            capabilities: ["completion", "tools", "vision", "thinking"],
          },
        ],
      ]),
    );

    expect(model).toMatchObject({
      id: "gemma4:e2b",
      input: ["text", "image"],
      reasoning: true,
      contextWindow: 131_072,
      compat: { supportsTools: true },
    });
  });
});
