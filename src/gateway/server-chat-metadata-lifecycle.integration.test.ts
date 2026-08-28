// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "../agents/prepared-model-runtime.test-harness.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { revokeRuntimeAuthMaterializations } from "../agents/auth-profiles/runtime-materializations.js";
import { reportEmbeddedRunSuccessfulAuthBinding } from "../agents/embedded-agent-runner/run/auth-profile-success.js";
import type { EmbeddedRunAttemptResult } from "../agents/embedded-agent-runner/run/types.js";
import type { AgentHarnessV2 } from "../agents/harness/types.js";
import { getPreparedModelCatalogOwnerSnapshot } from "../agents/prepared-model-catalog.js";
import { getPreparedModelRuntimeAuthMaterializations } from "../agents/prepared-model-runtime-auth.js";
import { refreshPreparedModelRuntimeSnapshots } from "../agents/prepared-model-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createGatewayChatMetadataLifecycle } from "./server-chat-metadata-lifecycle.js";
import {
  buildModelsListResult,
  createGatewayAgentModelCatalogProjector,
  prepareModelsListResult,
} from "./server-methods/models-list-result.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { registerGatewayModelCatalogPrivateAccess } from "./server-model-catalog-auth.js";
import {
  loadGatewayModelCatalogSnapshot,
  loadPreparedGatewayModelCatalogSnapshot,
  readPreparedGatewayModelCatalogOwnerSnapshot,
} from "./server-model-catalog.js";
import type { GatewayPostReadySidecarHandle } from "./server-startup-post-attach.js";

const mocks = getPreparedModelRuntimeMocks();
const config = {
  agents: {
    defaults: {
      model: { primary: "openai/gpt-5.4" },
      models: { "openai/gpt-5.4": {} },
      modelPolicy: { allow: ["openai/gpt-5.4"] },
    },
    list: [{ id: "main", default: true }],
  },
} as OpenClawConfig;
const model = {
  id: "gpt-5.4",
  name: "GPT-5.4",
  provider: "openai",
  api: "openai-chatgpt-responses" as const,
};
const context = {
  getRuntimeConfig: () => config,
  logGateway: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
} as unknown as GatewayRequestContext;
let sidecars: GatewayPostReadySidecarHandle[] = [];

beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "");
  resetPreparedModelRuntimeHarness();
  mocks.configuredAgentIds = ["main"];
  mocks.authStorage.getAll.mockReturnValue({
    openai: {
      type: "oauth",
      access: "prepared-access",
      refresh: "prepared-refresh",
      expires: Date.now() + 30 * 60_000,
    },
  });
  mocks.buildPreparedModelCatalogSnapshot.mockResolvedValue({
    entries: [model],
    routeVariants: [model],
  });
  sidecars = [];
});

function configureAuthFixture(kind: "secret-ref" | "external-oauth" | "unresolved-secret-ref") {
  if (kind === "external-oauth") {
    return;
  }
  const apiKeyModel = { ...model, api: "openai-responses" as const };
  mocks.buildPreparedModelCatalogSnapshot.mockResolvedValue({
    entries: [apiKeyModel],
    routeVariants: [apiKeyModel],
  });
  mocks.authStorage.getAll.mockReturnValue({
    openai: { type: "api_key", key: "openclaw-secret-ref-configured" },
  });
  mocks.preparedAuthStore = {
    version: 1,
    profiles: {
      "openai:default": {
        type: "api_key",
        provider: "openai",
        keyRef: { source: "file", provider: "round4-file", id: "value" },
        ...(kind === "secret-ref" ? { key: "resolved-at-runtime" } : {}),
      },
    },
  };
}

function configureHarnessOwnedUnresolvedAuth() {
  mocks.authStorage.getAll.mockReturnValue({
    openai: { type: "api_key", key: "openclaw-secret-ref-configured" },
  });
  mocks.preparedAuthStore = {
    version: 1,
    profiles: {
      "openai:default": {
        type: "api_key",
        provider: "openai",
        keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
      },
    },
  };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const sidecar of sidecars) {
    await sidecar.stop();
  }
});

