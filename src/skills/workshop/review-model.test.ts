import { describe, expect, it } from "vitest";
import { resolveSkillWorkshopReviewModel } from "./review-model.js";

const baseConfig = {
  agents: {
    defaults: {
      model: { primary: "vllm/qwen-local" },
      models: { "openrouter/deepseek/deepseek-v4": { alias: "deepseek" } },
    },
  },
};

describe("resolveSkillWorkshopReviewModel", () => {
  it("keeps the reviewed run's model when no review model is configured", () => {
    expect(
      resolveSkillWorkshopReviewModel({
        config: baseConfig,
        agentId: "main",
        fallback: { provider: "vllm", model: "qwen-local" },
      }),
    ).toEqual({ provider: "vllm", model: "qwen-local", configured: false });
  });

  it("falls back to the agent default model without a reviewed run", () => {
    expect(resolveSkillWorkshopReviewModel({ config: baseConfig, agentId: "main" })).toEqual({
      provider: "vllm",
      model: "qwen-local",
      configured: false,
    });
  });

  it("routes reviews to a configured provider/model ref", () => {
    expect(
      resolveSkillWorkshopReviewModel({
        config: {
          ...baseConfig,
          skills: { workshop: { model: "openrouter/deepseek/deepseek-v4" } },
        },
        agentId: "main",
        fallback: { provider: "vllm", model: "qwen-local" },
      }),
    ).toEqual({ provider: "openrouter", model: "deepseek/deepseek-v4", configured: true });
  });

  it("resolves a configured model alias", () => {
    expect(
      resolveSkillWorkshopReviewModel({
        config: { ...baseConfig, skills: { workshop: { model: "deepseek" } } },
        agentId: "main",
        fallback: { provider: "vllm", model: "qwen-local" },
      }),
    ).toEqual({ provider: "openrouter", model: "deepseek/deepseek-v4", configured: true });
  });
});
