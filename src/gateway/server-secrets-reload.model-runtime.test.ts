import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { getRuntimeAuthProfileStoreCredentialsRevision } from "../agents/auth-profiles/runtime-snapshots.js";
import * as providerCatalog from "../agents/models-config.providers.implicit.js";
import { getPublishedPreparedModelCatalogOwnerSnapshot } from "../agents/prepared-model-catalog.js";
import {
  prepareModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "../agents/prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../agents/prepared-model-runtime.test-support.js";
import { writeConfigFile } from "../config/config.js";
import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  activateSecretsRuntimeSnapshotWithSource,
  clearSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createGatewaySecretsReloader } from "./server-secrets-reload.js";
import {
  enforceSharedGatewaySessionGenerationForConfigWrite,
  type SharedGatewayAuthClient,
} from "./server-shared-auth-generation.js";
import { createRuntimeSecretsActivator } from "./server-startup-config.js";

let state: OpenClawTestState;
const recoveredRef = { source: "env", provider: "default", id: "TEST_RELOADED_MODEL_KEY" } as const;

function sourceConfig() {
  return {
    plugins: { enabled: false },
    agents: {
      defaults: { workspace: state.workspaceDir, model: { primary: "healthy-fixture/model" } },
    },
    models: {
      providers: {
        "healthy-fixture": {
          baseUrl: "https://healthy.example/v1",
          api: "openai-completions",
          apiKey: "healthy-fixture-key",
          models: [
            {
              id: "model",
              name: "Model",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              maxTokens: 512,
              contextWindow: 4096,
            },
          ],
        },
        "recoverable-fixture": {
          baseUrl: "https://recoverable.example/v1",
          api: "openai-completions",
          apiKey: recoveredRef,
          models: [],
        },
      },
    },
  } satisfies OpenClawConfig;
}

function requireRuntimeConfig(): OpenClawConfig {
  const config = getRuntimeConfigSnapshot();
  if (!config) {
    throw new Error("Expected active runtime config");
  }
  return config;
}

beforeEach(async () => {
  resetPreparedModelRuntimeSnapshotsForTest();
  clearSecretsRuntimeSnapshot();
  state = await createOpenClawTestState({ label: "secrets-model-publication" });
  vi.stubEnv("TEST_RELOADED_MODEL_KEY", undefined);
  await state.writeAuthProfiles({ version: 1, profiles: {} });
});

afterEach(async () => {
  resetPreparedModelRuntimeSnapshotsForTest();
  clearSecretsRuntimeSnapshot();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await state.cleanup();
});

async function coldRuntime(clients: SharedGatewayAuthClient[] = []) {
  const config = sourceConfig();
  await state.writeConfig(config);
  const runtimeConfig: OpenClawConfig = structuredClone(config);
  runtimeConfig.models!.providers!["healthy-fixture"]!.models[0]!.compat = { supportsStore: false };
  const initial = await prepareSecretsRuntimeSnapshot({
    config: runtimeConfig,
    allowUnavailableSecretOwners: true,
  });
  expect(initial.degradedOwners).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        ownerKind: "provider",
        ownerId: "recoverable-fixture",
        degradationState: "cold",
      }),
    ]),
  );
  activateSecretsRuntimeSnapshotWithSource(initial, config);
  await refreshPreparedModelRuntimeSnapshots(requireRuntimeConfig(), {
    catalogMode: "static",
    gatewayLifecycle: true,
  });
  expect(
    getPublishedPreparedModelCatalogOwnerSnapshot({
      config: requireRuntimeConfig(),
      agentId: "main",
    })?.config.models?.providers?.["recoverable-fixture"]?.apiKey,
  ).toEqual(recoveredRef);
  const generationState = {
    current: "initial" as string | undefined,
    required: null as string | undefined | null,
  };
  const activator = createRuntimeSecretsActivator({
    logSecrets: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    emitStateEvent: vi.fn(),
  });
  const reload = createGatewaySecretsReloader({
    activateRuntimeSecrets: activator,
    sharedGatewaySessionGenerationState: generationState,
    resolveSharedGatewaySessionGenerationForConfig: () => "reloaded",
    clients,
    channelManager: {
      startChannel: async () => new Map(),
      stopChannel: async () => {},
      isManuallyStopped: () => false,
      resolveRuntimeAccountId: (_channel, accountId) => accountId,
    },
    logChannels: { info: vi.fn() },
  });
  vi.stubEnv("TEST_RELOADED_MODEL_KEY", "recovered-fixture-key");
  return { config, generationState, reload, activator };
}

