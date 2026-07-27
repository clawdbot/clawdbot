import { describe, expect, it } from "vitest";
import { applyAutoLocalModelLean } from "./local-model-lean-auto.js";

describe("local model lean onboarding defaults", () => {
  it.each([
    ["ollama", true],
    ["OLLAMA", true],
    ["lmstudio", true],
    ["ollama-cloud", false],
    ["sglang", false],
    ["vllm", false],
    ["openai", false],
  ])("classifies %s conservatively", (providerId, expected) => {
    const modelRef = `${providerId}/test-model`;
    const result = applyAutoLocalModelLean({ config: {}, providerId, modelRef });

    expect(result.enabled).toBe(expected);
    expect(result.changed).toBe(expected);
    expect(result.config.agents?.defaults?.experimental?.localModelLean).toBe(
      expected ? true : undefined,
    );
    expect(result.config.wizard?.localModelLeanAutoModel).toBe(expected ? modelRef : undefined);
  });

  it.each([
    ["ollama/qwen3:8b", true],
    ["ollama/local-cloud", true],
    ["ollama/invalid:cloud-cloud", true],
    ["ollama/invalid:local:cloud", true],
    ["ollama/invalid:local-cloud", true],
    ["ollama/invalid:cloud:local", true],
    ["ollama/kimi-k2.5:cloud", false],
    ["ollama/glm-5.2:cloud", false],
    ["ollama/gpt-oss:120b-cloud", false],
    ["ollama/KIMI-K2.5:CLOUD", false],
  ])("classifies the verified Ollama model source %s", (modelRef, expected) => {
    const result = applyAutoLocalModelLean({ config: {}, providerId: "ollama", modelRef });

    expect(result.enabled).toBe(expected);
    expect(result.changed).toBe(expected);
    expect(result.config.agents?.defaults?.experimental?.localModelLean).toBe(
      expected ? true : undefined,
    );
    expect(result.config.wizard?.localModelLeanAutoModel).toBe(expected ? modelRef : undefined);
  });

  it.each([false, true])("preserves an explicit localModelLean=%s", (localModelLean) => {
    const config = { agents: { defaults: { experimental: { localModelLean } } } };

    expect(
      applyAutoLocalModelLean({ config, providerId: "ollama", modelRef: "ollama/test-model" }),
    ).toEqual({
      config,
      changed: false,
      enabled: false,
    });
  });

  it("lifts only an onboarding-owned lean setting for a later non-local route", () => {
    const config = {
      wizard: { localModelLeanAutoModel: "ollama/test-model" },
      agents: {
        defaults: {
          model: "ollama/test-model",
          experimental: { localModelLean: true },
        },
      },
    };
    const lifted = applyAutoLocalModelLean({
      config,
      providerId: "openai",
      modelRef: "openai/gpt-test",
    });

    expect(lifted.changed).toBe(true);
    expect(lifted.enabled).toBe(false);
    expect(lifted.config.agents?.defaults?.experimental?.localModelLean).toBeUndefined();
    expect(lifted.config.wizard?.localModelLeanAutoModel).toBeUndefined();
  });

  it.each(["ollama/kimi-k2.5:cloud", "ollama/gpt-oss:120b-cloud"])(
    "lifts only an onboarding-owned lean setting for the hosted Ollama model %s",
    (modelRef) => {
      const config = {
        wizard: { localModelLeanAutoModel: "ollama/qwen3:8b" },
        agents: {
          defaults: {
            model: "ollama/qwen3:8b",
            experimental: { localModelLean: true },
          },
        },
      };

      const result = applyAutoLocalModelLean({ config, providerId: "ollama", modelRef });

      expect(result.changed).toBe(true);
      expect(result.enabled).toBe(false);
      expect(result.config.agents?.defaults?.experimental?.localModelLean).toBeUndefined();
      expect(result.config.wizard?.localModelLeanAutoModel).toBeUndefined();
    },
  );

  it.each([false, true])(
    "preserves an explicitly configured localModelLean=%s for hosted Ollama models",
    (localModelLean) => {
      const config = { agents: { defaults: { experimental: { localModelLean } } } };

      expect(
        applyAutoLocalModelLean({
          config,
          providerId: "ollama",
          modelRef: "ollama/kimi-k2.5:cloud",
        }),
      ).toEqual({
        config,
        changed: false,
        enabled: false,
      });
    },
  );

  it("preserves an explicit lean setting for a non-local route", () => {
    const config = { agents: { defaults: { experimental: { localModelLean: true } } } };

    expect(
      applyAutoLocalModelLean({ config, providerId: "openai", modelRef: "openai/gpt-test" }),
    ).toEqual({
      config,
      changed: false,
      enabled: false,
    });
  });

  it("hands ownership to a model changed outside onboarding", () => {
    const config = {
      wizard: { localModelLeanAutoModel: "ollama/old-model" },
      agents: {
        defaults: {
          model: "openai/gpt-test",
          experimental: { localModelLean: true },
        },
      },
    };

    const result = applyAutoLocalModelLean({
      config,
      providerId: "openai",
      modelRef: "openai/gpt-test",
    });

    expect(result.config.agents?.defaults?.experimental?.localModelLean).toBe(true);
    expect(result.config.wizard?.localModelLeanAutoModel).toBeUndefined();
  });
});
