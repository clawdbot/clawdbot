import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { resolveProvidersForModelsJsonWithDeps } from "./models-config.plan.test-support.js";
import type { ProviderConfig } from "./models-config.providers.secrets.js";

function createExplicitProvider(): ProviderConfig {
  return {
    baseUrl: "https://example.test/v1",
    api: "openai-completions",
    apiKey: "EXPLICIT_API_KEY",
    models: [
      {
        id: "test/explicit-model",
        name: "Explicit Model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 4096,
      },
    ],
  };
}

function createImplicitProvider(): ProviderConfig {
  return {
    baseUrl: "https://openrouter.ai/api/v1",
    api: "openai-completions",
    apiKey: "OPENROUTER_API_KEY",
    models: [
      {
        id: "openrouter/auto",
        name: "OpenRouter Auto",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      },
    ],
  };
}

describe("models-config plan: replace mode skips implicit discovery", () => {
  it("skips implicit discovery when models.mode === 'replace'", async () => {
    const explicitProvider = createExplicitProvider();
    const cfg: OpenClawConfig = {
      models: {
        mode: "replace",
        providers: { explicit: explicitProvider },
      },
    };

    const resolveImplicitSpy = vi.fn(async () => ({
      openrouter: createImplicitProvider(),
    }));

    const result = await resolveProvidersForModelsJsonWithDeps(
      {
        cfg,
        agentDir: "/tmp/openclaw-models-config-replace-test",
        env: {},
      },
      { resolveImplicitProviders: resolveImplicitSpy },
    );

    expect(resolveImplicitSpy).not.toHaveBeenCalled();
    expect(Object.keys(result)).toEqual(["explicit"]);
    expect(result.explicit).toEqual(explicitProvider);
  });

  it("still resolves implicit when models.mode === 'merge'", async () => {
    const explicitProvider = createExplicitProvider();
    const cfg: OpenClawConfig = {
      models: {
        mode: "merge",
        providers: { explicit: explicitProvider },
      },
    };

    const resolveImplicitSpy = vi.fn(async () => ({
      openrouter: createImplicitProvider(),
    }));

    const result = await resolveProvidersForModelsJsonWithDeps(
      {
        cfg,
        agentDir: "/tmp/openclaw-models-config-replace-test",
        env: {},
      },
      { resolveImplicitProviders: resolveImplicitSpy },
    );

    expect(resolveImplicitSpy).toHaveBeenCalledTimes(1);
    expect(Object.keys(result).toSorted()).toEqual(["explicit", "openrouter"]);
  });

  it("still resolves implicit when models.mode is undefined (defaults to merge)", async () => {
    const explicitProvider = createExplicitProvider();
    const cfg: OpenClawConfig = {
      models: {
        providers: { explicit: explicitProvider },
      },
    };

    const resolveImplicitSpy = vi.fn(async () => ({
      openrouter: createImplicitProvider(),
    }));

    await resolveProvidersForModelsJsonWithDeps(
      {
        cfg,
        agentDir: "/tmp/openclaw-models-config-replace-test",
        env: {},
      },
      { resolveImplicitProviders: resolveImplicitSpy },
    );

    expect(resolveImplicitSpy).toHaveBeenCalledTimes(1);
  });
});