describe("secret reload model-runtime publication", () => {
  it("publishes recovered config refs to the model owner without an auth-profile mutation", async () => {
    const { config, reload } = await coldRuntime();
    const authRevision = getRuntimeAuthProfileStoreCredentialsRevision();

    await reload();

    expect(getRuntimeConfigSourceSnapshot()).toEqual(config);
    expect(getRuntimeAuthProfileStoreCredentialsRevision()).toBe(authRevision);
    expect(requireRuntimeConfig().models?.providers?.["recoverable-fixture"]?.apiKey).toBe(
      "recovered-fixture-key",
    );
    const published = getPublishedPreparedModelCatalogOwnerSnapshot({
      config: requireRuntimeConfig(),
      agentId: "main",
    });
    expect(published?.config.models?.providers?.["recoverable-fixture"]?.apiKey).toBe(
      "recovered-fixture-key",
    );
  });

  it("restores the authoritative runtime model config after a publication failure", async () => {
    const { config, reload } = await coldRuntime();
    vi.spyOn(providerCatalog, "prepareImplicitProviderStaticCatalog").mockRejectedValueOnce(
      new Error("catalog build failed"),
    );

    await expect(reload()).rejects.toThrow("catalog build failed");

    expect(getRuntimeConfigSourceSnapshot()).toEqual(config);
    const current = requireRuntimeConfig();
    const published = await prepareModelRuntimeSnapshot({
      config: current,
      agentId: "main",
      agentDir: state.agentDir(),
    });
    expect(published.config).toBe(current);
    // The canonical restore retains this now-resolved Ref, rather than the cold predecessor bytes.
    expect(current.models?.providers?.["recoverable-fixture"]?.apiKey).toBe(
      "recovered-fixture-key",
    );
  });

  it("observes model rejection when activation throws after starting publication", async () => {
    const { reload, activator } = await coldRuntime();
    const activate = activator.activatePreparedSnapshotIfCurrent!;
    const buildStarted = createDeferred();
    activator.activatePreparedSnapshotIfCurrent = async (...args) => {
      await activate(...args);
      await buildStarted.promise;
      throw new Error("post-activation failure");
    };
    vi.spyOn(providerCatalog, "prepareImplicitProviderStaticCatalog").mockImplementationOnce(
      async () => {
        buildStarted.resolve();
        throw new Error("catalog build failed");
      },
    );

    await expect(reload()).rejects.toThrow("post-activation failure");
    const config = requireRuntimeConfig();
    expect(
      (await prepareModelRuntimeSnapshot({ config, agentId: "main", agentDir: state.agentDir() }))
        .config,
    ).toBe(config);
  });

  it.each(["candidate", "restoration"] as const)(
    "disconnects revoked shared-auth clients before awaited %s publication",
    async (phase) => {
      const close = vi.fn();
      const { reload } = await coldRuntime([
        {
          usesSharedGatewayAuth: true,
          sharedGatewaySessionGeneration: phase === "candidate" ? "initial" : "reloaded",
          socket: { close },
        },
      ]);
      const started = createDeferred();
      const release = createDeferred();
      const prepare = providerCatalog.prepareImplicitProviderStaticCatalog;
      const hook = vi.spyOn(providerCatalog, "prepareImplicitProviderStaticCatalog");
      if (phase === "restoration") {
        hook.mockRejectedValueOnce(new Error("catalog build failed"));
      }
      hook.mockImplementationOnce(async (...args) => {
        started.resolve();
        await release.promise;
        return await prepare(...args);
      });
      const pending = reload().catch(() => undefined);
      try {
        await started.promise;
        expect(close).toHaveBeenCalledWith(4001, "gateway auth changed");
      } finally {
        release.resolve();
        await pending;
      }
    },
  );

  it.each(["candidate", "restoration"] as const)(
    "preserves a newer config write during awaited %s publication",
    async (phase) => {
      const { config, generationState, reload } = await coldRuntime();
      const started = createDeferred();
      const release = createDeferred();
      const prepare = providerCatalog.prepareImplicitProviderStaticCatalog;
      const hook = vi.spyOn(providerCatalog, "prepareImplicitProviderStaticCatalog");
      if (phase === "restoration") {
        hook.mockRejectedValueOnce(new Error("catalog build failed"));
      }
      hook.mockImplementationOnce(async (...args) => {
        started.resolve();
        await release.promise;
        return await prepare(...args);
      });
      const oldReload = reload().then(
        () => ({ ok: true }),
        (error: unknown) => ({ error }),
      );
      let nextPublication: Promise<void> | undefined;
      try {
        await started.promise;
        const next = structuredClone(config);
        next.models.providers["recoverable-fixture"].baseUrl = "https://newer.example/v1";
        await writeConfigFile(next);
        const current = requireRuntimeConfig();
        expect(current.models?.providers?.["recoverable-fixture"]?.baseUrl).toBe(
          "https://newer.example/v1",
        );
        enforceSharedGatewaySessionGenerationForConfigWrite({
          state: generationState,
          nextConfig: current,
          resolveRuntimeSnapshotGeneration: () => "newer",
          clients: [],
        });
        nextPublication = refreshPreparedModelRuntimeSnapshots(current, { catalogMode: "static" });
        const reader = prepareModelRuntimeSnapshot({
          config: current,
          agentId: "main",
          agentDir: state.agentDir(),
        });
        release.resolve();
        expect(await oldReload).toMatchObject({ error: expect.any(Error) });
        await nextPublication;
        expect((await reader).config).toBe(current);
        expect(requireRuntimeConfig()).toBe(current);
        expect(getRuntimeConfigSourceSnapshot()?.models).toEqual(next.models);
        expect(generationState).toEqual({ current: "newer", required: null });
      } finally {
        release.resolve();
        await Promise.allSettled([oldReload, nextPublication]);
      }
    },
  );
});