async function createLifecycle(getConfig: () => OpenClawConfig = () => config) {
  return await createGatewayChatMetadataLifecycle({
    getConfig,
    minimalTestGateway: false,
    log: { warn: vi.fn() } as never,
  });
}

async function publishOwner(ownerConfig: OpenClawConfig = config): Promise<void> {
  await refreshPreparedModelRuntimeSnapshots(ownerConfig, {
    gatewayLifecycle: true,
    catalogMode: "live",
    allowGatewaySubagentBinding: true,
  });
}

async function expectAvailable(
  lifecycle: Awaited<ReturnType<typeof createGatewayChatMetadataLifecycle>>,
  expectedAvailable = true,
  activeConfig: OpenClawConfig = config,
  activeContext: GatewayRequestContext = context,
): Promise<void> {
  const owner = getPreparedModelCatalogOwnerSnapshot({
    agentId: "main",
    config: activeConfig,
    readOnly: true,
    allowGatewaySubagentBinding: true,
  });
  if (!owner) {
    throw new Error("expected prepared model owner");
  }
  const projector = createGatewayAgentModelCatalogProjector({
    cfg: activeConfig,
    agentId: "main",
    snapshot: owner.modelCatalog,
    metadataSnapshot: owner.metadataSnapshot,
    preparedAuthStore: mocks.preparedAuthStore ?? { version: 1, profiles: {} },
    preparedRuntimeAuthModes: owner.authModes,
    preparedRuntimeAuthMaterializations: getPreparedModelRuntimeAuthMaterializations(owner),
  });
  const [metadata, modelsList] = await Promise.all([
    lifecycle.read({ agentId: "main" }),
    buildModelsListResult({
      context: activeContext,
      agentId: "main",
      params: { view: "configured" },
      preloadedCatalog: {
        agentId: "main",
        config: activeConfig,
        snapshot: owner.modelCatalog,
      },
      preloadedOnly: true,
      catalogProjector: projector,
    }),
  ]);
  const metadataModels = metadata.models as
    | Array<{ id?: string; provider?: string; available?: boolean }>
    | undefined;
  const metadataModel = metadataModels?.find(
    (candidate) => candidate.id === "gpt-5.4" && candidate.provider === "openai",
  );
  const listedModel = modelsList.models.find(
    (candidate) => candidate.id === "gpt-5.4" && candidate.provider === "openai",
  );
  expect({
    chatMetadata: metadataModel?.available,
    modelsList: listedModel?.available,
  }).toEqual({
    chatMetadata: expectedAvailable,
    modelsList: expectedAvailable,
  });
}

