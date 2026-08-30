import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginMetadataSnapshot } from "../../../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { Model } from "../../../llm/types.js";
import { setCurrentPluginMetadataSnapshot } from "../../../plugins/current-plugin-metadata.test-support.js";
import { clearPluginMetadataLifecycleCaches } from "../../../plugins/plugin-metadata-lifecycle.js";
import type { PluginMetadataSnapshot } from "../../../plugins/plugin-metadata-snapshot.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import type { OAuthCredential } from "../../auth-profiles.js";
import { testing as externalAuthTesting } from "../../auth-profiles/external-auth.test-support.js";
import {
  listOwnedRuntimeAuthProfileStoreSnapshots,
  replaceOwnedRuntimeAuthProfileStoreSnapshots,
} from "../../auth-profiles/runtime-snapshots.js";
import type { AgentHarness } from "../../harness/types.js";
import type { PreparedModelRuntimeSnapshot } from "../../prepared-model-runtime.js";
import { AuthStorage } from "../../sessions/auth-storage.js";
import { ModelRegistry } from "../../sessions/model-registry.js";
import { prepareEmbeddedRunAuthPlan } from "./auth-plan.js";

const readCodexCliCredentialsCachedMock = vi.hoisted(() =>
  vi.fn<(_options?: unknown) => OAuthCredential | null>(() => null),
);
const resolveModelAsyncMock = vi.hoisted(() =>
  vi.fn<typeof import("../model.js").resolveModelAsync>(),
);
vi.mock("../../cli-credentials.js", () => ({
  readCodexCliCredentialsCached: readCodexCliCredentialsCachedMock,
  readMiniMaxCliCredentialsCached: () => null,
}));
vi.mock("../model.js", () => ({ resolveModelAsync: resolveModelAsyncMock }));

function createFixture(state: OpenClawTestState, config: OpenClawConfig, provider: string) {
  const agentDir = state.agentDir("work");
  const workspaceDir = state.path("workspace-work");
  const metadataSnapshot = createPluginMetadataSnapshot({
    config,
    workspaceDir,
    manifestRegistry: { plugins: [], diagnostics: [] },
  });
  setCurrentPluginMetadataSnapshot(metadataSnapshot, { config, env: process.env, workspaceDir });
  const authStorage = AuthStorage.inMemory();
  const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"), {
    modelsJsonContents: null,
    includePluginCatalogs: false,
    pluginMetadataSnapshot: metadataSnapshot,
  });
  const model: Model = {
    id: provider === "openai" ? "gpt-5.6-luna" : "model",
    name: "Fixture model",
    provider,
    api: provider === "openai" ? "openai-chatgpt-responses" : "openai-responses",
    baseUrl:
      provider === "openai"
        ? "https://chatgpt.com/backend-api/codex"
        : "https://fixture.invalid/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_000,
    maxTokens: 1_024,
  };
  const preparedModelRuntime: PreparedModelRuntimeSnapshot = {
    catalogOwner: undefined,
    config,
    agentDir,
    workspaceDir,
    activeProjectKeys: [],
    authModes: {},
    metadataSnapshot,
    allowGatewaySubagentBinding: false,
    modelCatalog: { entries: [], routeVariants: [] },
    configuredRuntimeModels: [],
    inlineProviderModels: [],
    createStores: () => ({ authStorage, modelRegistry }),
  };
  resolveModelAsyncMock.mockImplementation(async (nextProvider, modelId, _agentDir, nextConfig) => {
    const providerConfig = nextConfig?.models?.providers?.[nextProvider];
    return {
      model: {
        ...model,
        provider: nextProvider,
        id: modelId,
        api: providerConfig?.api ?? model.api,
        baseUrl: providerConfig?.baseUrl || model.baseUrl,
      },
      authStorage,
      modelRegistry,
    };
  });
  let harness: AgentHarness = {
    id: "openclaw",
    label: "OpenClaw fixture",
    supports: () => ({ supported: true }),
    runAttempt: async () => {
      throw new Error("Auth preparation must not run inference");
    },
  };
  let runtimeModel = model;
  return {
    metadataSnapshot,
    workspaceDir,
    prepare: (profileId?: string) =>
      prepareEmbeddedRunAuthPlan({
        runParams: {
          config,
          agentId: "work",
          sessionId: "auth-plan-fixture",
          runId: "auth-plan-fixture",
          workspaceDir,
          prompt: "Fixture",
          timeoutMs: 1_000,
          ...(profileId ? { authProfileId: profileId, authProfileIdSource: "user" as const } : {}),
        },
        provider,
        modelId: model.id,
        model,
        agentDir,
        workspaceDir,
        nativeModelOwned: false,
        authStorage,
        modelRegistry,
        preparedModelRuntime,
        getAgentHarness: () => harness,
        setAgentHarness: (next) => {
          harness = next;
        },
        getRuntimeModel: () => runtimeModel,
        getEffectiveModel: () => runtimeModel,
        applyResolvedRuntimeModel: (next) => {
          runtimeModel = next;
        },
        selectHarnessForPreparedAttempts: () => harness,
      }),
  };
}

