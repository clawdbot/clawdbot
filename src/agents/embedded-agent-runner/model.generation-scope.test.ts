import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { connectUserModelAccount } from "../../state/user-model-accounts.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { AuthStorage, ModelRegistry } from "../sessions/index.js";
import { resolveTieredModel } from "./model-resolution.js";
import { guardModelFixtureAuth } from "./model.fixture.test-support.js";
import {
  createModelGenerationFixture,
  publishCurrentModelGeneration,
  resetModelGenerationFixtureState,
} from "./model.generation-scope.test-support.js";
import { resolveModelAsync } from "./model.js";

let state: OpenClawTestState;
let auth: ReturnType<typeof guardModelFixtureAuth>;
beforeEach(async () => {
  state = await createOpenClawTestState({ label: "model-generation" });
  auth = guardModelFixtureAuth(state.root);
});
afterEach(async () => {
  try {
    auth.verify();
  } finally {
    auth.spy.mockRestore();
    await state.cleanup();
  }
});

async function resolveGeneration(
  generation: ReturnType<typeof createModelGenerationFixture>,
  authProfileId?: string,
) {
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
      authProfileId,
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

  it("passes the selected personal auth mode into dynamic model discovery", async () => {
    const generation = createModelGenerationFixture({
      agentDir: state.agentDir(),
      workspaceDir: state.workspaceDir,
      config: {},
      label: "personal",
    });
    const owner = ensureProfileForEmail("alice@example.test");
    const { authProfileId } = connectUserModelAccount({
      ownerProfileId: owner.id,
      credential: {
        type: "oauth",
        provider: generation.provider,
        access: "synthetic-personal-access",
        refresh: "synthetic-personal-refresh",
        expires: Date.now() + 600_000,
      },
      assertCurrent() {},
    });

    const result = await resolveGeneration(generation, authProfileId);

    expect(result.model?.provider).toBe(generation.provider);
    const [context] =
      vi.mocked(generation.pluginRegistry.providers[0]!.provider.resolveDynamicModel!).mock
        .lastCall ?? [];
    expect({
      authProfileId: context?.authProfileId,
      authProfileMode: context?.authProfileMode,
    }).toEqual({
      authProfileId,
      authProfileMode: "oauth",
    });
  });

  it.each([
    { auth: true, registry: true },
    { auth: true, registry: false },
    { auth: false, registry: true },
    { auth: false, registry: false },
  ])("fills only missing discovery stores (auth=$auth, registry=$registry)", async (supplied) => {
    const generation = createModelGenerationFixture({
      agentDir: state.agentDir(),
      workspaceDir: state.workspaceDir,
      config: {},
      label: "stores",
    });
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
    const generationA = createModelGenerationFixture({
      agentDir: state.agentDir(),
      workspaceDir: state.workspaceDir,
      config,
      label: "a",
    });
    const generationB = createModelGenerationFixture({
      agentDir: state.agentDir(),
      workspaceDir: state.workspaceDir,
      config,
      label: "b",
      suppression: {},
    });
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

  it("preserves the retirement remedy when the selected route has no discoverable model", async () => {
    const provider = "generation-retirement-miss";
    const generation = createModelGenerationFixture({
      agentDir: state.agentDir(),
      workspaceDir: state.workspaceDir,
      config: {
        models: {
          providers: {
            [provider]: {
              api: "openai-completions",
              baseUrl: "https://subscription.example/v1",
              models: [],
            },
          },
        },
      },
      label: "retirement-miss",
      provider,
      suppression: {
        retirement: { replacedBy: "current-model" },
        when: { baseUrlHosts: ["subscription.example"] },
      },
    });
    generation.pluginRegistry.providers[0]!.provider.resolveDynamicModel = () => undefined;

    const result = await resolveGeneration(generation);

    expect(result.model).toBeUndefined();
    expect(result.error).toContain("openclaw doctor --fix");
    expect(result.error).toContain("current-model");
  });

  it("keeps the retirement failure discovered by the prepared catalog tier", async () => {
    const generation = createModelGenerationFixture({
      agentDir: state.agentDir(),
      workspaceDir: state.workspaceDir,
      config: {},
      label: "tiered-retirement",
      runtimeBaseUrl: "https://subscription.example/v1",
      withRegistry: false,
      suppression: {
        retirement: { replacedBy: "current-model" },
        when: { baseUrlHosts: ["subscription.example"] },
      },
    });
    const stores = generation.preparedModelRuntime.createStores();
    vi.spyOn(stores.modelRegistry, "find").mockReturnValue(generation.resolveDynamicModel());
    generation.preparedModelRuntime.createStores = () => stores;

    const { resolution } = await resolveTieredModel({
      provider: generation.provider,
      modelId: generation.modelId,
      agentDir: state.agentDir(),
      config: generation.preparedModelRuntime.config,
      workspaceDir: state.workspaceDir,
      preparedModelRuntime: generation.preparedModelRuntime,
    });

    expect(resolution.model).toBeUndefined();
    expect(resolution.error).toContain("openclaw doctor --fix");
    expect(resolution.error).toContain("current-model");
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
      agentDir: state.agentDir(),
      workspaceDir: state.workspaceDir,
      config,
      label: "a",
      prepareDynamicModel,
    });
    const generationB = createModelGenerationFixture({
      agentDir: state.agentDir(),
      workspaceDir: state.workspaceDir,
      config,
      label: "b",
      prepareDynamicModel,
    });
    publishCurrentModelGeneration(generationB);

    const resolutions = [resolveGeneration(generationA), resolveGeneration(generationB)] as const;
    try {
      const [resultA, resultB] = await Promise.all(resolutions);
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
    } finally {
      // A resolution can reject before both hooks arrive. Release its sibling
      // and join both owners before afterEach deletes their fixture state.
      release();
      await Promise.allSettled(resolutions);
    }
  });

  it("keeps metadata-only prepared generations from borrowing current runtime hooks", async () => {
    const config = {} satisfies OpenClawConfig;
    const generationA = createModelGenerationFixture({
      agentDir: state.agentDir(),
      workspaceDir: state.workspaceDir,
      config,
      label: "a",
      withRegistry: false,
    });
    const generationB = createModelGenerationFixture({
      agentDir: state.agentDir(),
      workspaceDir: state.workspaceDir,
      config,
      label: "b",
    });
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