describe("gateway chat metadata lifecycle composition", () => {
  it.each([false, true])(
    "publishes coherent native membership when readiness changes from %s during preparation",
    async (initialReady) => {
      const nativeConfig: OpenClawConfig = {
        agents: {
          defaults: {
            model: "openai/gpt-5.6-luna",
            models: {
              "openai/*": { agentRuntime: { id: "native-test" } },
              "openai/gpt-5.6-luna": { agentRuntime: { id: "native-test" } },
            },
            modelPolicy: { allow: ["openai/*", "openai/gpt-5.6-luna"] },
          },
          list: [{ id: "main", default: true }],
        },
      };
      const rows = ["codex-latest", "gpt-5.6-luna"].map((id) => ({
        provider: "openai",
        id,
        name: id,
        nativeRuntime: "native-test",
      }));
      let ready = initialReady;
      const loadModelCatalog = vi.fn(async () => rows);
      const harness: AgentHarnessV2 = {
        id: "native-test",
        label: "Synthetic native harness",
        authBootstrap: "harness",
        supports: () => ({ supported: true }),
        runAttempt: vi.fn(),
        loadModelCatalog,
        readModelCatalogReadiness: () => (ready ? { accountType: "apiKey" } : undefined),
      };
      const registry = createEmptyPluginRegistry();
      registry.agentHarnesses.push({ pluginId: "native-test", source: "test", harness });
      const previousRegistry = captureActivePluginRegistrySnapshot();
      setActivePluginRegistry(registry);
      mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(registry);
      mocks.authStorage.getAll.mockReturnValue({});
      mocks.preparedAuthStore = { version: 1, profiles: {} };
      mocks.buildPreparedModelCatalogSnapshot.mockResolvedValue({
        entries: rows,
        routeVariants: rows,
      });
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      try {
        await publishOwner(nativeConfig);
        const owner = getPreparedModelCatalogOwnerSnapshot({
          agentId: "main",
          config: nativeConfig,
          readOnly: true,
          allowGatewaySubagentBinding: true,
        });
        if (!owner) {
          throw new Error("expected prepared native model owner");
        }
        const projector = createGatewayAgentModelCatalogProjector({
          cfg: owner.config,
          agentId: "main",
          snapshot: owner.modelCatalog,
          metadataSnapshot: owner.metadataSnapshot,
          preparedAuthStore: mocks.preparedAuthStore,
          preparedRuntimeAuthModes: owner.authModes,
        });
        const evaluateEntry = projector.evaluateEntry;
        const evaluations = vi
          .spyOn(projector, "evaluateEntry")
          .mockImplementation(async (entry, variants) => {
            if (entry.id === "gpt-5.6-luna") {
              entered.resolve();
              await resume.promise;
            }
            return evaluateEntry(entry, variants);
          });
        const builds = mocks.buildPreparedModelCatalogSnapshot.mock.calls.length;
        const request = {
          context: { ...context, getRuntimeConfig: () => nativeConfig },
          agentId: "main",
          params: { view: "configured", preparedOnly: true },
          preloadedOnly: true,
          preloadedCatalog: {
            agentId: "main",
            config: owner.config,
            snapshot: owner.modelCatalog,
          },
          catalogProjector: projector,
        };
        const result = buildModelsListResult(request);
        await entered.promise;
        ready = !initialReady;
        resume.resolve();
        const models = (await result).models;
        expect(models.map(({ id }) => id)).toEqual(
          ready ? ["codex-latest", "gpt-5.6-luna"] : ["gpt-5.6-luna"],
        );
        expect(models.every(({ available }) => available === ready)).toBe(true);
        expect(loadModelCatalog).not.toHaveBeenCalled();
        expect(mocks.buildPreparedModelCatalogSnapshot).toHaveBeenCalledTimes(builds);
        const prepared = await prepareModelsListResult(request);
        const hostCalls = evaluations.mock.calls.length;
        ready = initialReady;
        for (let read = 0; read < 3; read++) {
          expect(prepared.isCurrent()).toBe(true);
          expect(prepared.read().models.map(({ id, available }) => [id, available])).toEqual(
            ready
              ? [
                  ["codex-latest", true],
                  ["gpt-5.6-luna", true],
                ]
              : [["gpt-5.6-luna", false]],
          );
        }
        expect(evaluations).toHaveBeenCalledTimes(hostCalls);
        expect(loadModelCatalog).not.toHaveBeenCalled();
      } finally {
        resume.resolve();
        restoreActivePluginRegistrySnapshot(previousRegistry);
      }
    },
  );

  it.each([
    { wildcard: false, invalidate: "dispose" },
    { wildcard: true, invalidate: "dispose" },
    { wildcard: false, invalidate: "registry" },
  ])(
    "revalidates native observations (wildcard=$wildcard, $invalidate) without rediscovery",
    async ({ wildcard, invalidate }) => {
      const modelRef = wildcard ? "openai/*" : "openai/codex-latest";
      const nativeConfig: OpenClawConfig = {
        agents: {
          defaults: {
            ...(wildcard ? {} : { model: "openai/codex-latest" }),
            models: { [modelRef]: { agentRuntime: { id: "native-test" } } },
            modelPolicy: { allow: [modelRef] },
          },
          list: [{ id: "main", default: true }],
        },
      };
      let currentConfig = nativeConfig;
      const nativeModel = {
        provider: "openai",
        id: "codex-latest",
        name: "Codex (Latest)",
        reasoning: true,
        nativeRuntime: "native-test",
      };
      let revision = 0;
      let observedRevision: number | undefined;
      let disposed = false;
      const loadModelCatalog = vi.fn(async () => {
        observedRevision = revision;
        return [nativeModel];
      });
      const readModelCatalogReadiness = vi.fn<
        NonNullable<AgentHarnessV2["readModelCatalogReadiness"]>
      >((scope) => {
        expect(scope).toMatchObject({
          config: nativeConfig,
          agentId: "main",
          agentDir: "/tmp/configured-main",
          workspaceDir: "/tmp/workspace-main",
          provider: "openai",
          modelId: "codex-latest",
        });
        expect(scope.config).toBe(nativeConfig);
        return !disposed && observedRevision === revision ? { accountType: "apiKey" } : undefined;
      });
      const harness: AgentHarnessV2 = {
        id: "native-test",
        label: "Synthetic native harness",
        authBootstrap: "harness",
        supports: () => ({ supported: true }),
        runAttempt: vi.fn(),
        loadModelCatalog,
        readModelCatalogReadiness,
      };
      const registry = createEmptyPluginRegistry();
      registry.agentHarnesses.push({ pluginId: "native-test", source: "test", harness });
      const previousRegistry = captureActivePluginRegistrySnapshot();
      setActivePluginRegistry(registry);
      mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(registry);
      mocks.authStorage.getAll.mockReturnValue({});
      mocks.preparedAuthStore = { version: 1, profiles: {} };
      mocks.buildPreparedModelCatalogSnapshot.mockResolvedValue({
        entries: [nativeModel],
        routeVariants: [nativeModel],
      });
      const nativeContext = { ...context, getRuntimeConfig: () => currentConfig };
      try {
        await publishOwner(nativeConfig);
        const lifecycle = await createLifecycle(() => currentConfig);
        await lifecycle.attachContext(nativeContext, sidecars);
        const expectedModels = (available: boolean) =>
          wildcard && !available
            ? []
            : [
                expect.objectContaining({
                  id: "codex-latest",
                  name: "Codex (Latest)",
                  reasoning: true,
                  available,
                }),
              ];
        const owner = getPreparedModelCatalogOwnerSnapshot({
          agentId: "main",
          config: nativeConfig,
          readOnly: true,
          allowGatewaySubagentBinding: true,
        });
        if (!owner) {
          throw new Error("expected prepared native model owner");
        }
        const expectNativeAvailable = async (available: boolean) => {
          const expected = { models: expectedModels(available) };
          await expect(
            lifecycle.readStartup({ agentId: "main", readPolicy: "ready" }),
          ).resolves.toMatchObject({ metadata: expected });
          await expect(lifecycle.read({ agentId: "main" })).resolves.toMatchObject(expected);
          await expect(lifecycle.readStartup({ agentId: "main" })).resolves.toMatchObject({
            metadata: expected,
          });
          await expect(
            buildModelsListResult({
              context: nativeContext,
              agentId: "main",
              params: { view: "configured", preparedOnly: true },
              preloadedOnly: true,
              preloadedCatalog: {
                agentId: "main",
                config: owner.config,
                snapshot: owner.modelCatalog,
              },
              catalogProjector: createGatewayAgentModelCatalogProjector({
                cfg: owner.config,
                agentId: "main",
                snapshot: owner.modelCatalog,
                metadataSnapshot: owner.metadataSnapshot,
                preparedAuthStore: { version: 1, profiles: {} },
                preparedRuntimeAuthModes: owner.authModes,
              }),
            }),
          ).resolves.toMatchObject(expected);
        };
        await expectNativeAvailable(false);
        expect(loadModelCatalog).not.toHaveBeenCalled();
        const builds = mocks.buildPreparedModelCatalogSnapshot.mock.calls.length;

        await loadModelCatalog();
        await lifecycle.refresh(); // Matching prepared/auth facts must not freeze the old boolean.
        await expectNativeAvailable(true);
        const lockedSession = {
          authProfileOverride: "openai:missing",
          authProfileOverrideSource: "user" as const,
        };
        await expect(
          lifecycle.readStartup({
            agentId: "main",
            sessionEntry: lockedSession,
            readPolicy: "ready",
          }),
        ).resolves.toBeUndefined();
        const lockedMetadata = await lifecycle.read({
          agentId: "main",
          sessionEntry: lockedSession,
        });
        expect(lockedMetadata).toMatchObject({
          models: wildcard
            ? []
            : [expect.objectContaining({ id: "codex-latest", available: false })],
        });
        await expect(
          lifecycle.readStartup({
            agentId: "main",
            sessionEntry: lockedSession,
            readPolicy: "ready",
          }),
        ).resolves.toMatchObject({ metadata: lockedMetadata });

        currentConfig = { ...nativeConfig };
        await lifecycle.refresh();
        // Equivalent lifecycle facts can retain a generation, but its prepared wrappers
        // still belong to the previous config object until a canonical read refreshes them.
        await expect(
          lifecycle.readStartup({ agentId: "main", readPolicy: "ready" }),
        ).resolves.toBeUndefined();
        await lifecycle.read({ agentId: "main" });
        await expectNativeAvailable(true);

        revision += 1;
        await expectNativeAvailable(false);
        await loadModelCatalog();
        await expectNativeAvailable(true);
        // Revocation during an asynchronous read must win before the response is returned.
        const racingRead = lifecycle.read({ agentId: "main" });
        if (invalidate === "dispose") {
          disposed = true;
        } else {
          setActivePluginRegistry(createEmptyPluginRegistry());
        }
        await expect(racingRead).resolves.toMatchObject({
          models: expectedModels(false),
        });
        await expectNativeAvailable(false);
        expect(loadModelCatalog).toHaveBeenCalledTimes(2);
        expect(mocks.buildPreparedModelCatalogSnapshot).toHaveBeenCalledTimes(builds);
      } finally {
        restoreActivePluginRegistrySnapshot(previousRegistry);
      }
    },
  );

  it.each([
    ["SecretRef-only runtime auth", "secret-ref", true],
    ["external CLI OAuth bootstrap", "external-oauth", true],
    ["unresolved SecretRef", "unresolved-secret-ref", false],
  ] as const)("converges chat metadata and models.list for %s", async (_, kind, available) => {
    configureAuthFixture(kind);
    await publishOwner();
    const lifecycle = await createLifecycle();
    await lifecycle.attachContext(context, sidecars);

    await expectAvailable(lifecycle, available);
  });

  it("catches up when the prepared owner publishes before attachment", async () => {
    await publishOwner();
    const lifecycle = await createLifecycle();

    await lifecycle.attachContext(context, sidecars);

    await expectAvailable(lifecycle);
  });

  it("keeps the published owner across a display-only config publication", async () => {
    const publishedConfig = {
      ...config,
      ui: { prefs: { chatShowThinking: true } },
    } satisfies OpenClawConfig;
    const currentConfig = {
      ...config,
      ui: { prefs: { chatShowThinking: false } },
    } satisfies OpenClawConfig;
    await publishOwner(publishedConfig);
    const lifecycle = await createLifecycle(() => currentConfig);
    const loadCatalogSnapshot: GatewayRequestContext["loadGatewayModelCatalogSnapshot"] = (
      loadParams,
    ) => loadGatewayModelCatalogSnapshot({ ...loadParams, getConfig: () => currentConfig });
    registerGatewayModelCatalogPrivateAccess(loadCatalogSnapshot, {
      loadDeferred: (loadParams) =>
        loadPreparedGatewayModelCatalogSnapshot({
          ...loadParams,
          getConfig: () => currentConfig,
        }),
      readPrepared: (loadParams) =>
        readPreparedGatewayModelCatalogOwnerSnapshot({
          ...loadParams,
          getConfig: () => currentConfig,
        }),
    });
    const currentContext = {
      ...context,
      getRuntimeConfig: () => currentConfig,
      loadGatewayModelCatalogSnapshot: loadCatalogSnapshot,
    } as GatewayRequestContext;

    await lifecycle.attachContext(currentContext, sidecars);

    await expect(lifecycle.read({ agentId: "main" })).resolves.toMatchObject({
      models: [
        expect.objectContaining({
          available: true,
          id: "gpt-5.4",
          provider: "openai",
        }),
      ],
    });
  });

  it("publishes a successful harness auth binding before the next metadata read", async () => {
    configureHarnessOwnedUnresolvedAuth();
    await publishOwner();
    const lifecycle = await createLifecycle();
    await lifecycle.attachContext(context, sidecars);
    await expectAvailable(lifecycle, false);
    const profileStore = mocks.preparedAuthStore;
    if (!profileStore) {
      throw new Error("expected unresolved prepared auth store");
    }

    reportEmbeddedRunSuccessfulAuthBinding({
      profileStore,
      apiKeyInfo: null,
      attempt: {
        runtimeArtifact: {
          id: "codex-app-server:test",
          fingerprint: "codex-runtime-fingerprint",
        },
      } as EmbeddedRunAttemptResult,
      provider: "openai",
      agentDir: "/tmp/configured-main",
      modelId: "gpt-5.4",
      modelApi: "openai-chatgpt-responses",
      modelBaseUrl: "https://chatgpt.com/backend-api/codex",
      requestTransportOverrides: "none",
      config,
      agentHarnessId: "codex",
      pluginHarnessOwnsTransport: true,
      pluginHarnessOwnsAuthBootstrap: true,
    });

    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledOnce();
    expect(mocks.preparedAuthMaterializations).toEqual([
      expect.objectContaining({
        provider: "openai",
        modelId: "gpt-5.4",
        modelApi: "openai-chatgpt-responses",
        modelBaseUrl: "https://chatgpt.com/backend-api/codex",
        requestTransportOverrides: "none",
        authMode: "oauth",
        runtimeOwnerId: "codex",
      }),
    ]);

    await vi.waitFor(async () => await expectAvailable(lifecycle));

    revokeRuntimeAuthMaterializations({
      agentDir: "/tmp/configured-main",
      provider: "openai",
      runtimeOwnerId: "codex",
    });
    await vi.waitFor(async () => await expectAvailable(lifecycle, false));
  });

  it("publishes a successful prepared API-key route before the next metadata read", async () => {
    const orderedConfig = {
      ...config,
      auth: { order: { openai: ["openai:default"] } },
    } satisfies OpenClawConfig;
    const orderedContext = {
      ...context,
      getRuntimeConfig: () => orderedConfig,
    } as GatewayRequestContext;
    configureAuthFixture("unresolved-secret-ref");
    await publishOwner(orderedConfig);
    const lifecycle = await createLifecycle(() => orderedConfig);
    await lifecycle.attachContext(orderedContext, sidecars);
    await expectAvailable(lifecycle, false, orderedConfig, orderedContext);
    const profileStore = mocks.preparedAuthStore;
    if (!profileStore) {
      throw new Error("expected unresolved prepared auth store");
    }

    reportEmbeddedRunSuccessfulAuthBinding({
      profileId: "openai:default",
      profileStore,
      apiKeyInfo: {
        apiKey: "resolved-at-runtime",
        source: "profile:openai:default",
        mode: "api-key",
        profileId: "openai:default",
      },
      attempt: {} as EmbeddedRunAttemptResult,
      provider: "openai",
      agentDir: "/tmp/configured-main",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      modelBaseUrl: "https://api.openai.com/v1",
      requestTransportOverrides: "none",
      config: orderedConfig,
      agentHarnessId: "codex",
      pluginHarnessOwnsTransport: true,
      pluginHarnessOwnsAuthBootstrap: true,
    });

    expect(mocks.preparedAuthMaterializations).toEqual([
      expect.objectContaining({
        provider: "openai",
        modelId: "gpt-5.4",
        modelApi: "openai-responses",
        modelBaseUrl: "https://api.openai.com/v1",
        requestTransportOverrides: "none",
        authMode: "api-key",
        runtimeOwnerId: "codex",
        authProfileId: "openai:default",
      }),
    ]);

    await vi.waitFor(
      async () => await expectAvailable(lifecycle, true, orderedConfig, orderedContext),
    );

    revokeRuntimeAuthMaterializations({
      agentDir: "/tmp/configured-main",
      provider: "openai",
      runtimeOwnerId: "codex",
    });
    await vi.waitFor(
      async () => await expectAvailable(lifecycle, false, orderedConfig, orderedContext),
    );
  });

  it("recovers a failed catch-up when the prepared owner publishes after attachment", async () => {
    const lifecycle = await createLifecycle();
    await lifecycle.attachContext(context, sidecars);
    await expect(lifecycle.read({ agentId: "main" })).rejects.toThrow(
      'prepared chat metadata owner is unavailable for agent "main"',
    );

    await publishOwner();

    await vi.waitFor(async () => await expectAvailable(lifecycle));
  });
});
