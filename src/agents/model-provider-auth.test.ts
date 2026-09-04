// Verifies warmed provider-auth state and scoped auth-cache behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  hashRuntimeConfigValue,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { AuthProfileStore } from "./auth-profiles.js";
import type {
  ModelAuthAvailabilityEvaluation,
  ModelAuthAvailabilityRef,
} from "./model-auth-availability.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { publishProviderAuthWarmSnapshot } from "./model-provider-auth-state.js";

const modelCatalogMocks = vi.hoisted(() => ({
  loadModelCatalog: vi.fn<(params?: unknown) => Promise<ModelCatalogEntry[]>>(),
  ownerWorkspaceDir: undefined as string | undefined,
}));

const syntheticAuthMocks = vi.hoisted(() => {
  const prepareSyntheticAuth = vi.fn<
    typeof import("../plugins/provider-runtime.js").prepareProviderSyntheticAuthWithPlugin
  >(async () => undefined);
  return {
    prepareProviderSyntheticAuthWithPlugin: prepareSyntheticAuth,
    resolveProviderSyntheticAuthWithPlugin: vi.fn(() => undefined),
    captureProviderSyntheticAuthFacts: vi.fn<
      typeof import("../plugins/provider-runtime.js").captureProviderSyntheticAuthFacts
    >(async () => []),
  };
});

vi.mock("../plugins/provider-runtime.js", () => syntheticAuthMocks);

const modelAuthMocks = vi.hoisted(() => ({
  createRuntimeProviderAuthLookup: vi.fn(() => ({
    envApiKey: {
      aliasMap: {},
      candidateMap: {},
      authEvidenceMap: {},
    },
    syntheticAuthProviderRefs: [],
    syntheticAuthProviderRefsComplete: true,
  })),
  hasAvailableAuthForProvider: vi.fn(() => true),
  prepareRuntimeAvailableProviderAuth:
    vi.fn<typeof import("./model-auth-runtime.js").prepareRuntimeAvailableProviderAuth>(),
}));

const modelAuthAvailabilityMocks = vi.hoisted(() => {
  const evaluateModelAuth = vi.fn<
    (provider: string, ref?: ModelAuthAvailabilityRef) => ModelAuthAvailabilityEvaluation
  >(() => ({ availability: false, routeResolution: null }));
  return {
    evaluateModelAuth,
    createModelAuthAvailabilityResolver: vi.fn((_params: unknown) => ({
      evaluateModelAuth,
      resolveProviderAuthAvailability: vi.fn(() => false),
      hasSyntheticAuth: vi.fn(() => false),
    })),
  };
});

const authProfilesMocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn(() => ({ profiles: {} })),
  ensureAuthProfileStoreWithoutExternalProfiles: vi.fn(() => ({ profiles: {} })),
  externalCliDiscoveryForProviders: vi.fn(() => ({}) as never),
  externalCliDiscoveryForProviderAuth: vi.fn(() => ({}) as never),
  getRuntimeAuthProfileStoreSnapshot: vi.fn<(agentDir?: string) => AuthProfileStore | undefined>(
    () => undefined,
  ),
  listProfilesForProvider: vi.fn(() => []),
}));

vi.mock("./prepared-model-catalog.js", () => ({
  getPreparedModelCatalogOwnerSnapshot: (params: { workspaceDir?: string }) =>
    modelCatalogMocks.ownerWorkspaceDir &&
    (params.workspaceDir === undefined ||
      params.workspaceDir === modelCatalogMocks.ownerWorkspaceDir)
      ? {
          workspaceDir: modelCatalogMocks.ownerWorkspaceDir,
          metadataSnapshot: createPluginMetadataSnapshotFixture(),
          modelCatalog: { entries: [], routeVariants: [] },
        }
      : undefined,
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  loadPreparedModelCatalogOwnerSnapshot: async (params?: unknown) => ({
    ...(modelCatalogMocks.ownerWorkspaceDir
      ? { workspaceDir: modelCatalogMocks.ownerWorkspaceDir }
      : {}),
    modelCatalog: {
      entries: await modelCatalogMocks.loadModelCatalog(params),
      routeVariants: [],
    },
  }),
}));

vi.mock("./model-auth.js", () => ({
  createRuntimeProviderAuthLookup: modelAuthMocks.createRuntimeProviderAuthLookup,
  hasAvailableAuthForProvider: modelAuthMocks.hasAvailableAuthForProvider,
  prepareRuntimeAvailableProviderAuth: modelAuthMocks.prepareRuntimeAvailableProviderAuth,
}));

vi.mock("./model-auth-availability.js", () => ({
  createModelAuthAvailabilityResolver:
    modelAuthAvailabilityMocks.createModelAuthAvailabilityResolver,
}));

vi.mock("./auth-profiles.js", () => ({
  ensureAuthProfileStore: authProfilesMocks.ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles:
    authProfilesMocks.ensureAuthProfileStoreWithoutExternalProfiles,
  externalCliDiscoveryForProviders: authProfilesMocks.externalCliDiscoveryForProviders,
  externalCliDiscoveryForProviderAuth: authProfilesMocks.externalCliDiscoveryForProviderAuth,
  getRuntimeAuthProfileStoreSnapshot: authProfilesMocks.getRuntimeAuthProfileStoreSnapshot,
  listProfilesForProvider: authProfilesMocks.listProfilesForProvider,
}));

vi.mock("./workspace.js", () => ({
  resolveDefaultAgentWorkspaceDir: () => "/warm/default-workspace",
}));

