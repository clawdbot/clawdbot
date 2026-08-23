import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import {
  createModelGenerationFixture,
  publishCurrentModelGeneration,
  resetModelGenerationFixtureState,
} from "./model.generation-scope.test-support.js";
import { resolveModel, resolveModelAsync } from "./model.js";

async function resolveGeneration(generation: ReturnType<typeof createModelGenerationFixture>) {
  const { preparedModelRuntime } = generation;
  const stores = preparedModelRuntime.createStores();
  return await resolveModelAsync(
    generation.requestProvider,
    generation.modelId,
    preparedModelRuntime.agentDir,
    preparedModelRuntime.config,
    {
      ...stores,
      allowBundledStaticCatalogFallback: true,
      preparedModelRuntime,
      skipAgentDiscovery: true,
      workspaceDir: preparedModelRuntime.workspaceDir,
    },
  );
}

describe("model runtime generation scope", () => {
  beforeEach(() => {
    clearPluginMetadataLifecycleCaches();
  });

  afterEach(() => {
    resetModelGenerationFixtureState();
  });

  it("keeps alias, suppression, static metadata, and runtime hooks on the prepared generation", async () => {
    const config = {} satisfies OpenClawConfig;
    const generationA = createModelGenerationFixture({ config, label: "a" });
    const generationB = createModelGenerationFixture({ config, label: "b", suppress: true });
    publishCurrentModelGeneration(generationB);

    const result = await resolveGeneration(generationA);

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: generationA.provider,
      name: "Runtime A",
      mediaInput: { image: generationA.staticImagePolicy },
    });
    expect(generationA.resolveDynamicModel).toHaveBeenCalled();
    expect(generationB.resolveDynamicModel).not.toHaveBeenCalled();
  });

  it("keeps concurrent prepared generations isolated across awaited runtime hooks", async () => {
    const config = {} satisfies OpenClawConfig;
    let arrivals = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prepareDynamicModel = async () => {
      arrivals += 1;
      if (arrivals === 2) {
        release();
      }
      await gate;
    };
    const generationA = createModelGenerationFixture({
      config,
      label: "a",
      prepareDynamicModel,
    });
    const generationB = createModelGenerationFixture({
      config,
      label: "b",
      prepareDynamicModel,
    });
    publishCurrentModelGeneration(generationB);

    const [resultA, resultB] = await Promise.all([
      resolveGeneration(generationA),
      resolveGeneration(generationB),
    ]);

    expect(resultA.model).toMatchObject({
      provider: generationA.provider,
      name: "Runtime A",
      mediaInput: { image: generationA.staticImagePolicy },
    });
    expect(resultB.model).toMatchObject({
      provider: generationB.provider,
      name: "Runtime B",
      mediaInput: { image: generationB.staticImagePolicy },
    });
  });

  it("keeps metadata-only prepared generations from borrowing current runtime hooks", async () => {
    const config = {} satisfies OpenClawConfig;
    const generationA = createModelGenerationFixture({
      config,
      label: "a",
      withRegistry: false,
    });
    const generationB = createModelGenerationFixture({ config, label: "b" });
    publishCurrentModelGeneration(generationB);

    const result = await resolveGeneration(generationA);

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: generationA.provider,
      name: "Static A",
      mediaInput: { image: generationA.staticImagePolicy },
    });
    expect(generationB.resolveDynamicModel).not.toHaveBeenCalled();
  });

  it("keeps synchronous resolution on the exact scoped generation", () => {
    const config = {} satisfies OpenClawConfig;
    const generationA = createModelGenerationFixture({ config, label: "a" });
    const generationB = createModelGenerationFixture({ config, label: "b" });
    publishCurrentModelGeneration(generationB);
    const stores = generationA.preparedModelRuntime.createStores();

    const result = withPluginRuntimeGenerationScope(generationA.preparedModelRuntime, () =>
      resolveModel(
        generationA.requestProvider,
        generationA.modelId,
        generationA.preparedModelRuntime.agentDir,
        config,
        {
          ...stores,
          workspaceDir: generationA.preparedModelRuntime.workspaceDir,
        },
      ),
    );

    expect(result.model).toMatchObject({
      provider: generationA.provider,
      name: "Runtime A",
    });
    expect(generationB.resolveDynamicModel).not.toHaveBeenCalled();
  });
});
