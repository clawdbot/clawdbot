import { describe, expect, it } from "vitest";
import { applyAutoLocalModelLean } from "./local-model-lean-auto.js";
import type { OpenClawConfig } from "./types.openclaw.js";

describe("local model lean onboarding defaults", () => {
  it.each([
    { providerKey: "managed-local", providerId: "managed-local", managed: true, expected: true },
    { providerKey: "Managed-Local", providerId: "MANAGED-LOCAL", managed: true, expected: true },
    { providerKey: "managed-local", providerId: "managed-local", managed: false, expected: false },
  ])(
    "classifies $providerKey by its configured process ownership ($managed)",
    ({ providerKey, providerId, managed, expected }) => {
      const config: OpenClawConfig = {
        models: {
          providers: {
            [providerKey]: {
              baseUrl: "http://127.0.0.1:8080/v1",
              models: [],
              ...(managed ? { localService: { command: "/usr/bin/model-server" } } : {}),
            },
          },
        },
      };
      const modelRef = `${providerId}/test-model`;
      const result = applyAutoLocalModelLean({ config, providerId, modelRef });

      expect(result.enabled).toBe(expected);
      expect(result.config.agents?.defaults?.experimental?.localModelLean).toBe(
        expected ? true : undefined,
      );
      expect(result.config.wizard?.localModelLeanAutoModel).toBe(expected ? modelRef : undefined);
    },
  );

  it("does not mistake an Ollama cloud model for local inference when its daemon is managed", () => {
    const config: OpenClawConfig = {
      models: {
        providers: {
          ollama: {
            baseUrl: "http://127.0.0.1:11434",
            models: [],
            localService: { command: "/usr/bin/ollama" },
          },
        },
      },
    };
    expect(
      applyAutoLocalModelLean({
        config,
        providerId: "ollama",
        modelRef: "ollama/test-model:cloud",
      }),
    ).toEqual({
      config,
      changed: false,
      enabled: false,
    });
  });

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
    const config: OpenClawConfig = {
      agents: { defaults: { experimental: { localModelLean } } },
      models: {
        providers: {
          "managed-local": {
            baseUrl: "http://127.0.0.1:8080/v1",
            models: [],
            localService: { command: "/usr/bin/model-server" },
          },
        },
      },
    };

    expect(
      applyAutoLocalModelLean({
        config,
        providerId: "managed-local",
        modelRef: "managed-local/test-model",
      }),
    ).toEqual({
      config,
      changed: false,
      enabled: false,
    });
  });

  it("lifts the automatic default when the same provider switches to an external server", () => {
    const modelRef = "managed-local/test-model";
    const config: OpenClawConfig = {
      wizard: { localModelLeanAutoModel: modelRef },
      agents: { defaults: { model: modelRef, experimental: { localModelLean: true } } },
      models: {
        providers: { "managed-local": { models: [], baseUrl: "http://127.0.0.1:8080/v1" } },
      },
    };

    const result = applyAutoLocalModelLean({ config, providerId: "managed-local", modelRef });

    expect(result.config.agents?.defaults?.experimental?.localModelLean).toBeUndefined();
    expect(result.config.wizard?.localModelLeanAutoModel).toBeUndefined();
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

  it("accepts explicit previous-model ownership after provider setup replaces the default", () => {
    const previousModelRef = "ollama/qwen3:8b";
    const selectedModelRef = "openai/gpt-5.6-luna";
    const result = applyAutoLocalModelLean({
      config: {
        wizard: { localModelLeanAutoModel: previousModelRef },
        agents: {
          defaults: {
            model: { primary: selectedModelRef },
            experimental: { localModelLean: true },
          },
        },
      },
      providerId: "openai",
      modelRef: selectedModelRef,
      previousModelRef,
    });

    expect(result.config.agents?.defaults?.model).toEqual({ primary: selectedModelRef });
    expect(result.config.agents?.defaults?.experimental?.localModelLean).toBeUndefined();
    expect(result.config.wizard?.localModelLeanAutoModel).toBeUndefined();
  });
});
