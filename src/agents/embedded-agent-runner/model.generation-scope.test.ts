import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { AuthStorage, ModelRegistry } from "../sessions/index.js";
import {
  createModelGenerationFixture,
  publishCurrentModelGeneration,
  resetModelGenerationFixtureState,
} from "./model.generation-scope.test-support.js";
import { resolveModelAsync } from "./model.js";

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
    vi.restoreAllMocks();
    resetModelGenerationFixtureState();
  });

  it.each([
    { auth: true, registry: true },
    { auth: true, registry: false },
    { auth: false, registry: true },
    { auth: false, registry: false },
  ])("fills only missing discovery stores (auth=$auth, registry=$registry)", async (supplied) => {
    const generation = createModelGenerationFixture({ config: {}, label: "stores" });
    const { preparedModelRuntime } = generation;
    const stores = preparedModelRuntime.createStores();
    stores.authStorage.setRuntimeApiKey(generation.provider, "fixture-runtime-key");
    const preparedStores = vi.spyOn(preparedModelRuntime, "createStores");
    const emptyAuth = vi.spyOn(AuthStorage, "inMemory");
    const emptyRegistry = vi.spyOn(ModelRegistry, "inMemory");

    const result = await resolveModelAsync(
      generation.provider,
      generation.modelId,
      preparedModelRuntime.agentDir,
      preparedModelRuntime.config,
      {
        ...(supplied.auth ? { authStorage: stores.authStorage } : {}),
        ...(supplied.registry ? { modelRegistry: stores.modelRegistry } : {}),
        preparedModelRuntime,
        skipAgentDiscovery: true,
        workspaceDir: preparedModelRuntime.workspaceDir,
      },
    );

    expect(preparedStores).not.toHaveBeenCalled();
    const allocations = supplied.auth && supplied.registry ? 0 : 1;
    expect(emptyAuth).toHaveBeenCalledTimes(allocations);
    expect(emptyRegistry).toHaveBeenCalledTimes(allocations);
    expect(result.authStorage === stores.authStorage).toBe(supplied.auth);
    expect(result.modelRegistry === stores.modelRegistry).toBe(supplied.registry);
    const model = expectDefined(result.model, "resolved fixture model");
    expect(await result.modelRegistry.getApiKeyAndHeaders(model)).toMatchObject({
      apiKey: supplied.auth || supplied.registry ? "fixture-runtime-key" : undefined,
    });
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
});