describe("embedded run auth plan provider pin", () => {
  let previousStores: ReturnType<typeof listOwnedRuntimeAuthProfileStoreSnapshots>;

  beforeEach(() => {
    previousStores = listOwnedRuntimeAuthProfileStoreSnapshots();
    readCodexCliCredentialsCachedMock.mockReset().mockReturnValue({
      type: "oauth",
      provider: "openai",
      access: "codex-access-token",
      refresh: "codex-refresh-token",
      expires: Date.now() + 30 * 60_000,
    });
    resolveModelAsyncMock.mockReset();
    externalAuthTesting.setResolveExternalAuthProfilesForTest(() => []);
  });

  afterEach(() => {
    replaceOwnedRuntimeAuthProfileStoreSnapshots(previousStores);
    externalAuthTesting.resetResolveExternalAuthProfilesForTest();
    clearPluginMetadataLifecycleCaches();
    vi.unstubAllEnvs();
  });

  it("keeps ambient Codex OAuth behind an OpenAI api-key pin", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const config: OpenClawConfig = {
        models: { providers: { openai: { auth: "api-key", baseUrl: "", models: [] } } },
      };
      vi.stubEnv("OPENAI_API_KEY", "platform-api-key");
      const prepared = await createFixture(state, config, "openai").prepare();
      expect(prepared.attemptAuthProfileStore.profiles["openai:default"]).toBeUndefined();
      expect(prepared.preparedAuthAttempts[0]).toMatchObject({
        kind: "direct",
        plan: { selectedAuthMode: "api-key", modelRoute: { authRequirement: "api-key" } },
      });
    });
  });

  it.each([false, true])(
    "keeps an explicit external profile with provider pin %s",
    async (providerPin) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const provider = "fixture-auth";
        const profileId = `${provider}:work`;
        const config: OpenClawConfig = {
          auth: { profiles: { [profileId]: { provider, mode: "oauth" } } },
          models: {
            providers: {
              [provider]: {
                baseUrl: "https://fixture.invalid/v1",
                models: [],
                ...(providerPin ? { auth: "api-key" as const } : {}),
              },
            },
          },
        };
        const fixture = createFixture(state, config, provider);
        const published: PluginMetadataSnapshot = createPluginMetadataSnapshot({
          config,
          workspaceDir: state.path("workspace-main"),
          manifestRegistry: { plugins: [], diagnostics: [] },
        });
        setCurrentPluginMetadataSnapshot(published, {
          config,
          env: process.env,
          workspaceDir: published.workspaceDir,
        });
        externalAuthTesting.setResolveExternalAuthProfilesForTest((params) => {
          const ownsSelection =
            params.config === config &&
            params.workspaceDir === fixture.workspaceDir &&
            params.pluginMetadataSnapshot === fixture.metadataSnapshot;
          return [
            {
              profileId: ownsSelection ? profileId : "fixture-auth:ambient",
              credential: {
                type: "oauth",
                provider,
                access: "fixture-access",
                refresh: "fixture-refresh",
                expires: Date.now() + 60_000,
              },
              persistence: "runtime-only",
            },
          ];
        });
        const cliReadsBefore = readCodexCliCredentialsCachedMock.mock.calls.length;
        const prepared = await fixture.prepare(profileId);
        expect(prepared.preparedAuthAttempts).toMatchObject([
          {
            kind: "profile",
            profileId,
            plan: {
              forwardedAuthProfileId: profileId,
              forwardedAuthProfileSource: "user",
              selectedAuthMode: "oauth",
            },
          },
        ]);
        expect(Object.keys(prepared.attemptAuthProfileStore.profiles)).toEqual([profileId]);
        expect(prepared.attemptAuthProfileStore.runtimeExternalProfileIds).toContain(profileId);
        expect(readCodexCliCredentialsCachedMock.mock.calls.length).toBe(cliReadsBefore);
      });
    },
  );
});
