import {
  createCapturedPluginRegistration,
  registerSingleProviderPlugin,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import deepinfraPlugin from "./index.js";

describe("deepinfra augmentModelCatalog", () => {
  it("returns empty when no configured catalog entries", async () => {
    const provider = await registerSingleProviderPlugin(deepinfraPlugin);

    const entries = await provider.augmentModelCatalog?.({} as never);

    expect(entries).toEqual([]);
  });

  it("returns configured catalog entries from config", async () => {
    const provider = await registerSingleProviderPlugin(deepinfraPlugin);

    const entries = await provider.augmentModelCatalog?.({
      config: {
        models: {
          providers: {
            deepinfra: {
              models: [
                {
                  id: "zai-org/GLM-5.1",
                  name: "GLM-5.1",
                  input: ["text"],
                  reasoning: true,
                  contextWindow: 202752,
                },
              ],
            },
          },
        },
      },
    } as never);

    expect(entries).toEqual([
      {
        provider: "deepinfra",
        id: "zai-org/GLM-5.1",
        name: "GLM-5.1",
        input: ["text"],
        reasoning: true,
        contextWindow: 202752,
      },
    ]);
  });
});

describe("deepinfra capability registration", () => {
  it("registers all DeepInfra-backed OpenClaw provider surfaces", () => {
    const captured = createCapturedPluginRegistration();
    deepinfraPlugin.register(captured.api);

    expect(captured.providers.map((provider) => provider.id)).toEqual(["deepinfra"]);
    expect(captured.imageGenerationProviders.map((provider) => provider.id)).toEqual(["deepinfra"]);
    expect(captured.mediaUnderstandingProviders.map((provider) => provider.id)).toEqual([
      "deepinfra",
    ]);
    expect(captured.memoryEmbeddingProviders.map((provider) => provider.id)).toEqual(["deepinfra"]);
    expect(captured.speechProviders.map((provider) => provider.id)).toEqual(["deepinfra"]);
    expect(captured.videoGenerationProviders.map((provider) => provider.id)).toEqual(["deepinfra"]);
  });
});

describe("deepinfra isCacheTtlEligible", () => {
  it("returns true for anthropic/* proxied models", async () => {
    const provider = await registerSingleProviderPlugin(deepinfraPlugin);
    expect(
      provider.isCacheTtlEligible?.({
        provider: "deepinfra",
        modelId: "anthropic/claude-4-sonnet",
      }),
    ).toBe(true);
  });

  // Locked to case-insensitive to stay consistent with the shared proxy cache
  // wrapper, which lowercases the modelId before the "anthropic/" prefix check.
  it("returns true regardless of modelId case", async () => {
    const provider = await registerSingleProviderPlugin(deepinfraPlugin);
    expect(
      provider.isCacheTtlEligible?.({
        provider: "deepinfra",
        modelId: "Anthropic/Claude-4-Sonnet",
      }),
    ).toBe(true);
    expect(
      provider.isCacheTtlEligible?.({
        provider: "deepinfra",
        modelId: "ANTHROPIC/claude-4-sonnet",
      }),
    ).toBe(true);
  });

  it("returns false for non-anthropic models", async () => {
    const provider = await registerSingleProviderPlugin(deepinfraPlugin);
    expect(
      provider.isCacheTtlEligible?.({
        provider: "deepinfra",
        modelId: "meta-llama/Llama-4-Scout-17B-16E-Instruct",
      }),
    ).toBe(false);
    expect(
      provider.isCacheTtlEligible?.({
        provider: "deepinfra",
        modelId: "zai-org/GLM-5.1",
      }),
    ).toBe(false);
  });
});