vi.mock("./agent-scope-config.js", () => ({
  listAgentIds: () => ["default"],
  resolveAgentDir: () => "/warm/default-agent",
  resolveDefaultAgentDir: () => "/warm/default-agent",
  resolveAgentWorkspaceDir: () => "/warm/default-workspace",
  resolveDefaultAgentId: () => "default",
}));

const {
  clearCurrentProviderAuthState,
  buildCurrentProviderAuthStateSnapshot,
  createProviderAuthChecker,
  hasAuthForModelProvider,
  warmCurrentProviderAuthStateOffMainThread,
} = await import("./model-provider-auth.js");

async function publishCurrentProviderAuthStateSnapshot(
  cfg: OpenClawConfig,
  options?: Parameters<typeof buildCurrentProviderAuthStateSnapshot>[1],
): Promise<void> {
  publishProviderAuthWarmSnapshot(await buildCurrentProviderAuthStateSnapshot(cfg, options));
}

describe("prepared provider auth state", () => {
  afterEach(() => {
    clearCurrentProviderAuthState();
    vi.clearAllMocks();
    modelCatalogMocks.ownerWorkspaceDir = undefined;
    modelAuthAvailabilityMocks.evaluateModelAuth.mockReturnValue({
      availability: false,
      routeResolution: null,
    });
  });

  it("consumes prepared native auth when checking runtime availability", async () => {
    const nativeAuth = { apiKey: "native-marker", source: "Native auth", mode: "oauth" as const };
    const prepared = createDeferredCore<typeof nativeAuth | undefined>();
    syntheticAuthMocks.prepareProviderSyntheticAuthWithPlugin.mockImplementationOnce(
      async () => await prepared.promise,
    );
    const { prepareRuntimeAvailableProviderAuth } =
      await vi.importActual<typeof import("./model-auth-runtime.js")>("./model-auth-runtime.js");
    modelAuthMocks.prepareRuntimeAvailableProviderAuth.mockImplementationOnce(
      prepareRuntimeAvailableProviderAuth,
    );
    let settled = false;
    const answer = hasAuthForModelProvider({
      provider: "native",
      cfg: {},
      env: {},
      store: { version: 1, profiles: {} },
      runtimeAuthLookup: {
        ...modelAuthMocks.createRuntimeProviderAuthLookup(),
        syntheticAuthProviderRefs: ["native"],
      },
    }).finally(() => {
      settled = true;
    });
    try {
      await expect
        .poll(() => syntheticAuthMocks.prepareProviderSyntheticAuthWithPlugin.mock.calls.length)
        .toBe(1);
      expect(settled).toBe(false);
      prepared.resolve(nativeAuth);
      await expect(answer).resolves.toBe(true);
      expect(syntheticAuthMocks.prepareProviderSyntheticAuthWithPlugin).toHaveBeenCalledOnce();
    } finally {
      prepared.resolve(undefined);
      await Promise.allSettled([answer]);
    }
  });

  it("honors cancellation before returning fast-path auth", async () => {
    const { prepareRuntimeAvailableProviderAuth } =
      await vi.importActual<typeof import("./model-auth-runtime.js")>("./model-auth-runtime.js");
    const lookup = modelAuthMocks.createRuntimeProviderAuthLookup();
    const params = {
      provider: "native",
      env: { NATIVE_FIXTURE_AUTH: "fixture-auth" },
      runtimeLookup: {
        ...lookup,
        envApiKey: { ...lookup.envApiKey, candidateMap: { native: ["NATIVE_FIXTURE_AUTH"] } },
      },
    };
    await expect(prepareRuntimeAvailableProviderAuth(params)).resolves.toBe(true);
    const reason = new Error("availability cancelled");
    await expect(
      prepareRuntimeAvailableProviderAuth({ ...params, signal: AbortSignal.abort(reason) }),
    ).rejects.toBe(reason);
    expect(syntheticAuthMocks.prepareProviderSyntheticAuthWithPlugin).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "does not prepare native auth for a managed SecretRef (available: %s)",
    async (available) => {
      const { prepareRuntimeAvailableProviderAuth } =
        await vi.importActual<typeof import("./model-auth-runtime.js")>("./model-auth-runtime.js");
      modelAuthMocks.prepareRuntimeAvailableProviderAuth.mockImplementationOnce(
        prepareRuntimeAvailableProviderAuth,
      );
      const cfg: OpenClawConfig = {
        models: {
          providers: {
            "managed-native": {
              api: "openai-completions",
              apiKey: { source: "file", provider: "vault", id: "/native/key" },
              baseUrl: "https://example.test/v1",
              models: [],
            },
          },
        },
      };
      clearRuntimeConfigSnapshot();
      try {
        if (available) {
          const runtimeConfig = structuredClone(cfg);
          runtimeConfig.models!.providers!["managed-native"]!.apiKey = "runtime-auth-not-real";
          setRuntimeConfigSnapshot(runtimeConfig, cfg);
        }
        await expect(
          hasAuthForModelProvider({
            provider: "managed-native",
            cfg,
            env: {},
            store: { version: 1, profiles: {} },
          }),
        ).resolves.toBe(available);
        expect(syntheticAuthMocks.prepareProviderSyntheticAuthWithPlugin).not.toHaveBeenCalled();
      } finally {
        clearRuntimeConfigSnapshot();
      }
    },
  );

  it("reuses prepared runtime auth lookup data while warming providers", async () => {
    // Warming should build one runtime lookup and carry it across provider
    // checks instead of rediscovering auth for every catalog entry.
    const cfg = {} as OpenClawConfig;
    modelCatalogMocks.loadModelCatalog.mockResolvedValue([
      { id: "gpt", name: "gpt", provider: "openai" },
      { id: "claude", name: "claude", provider: "anthropic" },
    ]);
    modelAuthMocks.prepareRuntimeAvailableProviderAuth.mockResolvedValue(false);

    await publishCurrentProviderAuthStateSnapshot(cfg);

    expect(modelAuthMocks.createRuntimeProviderAuthLookup).toHaveBeenCalledTimes(1);
    const firstLookup =
      modelAuthMocks.prepareRuntimeAvailableProviderAuth.mock.calls[0]?.[0].runtimeLookup;
    const secondLookup =
      modelAuthMocks.prepareRuntimeAvailableProviderAuth.mock.calls[1]?.[0].runtimeLookup;
    expect(firstLookup).toBe(secondLookup);
  });

  it("uses the read-only model catalog while warming provider auth", async () => {
    const cfg = {} as OpenClawConfig;
    modelCatalogMocks.loadModelCatalog.mockResolvedValue([
      { id: "gpt", name: "gpt", provider: "openai" },
    ]);
    modelAuthMocks.prepareRuntimeAvailableProviderAuth.mockResolvedValue(false);

    await publishCurrentProviderAuthStateSnapshot(cfg);

    expect(modelCatalogMocks.loadModelCatalog).toHaveBeenCalledWith(
      expect.objectContaining({
        config: cfg,
        agentDir: expect.any(String),
        readOnly: true,
      }),
    );
    expect(modelCatalogMocks.loadModelCatalog.mock.calls[0]?.[0]).not.toHaveProperty(
      "workspaceDir",
    );
  });

  it("uses the prepared owner's authoritative workspace for auth discovery", async () => {
    const cfg = {} as OpenClawConfig;
    modelCatalogMocks.ownerWorkspaceDir = "/warm/gateway-launch-workspace";
    modelCatalogMocks.loadModelCatalog.mockResolvedValue([
      { id: "gpt", name: "gpt", provider: "openai" },
    ]);
    modelAuthMocks.prepareRuntimeAvailableProviderAuth.mockResolvedValue(false);

    await buildCurrentProviderAuthStateSnapshot(cfg);

    expect(modelAuthMocks.createRuntimeProviderAuthLookup).toHaveBeenCalledWith({
      cfg,
      workspaceDir: "/warm/gateway-launch-workspace",
    });
  });

  it("disables persisted auth-store sync for read-only warm snapshots", async () => {
    const cfg = {} as OpenClawConfig;
    const externalCli = { mode: "scoped" };
    modelCatalogMocks.loadModelCatalog.mockResolvedValue([
      { id: "gpt", name: "gpt", provider: "openai" },
    ]);
    authProfilesMocks.externalCliDiscoveryForProviders.mockReturnValue(externalCli as never);
    modelAuthMocks.prepareRuntimeAvailableProviderAuth.mockResolvedValue(false);

    await buildCurrentProviderAuthStateSnapshot(cfg, { readOnlyAuthStore: true });

    expect(authProfilesMocks.ensureAuthProfileStore).toHaveBeenCalledWith("/warm/default-agent", {
      config: cfg,
      externalCli,
      readOnly: true,
      syncExternalCli: false,
    });
  });

  it("does not cache false worker answers for process-local plugin synthetic auth", async () => {
    const cfg = {
      models: {
        providers: {
          "plugin-provider": {
            api: "plugin-api",
            baseUrl: "https://example.com/v1",
            models: [{ id: "plugin-model", name: "Plugin Model" }],
          },
        },
      },
    } as unknown as OpenClawConfig;
    modelCatalogMocks.loadModelCatalog.mockResolvedValue([
      { id: "plugin-model", name: "Plugin Model", provider: "plugin-provider" },
    ]);
    modelAuthMocks.prepareRuntimeAvailableProviderAuth.mockResolvedValue(false);

    const snapshot = await buildCurrentProviderAuthStateSnapshot(cfg, {
      runtimeAuthLookups: new Map([
        [
          "default",
          {
            envApiKey: {
              aliasMap: {},
              candidateMap: {},
              authEvidenceMap: {},
            },
            syntheticAuthProviderRefs: ["plugin-api"],
            syntheticAuthProviderRefsComplete: true,
          },
        ],
      ]),
    });

    expect(snapshot.agents[0]?.providers).toEqual([]);
  });

  it("replaces a warmed positive with a captured native-auth absence", async () => {
    const cfg = {
      models: {
        providers: {
          "native-provider": {
            api: "native-api",
            baseUrl: "https://example.com/v1",
            models: [],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const modelCatalog = {
      entries: [{ id: "native-model", name: "Native Model", provider: "native-provider" }],
      routeVariants: [],
    };
    modelCatalogMocks.loadModelCatalog.mockResolvedValue(modelCatalog.entries);
    modelAuthMocks.prepareRuntimeAvailableProviderAuth.mockResolvedValue(true);
    await publishCurrentProviderAuthStateSnapshot(cfg);
    await expect(hasAuthForModelProvider({ provider: "native-provider", cfg })).resolves.toBe(true);

    modelAuthMocks.prepareRuntimeAvailableProviderAuth.mockResolvedValue(false);
    await publishCurrentProviderAuthStateSnapshot(cfg, {
      omitFalseProviderAuth: true,
      runtimeAuthLookups: new Map([
        [
          "default",
          {
            ...modelAuthMocks.createRuntimeProviderAuthLookup(),
            syntheticAuthProviderRefs: ["native-api"],
          },
        ],
      ]),
      syntheticAuth: new Map([
        [
          "default",
          {
            agentId: "default",
            workspaceDir: "/warm/default-workspace",
            metadataSnapshot: createPluginMetadataSnapshotFixture(),
            facts: [{ providerRef: "native-provider", result: null }],
            modelCatalog,
          },
        ],
      ]),
    });
    // Foreground facts can still belong to the earlier generation; the refreshed absence wins.
    modelAuthMocks.prepareRuntimeAvailableProviderAuth.mockResolvedValue(true);
    await expect(hasAuthForModelProvider({ provider: "native-provider", cfg })).resolves.toBe(
      false,
    );
  });

  it("hasAuthForModelProvider returns the prepared answer after warm and falls through to compute after clear", async () => {
    const cfg = {} as OpenClawConfig;
    modelCatalogMocks.loadModelCatalog.mockResolvedValue([
      { id: "gpt", name: "gpt", provider: "openai" },
      { id: "claude", name: "claude", provider: "anthropic" },
    ]);
    modelAuthMocks.prepareRuntimeAvailableProviderAuth.mockImplementation(
      async ({ provider }) => provider === "openai",
    );

    await publishCurrentProviderAuthStateSnapshot(cfg);
    expect(modelAuthMocks.prepareRuntimeAvailableProviderAuth).toHaveBeenCalledTimes(2);

    // Flip the underlying answer; if the prepared map is consulted first,
    // hasAuthForModelProvider returns the cached answers without re-running
    // the compute path.
    modelAuthMocks.prepareRuntimeAvailableProviderAuth.mockResolvedValue(true);
    await expect(hasAuthForModelProvider({ provider: "openai", cfg })).resolves.toBe(true);
    await expect(hasAuthForModelProvider({ provider: "anthropic", cfg })).resolves.toBe(false);
    expect(modelAuthMocks.prepareRuntimeAvailableProviderAuth).toHaveBeenCalledTimes(2);

    // Clearing the prepared state forces the compute path on the next read.
    clearCurrentProviderAuthState();
    await expect(hasAuthForModelProvider({ provider: "anthropic", cfg })).resolves.toBe(true);
    expect(modelAuthMocks.prepareRuntimeAvailableProviderAuth).toHaveBeenCalledTimes(3);
  });

  it("hasAuthForModelProvider falls through to compute when the caller narrows the auth-discovery scope", async () => {
    const cfg = {} as OpenClawConfig;
    modelCatalogMocks.loadModelCatalog.mockResolvedValue([
      { id: "gpt", name: "gpt", provider: "openai" },
    ]);
    // Warm with the broad answer: provider has CLI/synthetic auth.
    modelAuthMocks.prepareRuntimeAvailableProviderAuth.mockResolvedValue(true);
    await publishCurrentProviderAuthStateSnapshot(cfg);
    expect(modelAuthMocks.prepareRuntimeAvailableProviderAuth).toHaveBeenCalledTimes(1);

    // Flip the underlying compute to false. A narrow-scope caller must NOT
    // pick up the warmed broad answer; gateway models.list can disable runtime
    // auth discovery and needs that narrower answer.
    modelAuthMocks.prepareRuntimeAvailableProviderAuth.mockResolvedValue(false);
    await expect(
      hasAuthForModelProvider({
        provider: "openai",
        cfg,
        discoverExternalCliAuth: false,
        allowPluginSyntheticAuth: false,
      }),
    ).resolves.toBe(false);
    expect(modelAuthMocks.prepareRuntimeAvailableProviderAuth).toHaveBeenCalledTimes(2);

    // Bounded browse callers may explicitly consume the prepared broad answer
    // while keeping slow fallback discovery disabled.
    await expect(
      hasAuthForModelProvider({
        provider: "openai",
        cfg,
        discoverExternalCliAuth: false,
        allowPluginSyntheticAuth: false,
        allowPreparedRuntimeAuth: true,
      }),
    ).resolves.toBe(true);
    expect(modelAuthMocks.prepareRuntimeAvailableProviderAuth).toHaveBeenCalledTimes(2);

    // Broad-scope caller (default flags) still hits the prepared map.
    await expect(hasAuthForModelProvider({ provider: "openai", cfg })).resolves.toBe(true);
    expect(modelAuthMocks.prepareRuntimeAvailableProviderAuth).toHaveBeenCalledTimes(2);
  });

  it("keeps provider-only OpenAI checks on the legacy auth path", async () => {
    const cfg = {} as OpenClawConfig;
    modelAuthMocks.prepareRuntimeAvailableProviderAuth.mockResolvedValue(false);

    const hasAuth = createProviderAuthChecker({
      cfg,
      allowPluginSyntheticAuth: false,
      discoverExternalCliAuth: false,
    });

    await expect(hasAuth("openai")).resolves.toBe(false);
    await expect(hasAuth("openai")).resolves.toBe(false);

    expect(modelAuthMocks.createRuntimeProviderAuthLookup).toHaveBeenCalledWith({
      cfg,
      workspaceDir: undefined,
      env: undefined,
      includePluginSyntheticAuth: false,
    });
    const runtimeLookup =
      modelAuthMocks.prepareRuntimeAvailableProviderAuth.mock.calls[0]?.[0].runtimeLookup;
    expect(runtimeLookup).toBe(
      modelAuthMocks.createRuntimeProviderAuthLookup.mock.results[0]?.value,
    );
    expect(modelAuthMocks.prepareRuntimeAvailableProviderAuth).toHaveBeenCalledTimes(1);
    expect(modelAuthAvailabilityMocks.createModelAuthAvailabilityResolver).not.toHaveBeenCalled();
    expect(modelAuthAvailabilityMocks.evaluateModelAuth).not.toHaveBeenCalled();
  });

  it("preserves explicit prepared runtime auth while keeping disabled discovery isolated", async () => {
    const cfg = {} as OpenClawConfig;
    const hasAuth = createProviderAuthChecker({
      cfg,
      allowPluginSyntheticAuth: false,
      discoverExternalCliAuth: false,
      allowPreparedRuntimeAuth: true,
    });

    await hasAuth("openai", {
      modelId: "gpt-5.5",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });

    expect(modelAuthAvailabilityMocks.createModelAuthAvailabilityResolver).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg,
        allowPreparedRuntimeAuth: true,
        syntheticAuthProviderRefs: [],
      }),
    );
    const resolverParams =
      modelAuthAvailabilityMocks.createModelAuthAvailabilityResolver.mock.calls[0]?.[0];
    expect(resolverParams).not.toHaveProperty("externalCliProviderIds");
  });

  it("keeps tuple-aware null-artifact checks indeterminate with broad auth enabled", async () => {
    const cfg = {} as OpenClawConfig;
    const hasAuth = createProviderAuthChecker({ cfg });

    await expect(hasAuth("openai", { modelId: "gpt-5.5" })).resolves.toBe(false);

    expect(modelAuthMocks.createRuntimeProviderAuthLookup).toHaveBeenCalledWith({
      cfg,
      workspaceDir: undefined,
      env: undefined,
      includePluginSyntheticAuth: true,
    });
    expect(modelAuthAvailabilityMocks.createModelAuthAvailabilityResolver).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg,
        allowPreparedRuntimeAuth: true,
        externalCliProviderIds: ["openai"],
        syntheticAuthProviderRefs: [],
      }),
    );
    expect(modelAuthMocks.prepareRuntimeAvailableProviderAuth).not.toHaveBeenCalled();
  });

  it("caches OpenAI auth by the complete route tuple", async () => {
    const hasAuth = createProviderAuthChecker({ cfg: {} as OpenClawConfig });
    const platformRef = {
      modelId: "gpt-5.5",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    };

    await hasAuth("openai", platformRef);
    await hasAuth("openai", { ...platformRef });
    await hasAuth("openai", {
      ...platformRef,
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    });

    expect(modelAuthAvailabilityMocks.evaluateModelAuth).toHaveBeenCalledTimes(2);
  });

  it("exposes the cached route evaluation alongside the boolean checker", async () => {
    const evaluation = {
      availability: true,
      routeResolution: null,
      evidence: "profile" as const,
    };
    modelAuthAvailabilityMocks.evaluateModelAuth.mockReturnValue(evaluation);
    const hasAuth = createProviderAuthChecker({ cfg: {} as OpenClawConfig });
    const ref = {
      modelId: "gpt-5.5",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    };

    await expect(hasAuth.evaluateModelAuth("openai", ref)).resolves.toBe(evaluation);
    await expect(hasAuth("openai", { ...ref })).resolves.toBe(true);
    expect(modelAuthAvailabilityMocks.evaluateModelAuth).toHaveBeenCalledOnce();
  });

  it("uses shared model auth evaluation for a non-OpenAI AWS SDK model", async () => {
    const evaluation = {
      availability: true,
      routeResolution: null,
      selectedAuthMode: "aws-sdk",
      evidence: "aws-sdk" as const,
    };
    modelAuthAvailabilityMocks.evaluateModelAuth.mockReturnValue(evaluation);
    const hasAuth = createProviderAuthChecker({ cfg: {} as OpenClawConfig });
    const ref = {
      modelId: "us.anthropic.claude-sonnet-4-5",
      api: "bedrock-converse-stream",
    };

    await expect(hasAuth.evaluateModelAuth("amazon-bedrock", ref)).resolves.toBe(evaluation);
    await expect(hasAuth("amazon-bedrock", { ...ref })).resolves.toBe(true);
    expect(modelAuthAvailabilityMocks.evaluateModelAuth).toHaveBeenCalledWith(
      "amazon-bedrock",
      ref,
    );
    expect(modelAuthMocks.prepareRuntimeAvailableProviderAuth).not.toHaveBeenCalled();
  });

  it("does not let legacy provider auth override an unresolved model SecretRef", async () => {
    const evaluation = {
      availability: undefined,
      routeResolution: null,
      selectedAuthMode: "api-key",
      evidence: "provider-config" as const,
    };
    modelAuthAvailabilityMocks.evaluateModelAuth.mockReturnValue(evaluation);
    modelAuthMocks.prepareRuntimeAvailableProviderAuth.mockResolvedValue(true);
    const hasAuth = createProviderAuthChecker({ cfg: {} as OpenClawConfig });
    const ref = { modelId: "claude-sonnet-4-6", api: "anthropic-messages" };

    await expect(hasAuth.evaluateModelAuth("anthropic", ref)).resolves.toBe(evaluation);
    await expect(hasAuth("anthropic", { ...ref })).resolves.toBe(false);
    expect(modelAuthAvailabilityMocks.evaluateModelAuth).toHaveBeenCalledWith("anthropic", ref);
    expect(modelAuthMocks.prepareRuntimeAvailableProviderAuth).not.toHaveBeenCalled();
  });

  it("uses an explicit agent auth store directory for provider auth checks", async () => {
    const cfg = {} as OpenClawConfig;
    modelAuthMocks.prepareRuntimeAvailableProviderAuth.mockResolvedValue(false);
    authProfilesMocks.listProfilesForProvider.mockReturnValueOnce([{} as never]);

    const hasAuth = createProviderAuthChecker({
      cfg,
      agentDir: "/state/agents/worker/agent",
      discoverExternalCliAuth: false,
    });

    await expect(hasAuth("nvidia")).resolves.toBe(true);
    expect(authProfilesMocks.ensureAuthProfileStoreWithoutExternalProfiles).toHaveBeenCalledWith(
      "/state/agents/worker/agent",
      { allowKeychainPrompt: false },
    );
    expect(authProfilesMocks.listProfilesForProvider).toHaveBeenCalledWith(
      expect.anything(),
      "nvidia",
    );
  });

  it("hasAuthForModelProvider uses the prepared answer for equivalent runtime config clones", async () => {
    const cfg = { gateway: { port: 18789 } } as OpenClawConfig;
    const clonedCfg = structuredClone(cfg);
    modelCatalogMocks.loadModelCatalog.mockResolvedValue([
      { id: "gpt", name: "gpt", provider: "openai" },
    ]);
    modelAuthMocks.prepareRuntimeAvailableProviderAuth.mockResolvedValue(true);
    await publishCurrentProviderAuthStateSnapshot(cfg);
    expect(modelAuthMocks.prepareRuntimeAvailableProviderAuth).toHaveBeenCalledTimes(1);

    modelAuthMocks.prepareRuntimeAvailableProviderAuth.mockResolvedValue(false);
    await expect(hasAuthForModelProvider({ provider: "openai", cfg: clonedCfg })).resolves.toBe(
      true,
    );
    expect(modelAuthMocks.prepareRuntimeAvailableProviderAuth).toHaveBeenCalledTimes(1);
  });

  it("hasAuthForModelProvider falls through to compute when the caller passes a non-default workspaceDir", async () => {
    const cfg = {} as OpenClawConfig;
    modelCatalogMocks.loadModelCatalog.mockResolvedValue([
      { id: "gpt", name: "gpt", provider: "openai" },
    ]);
    modelAuthMocks.prepareRuntimeAvailableProviderAuth.mockResolvedValue(true);
    await publishCurrentProviderAuthStateSnapshot(cfg);
    expect(modelAuthMocks.prepareRuntimeAvailableProviderAuth).toHaveBeenCalledTimes(1);

    // Per-agent picker calls pass an agent-specific workspaceDir that the
    // warmer did not cover; the prepared answer must not leak across
    // workspaces because env/plugin auth resolution depends on workspaceDir.
    modelAuthMocks.prepareRuntimeAvailableProviderAuth.mockResolvedValue(false);
    await expect(
      hasAuthForModelProvider({
        provider: "openai",
        cfg,
        workspaceDir: "/different/agent-workspace",
      }),
    ).resolves.toBe(false);
    expect(modelAuthMocks.prepareRuntimeAvailableProviderAuth).toHaveBeenCalledTimes(2);

    // Same workspaceDir as the warmer (the default) still hits the prepared map.
    await expect(
      hasAuthForModelProvider({
        provider: "openai",
        cfg,
        workspaceDir: "/warm/default-workspace",
      }),
    ).resolves.toBe(true);
    expect(modelAuthMocks.prepareRuntimeAvailableProviderAuth).toHaveBeenCalledTimes(2);
  });

  it("returns an empty warm snapshot when cancelled before publication", async () => {
    const cfg = {} as OpenClawConfig;
    let cancelled = false;
    modelCatalogMocks.loadModelCatalog.mockResolvedValue([
      { id: "gpt", name: "gpt", provider: "openai" },
    ]);
    modelAuthMocks.prepareRuntimeAvailableProviderAuth.mockResolvedValue(true);

    await publishCurrentProviderAuthStateSnapshot(cfg, { isCancelled: () => cancelled });
    await expect(hasAuthForModelProvider({ provider: "openai", cfg })).resolves.toBe(true);
    expect(modelAuthMocks.prepareRuntimeAvailableProviderAuth).toHaveBeenCalledTimes(1);

    clearCurrentProviderAuthState();
    modelAuthMocks.prepareRuntimeAvailableProviderAuth.mockClear();
    cancelled = true;
    const cancelledSnapshot = await buildCurrentProviderAuthStateSnapshot(cfg, {
      isCancelled: () => cancelled,
    });
    expect(cancelledSnapshot).toEqual({ agents: [] });

    modelAuthMocks.prepareRuntimeAvailableProviderAuth.mockResolvedValue(false);
    await expect(hasAuthForModelProvider({ provider: "openai", cfg })).resolves.toBe(false);
    expect(modelAuthMocks.prepareRuntimeAvailableProviderAuth).toHaveBeenCalledTimes(1);
  });

  it("stops sweeping providers when a warm is cancelled mid-flight", async () => {
    const cfg = {} as OpenClawConfig;
    let cancelled = false;
    modelCatalogMocks.loadModelCatalog.mockResolvedValue([
      { id: "gpt", name: "gpt", provider: "openai" },
      { id: "claude", name: "claude", provider: "anthropic" },
      { id: "gemini", name: "gemini", provider: "google" },
    ]);
    modelAuthMocks.prepareRuntimeAvailableProviderAuth.mockImplementation(async () => {
      cancelled = true;
      return false;
    });

    const snapshot = await buildCurrentProviderAuthStateSnapshot(cfg, {
      isCancelled: () => cancelled,
    });
    expect(snapshot).toEqual({ agents: [] });
    expect(modelAuthMocks.prepareRuntimeAvailableProviderAuth).toHaveBeenCalledTimes(1);

    modelAuthMocks.prepareRuntimeAvailableProviderAuth.mockClear();
    modelAuthMocks.prepareRuntimeAvailableProviderAuth.mockResolvedValue(true);
    await expect(hasAuthForModelProvider({ provider: "openai", cfg })).resolves.toBe(true);
    expect(modelAuthMocks.prepareRuntimeAvailableProviderAuth).toHaveBeenCalledTimes(1);
  });

  it("publishes provider auth state produced by the off-main-thread warm runner", async () => {
    const cfg = { gateway: { port: 18789 } } as OpenClawConfig;
    modelCatalogMocks.loadModelCatalog.mockResolvedValue([
      { id: "gpt", name: "gpt", provider: "openai" },
    ]);
    modelAuthMocks.prepareRuntimeAvailableProviderAuth.mockResolvedValue(true);
    const snapshot = await buildCurrentProviderAuthStateSnapshot(cfg);
    expect(modelAuthMocks.prepareRuntimeAvailableProviderAuth).toHaveBeenCalledTimes(1);

    clearCurrentProviderAuthState();
    modelAuthMocks.prepareRuntimeAvailableProviderAuth.mockClear();
    const runWorker = vi.fn(async () => snapshot);
    await warmCurrentProviderAuthStateOffMainThread(cfg, { runWorker });

    modelAuthMocks.prepareRuntimeAvailableProviderAuth.mockResolvedValue(false);
    await expect(hasAuthForModelProvider({ provider: "openai", cfg })).resolves.toBe(true);
    const runtimeAuthLookup =
      modelAuthMocks.createRuntimeProviderAuthLookup.mock.results.at(-1)?.value;
    expect(runWorker).toHaveBeenCalledWith({
      cfg,
      runtimeAuthLookups: [{ agentId: "default", lookup: runtimeAuthLookup }],
      timeoutMs: 120_000,
      isCancelled: expect.any(Function),
      workerUrl: undefined,
    });
    expect(modelAuthMocks.prepareRuntimeAvailableProviderAuth).not.toHaveBeenCalled();
  });

  it("passes runtime auth profile snapshots to the off-main-thread warm runner", async () => {
    const cfg = {} as OpenClawConfig;
    const store = {
      version: 1,
      profiles: {
        runtime: {
          type: "api_key" as const,
          provider: "openai",
          key: "test-key",
        },
      },
    };
    authProfilesMocks.getRuntimeAuthProfileStoreSnapshot.mockImplementation((agentDir) =>
      agentDir === "/warm/default-agent" ? store : undefined,
    );
    const snapshot = {
      agents: [
        {
          agentId: "default",
          configFingerprint: "fingerprint",
          providers: [["openai", true] as [string, boolean]],
        },
      ],
    };
    const runWorker = vi.fn(async () => snapshot);

    await warmCurrentProviderAuthStateOffMainThread(cfg, { runWorker });

    const runtimeAuthLookup =
      modelAuthMocks.createRuntimeProviderAuthLookup.mock.results.at(-1)?.value;
    expect(runWorker).toHaveBeenCalledWith({
      cfg,
      runtimeAuthStores: [
        {
          agentDir: "/warm/default-agent",
          store: {
            version: 1,
            profiles: {
              runtime: {
                type: "api_key",
                provider: "openai",
              },
            },
            usageStats: {},
          },
        },
      ],
      runtimeAuthLookups: [{ agentId: "default", lookup: runtimeAuthLookup }],
      timeoutMs: 120_000,
      isCancelled: expect.any(Function),
      workerUrl: undefined,
    });
  });

  it("keeps off-main-thread warm partial when plugin synthetic auth lookup is incomplete", async () => {
    const cfg = {} as OpenClawConfig;
    authProfilesMocks.getRuntimeAuthProfileStoreSnapshot.mockReturnValue(undefined);
    modelAuthMocks.createRuntimeProviderAuthLookup.mockReturnValueOnce({
      envApiKey: {
        aliasMap: {},
        candidateMap: {},
        authEvidenceMap: {},
      },
      syntheticAuthProviderRefs: [],
      syntheticAuthProviderRefsComplete: false,
    });
    const runWorker = vi.fn(async () => ({ agents: [] }));

    await warmCurrentProviderAuthStateOffMainThread(cfg, { runWorker });

    expect(runWorker).toHaveBeenCalledWith({
      cfg,
      runtimeAuthLookups: [
        {
          agentId: "default",
          lookup: {
            envApiKey: {
              aliasMap: {},
              candidateMap: {},
              authEvidenceMap: {},
            },
            syntheticAuthProviderRefs: [],
            syntheticAuthProviderRefsComplete: false,
          },
        },
      ],
      omitFalseProviderAuth: true,
      timeoutMs: 120_000,
      isCancelled: expect.any(Function),
      workerUrl: undefined,
    });
  });

  it("keeps off-main-thread auth warmup in the configured workspace", async () => {
    const cfg: OpenClawConfig = {};
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "provider-auth-workspace-"));
    const workerPath = path.join(root, "auth-worker.mjs");
    modelCatalogMocks.ownerWorkspaceDir = "/warm/gateway-launch-workspace";
    modelAuthMocks.prepareRuntimeAvailableProviderAuth.mockResolvedValue(false);
    syntheticAuthMocks.captureProviderSyntheticAuthFacts.mockImplementationOnce(
      async ({ workspaceDir }) => [
        {
          providerRef: "openai",
          result:
            workspaceDir === modelCatalogMocks.ownerWorkspaceDir
              ? { apiKey: "launch-workspace-auth", source: "workspace fixture", mode: "oauth" }
              : null,
        },
      ],
    );
    try {
      await fs.writeFile(
        workerPath,
        `
          import { parentPort } from "node:worker_threads";
          parentPort.on("message", ({ input }) => parentPort.postMessage({
            status: "ok",
            value: {
              status: "ok",
              snapshot: { agents: [{
                agentId: "default",
                configFingerprint: ${JSON.stringify(hashRuntimeConfigValue(cfg))},
                providers: [["openai", Boolean(input.syntheticAuth[0]?.facts[0]?.result)]]
              }] }
            }
          }));
        `,
      );
      await warmCurrentProviderAuthStateOffMainThread(cfg, {
        timeoutMs: 5_000,
        workerUrl: pathToFileURL(workerPath),
      });
      // Read through the real warmed cache: launch-only auth must not appear in config scope.
      await expect(hasAuthForModelProvider({ provider: "openai", cfg })).resolves.toBe(false);
      expect(syntheticAuthMocks.captureProviderSyntheticAuthFacts).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceDir: "/warm/default-workspace" }),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("aborts and joins parent auth capture before cancelled warmup settles", async () => {
    const cleanup = createDeferredCore();
    let signal: AbortSignal | undefined;
    syntheticAuthMocks.captureProviderSyntheticAuthFacts.mockImplementationOnce(async (params) => {
      signal = params.signal;
      await new Promise<void>((resolve) => {
        if (signal?.aborted) {
          resolve();
        } else {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        }
      });
      await cleanup.promise;
      signal?.throwIfAborted();
      return [];
    });
    let cancelled = false;
    let settled = false;
    const warm = warmCurrentProviderAuthStateOffMainThread(
      {},
      {
        isCancelled: () => cancelled,
        timeoutMs: 5_000,
      },
    ).finally(() => {
      settled = true;
    });
    void warm.catch(() => {});
    try {
      await expect.poll(() => signal !== undefined || settled).toBe(true);
      if (settled) {
        await warm;
      }
      expect(signal).toBeDefined();
      cancelled = true;
      await expect.poll(() => signal?.aborted).toBe(true);
      expect(settled).toBe(false);
      cleanup.resolve();
      await warm;
    } finally {
      cancelled = true;
      cleanup.resolve();
      await Promise.allSettled([warm]);
    }
  });

  it("terminates the off-main-thread warm worker when cancellation fires", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-provider-auth-worker-"));
    const workerPath = path.join(tempDir, "slow-worker.mjs");
    const markerPath = path.join(tempDir, "worker-finished");
    await fs.writeFile(
      workerPath,
      `
        import fs from "node:fs";
        import { parentPort } from "node:worker_threads";
        parentPort.on("message", ({ input }) => setTimeout(() => {
          fs.writeFileSync(input.cfg.markerPath, "finished");
          parentPort.postMessage({
            status: "ok",
            value: {
              status: "ok",
              snapshot: {
                agents: [{
                  agentId: "default",
                  configFingerprint: "fingerprint",
                  providers: [["openai", true]]
                }]
              }
            }
          });
        }, 200));
      `,
    );
    let cancelled = false;

    try {
      const warmPromise = warmCurrentProviderAuthStateOffMainThread(
        { markerPath } as unknown as OpenClawConfig,
        {
          isCancelled: () => cancelled,
          timeoutMs: 5_000,
          workerUrl: pathToFileURL(workerPath),
        },
      );
      await Promise.resolve();
      cancelled = true;
      await warmPromise;
      await new Promise((resolve) => {
        setTimeout(resolve, 250);
      });

      await expect(fs.access(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not publish an off-main-thread warm after the prepared auth state is cleared", async () => {
    const cfg = { gateway: { port: 18789 } } as OpenClawConfig;
    modelCatalogMocks.loadModelCatalog.mockResolvedValue([
      { id: "gpt", name: "gpt", provider: "openai" },
    ]);
    modelAuthMocks.prepareRuntimeAvailableProviderAuth.mockResolvedValue(true);
    const snapshot = await buildCurrentProviderAuthStateSnapshot(cfg);
    expect(modelAuthMocks.prepareRuntimeAvailableProviderAuth).toHaveBeenCalledTimes(1);

    clearCurrentProviderAuthState();
    modelAuthMocks.prepareRuntimeAvailableProviderAuth.mockClear();
    let resolveWorker: ((value: typeof snapshot) => void) | undefined;
    const warmPromise = warmCurrentProviderAuthStateOffMainThread(cfg, {
      runWorker: () =>
        new Promise((resolve) => {
          resolveWorker = resolve;
        }),
    });
    await Promise.resolve();
    clearCurrentProviderAuthState();
    resolveWorker?.(snapshot);
    await warmPromise;

    modelAuthMocks.prepareRuntimeAvailableProviderAuth.mockResolvedValue(false);
    await expect(hasAuthForModelProvider({ provider: "openai", cfg })).resolves.toBe(false);
    expect(modelAuthMocks.prepareRuntimeAvailableProviderAuth).toHaveBeenCalledTimes(1);
  });
});
