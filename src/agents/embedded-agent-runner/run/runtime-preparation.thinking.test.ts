import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { loadBundledPluginPublicSurface } from "../../../plugin-sdk/test-helpers/public-surface-loader.js";
import { setCurrentPluginMetadataSnapshot } from "../../../plugins/current-plugin-metadata.test-support.js";
import { loadPluginManifest } from "../../../plugins/manifest.js";
import { clearPluginMetadataLifecycleCaches } from "../../../plugins/plugin-metadata-lifecycle.js";
import { createPluginMetadataSnapshotFixture } from "../../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import {
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../../plugins/runtime.js";
import type { ProviderPlugin } from "../../../plugins/types.js";
import { createTestAdmittedRunContext } from "../../admitted-run-context.test-support.js";
import type { AuthProfileStore } from "../../auth-profiles.js";
import type { ResolvedProviderAuth } from "../../model-auth.js";
import { prepareModelRunCapabilities } from "../../model-catalog-lookup.js";
import type { ModelCatalogEntry } from "../../model-catalog.types.js";
import type { PreparedModelRuntimeSnapshot } from "../../prepared-model-runtime.js";
import { createEmptyAgentDiscoveryStores } from "../model.js";
import { resolveBundledStaticCatalogModel } from "../model.static-catalog.js";
import { prepareEmbeddedRunRuntime } from "./runtime-preparation.js";

const fixtures = vi.hoisted((): { authStore: AuthProfileStore } => ({
  authStore: { version: 1, profiles: {} },
}));

// Credential acquisition and native process installation are outside this network-free
// composition. Route planning, model resolution, auth commit, and the overlay remain real.
vi.mock("../../model-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../model-auth.js")>()),
  ensureAuthProfileStore: () => fixtures.authStore,
  ensureAuthProfileStoreWithoutExternalProfiles: () => fixtures.authStore,
  getApiKeyForModelCore: async ({
    profileId,
  }: {
    profileId: string;
  }): Promise<ResolvedProviderAuth> => ({
    apiKey: "fixture-key",
    mode: "api-key",
    source: "fixture",
    profileId,
  }),
}));
vi.mock("../../auth-profiles.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../auth-profiles.js")>()),
  ensureAuthProfileStore: () => fixtures.authStore,
}));
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: async () => ({ mode: "token", apiKey: "fixture-token" }),
  resolveProviderAuthProfileMetadata: () => ({}),
}));
vi.mock("openclaw/plugin-sdk/provider-catalog-live-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-catalog-live-runtime")>()),
  getCachedLiveProviderModelRows: async () => [
    {
      slug: "gpt-5.6-luna",
      supported_reasoning_levels: ["none", "low", "medium", "high", "xhigh", "max", "ultra"],
    },
  ],
}));
vi.mock("../../harness/runtime-plugin.js", () => ({
  ensureSelectedAgentHarnessPlugin: async () => undefined,
}));
vi.mock("../../harness/selection.js", () => {
  const harness = {
    id: "codex",
    label: "Codex fixture",
    authBootstrap: "harness",
    supports: () => ({ supported: true }),
    runAttempt: vi.fn(),
  };
  return {
    selectAgentHarness: () => harness,
    selectAgentHarnessForPreparedModelProviders: () => harness,
  };
});

const MODEL_ID = "gpt-5.6-luna";
const PLATFORM = "https://api.openai.com/v1";
const SUBSCRIPTION = "https://chatgpt.com/backend-api/codex";

describe("selected route thinking metadata at runtime preparation", () => {
  let root: string;
  let preparedModelRuntime: PreparedModelRuntimeSnapshot;
  let platformModel: NonNullable<ReturnType<typeof resolveBundledStaticCatalogModel>>;
  let provider: ProviderPlugin;

  beforeEach(async () => {
    const { buildOpenAIProvider } = await loadBundledPluginPublicSurface<{
      buildOpenAIProvider: () => ProviderPlugin;
    }>({ pluginId: "openai", artifactBasename: "api.js" });
    provider = buildOpenAIProvider();
    root = await realpath(await mkdtemp(path.join(tmpdir(), "openclaw-effort-route-")));
    const pluginDir = path.resolve("extensions/openai");
    const loaded = loadPluginManifest(pluginDir);
    if (!loaded.ok) {
      throw new Error(loaded.error);
    }
    const metadataSnapshot = createPluginMetadataSnapshotFixture({
      plugins: [{ ...loaded.manifest, origin: "bundled", rootDir: pluginDir }],
    });
    const pluginRegistry = createEmptyPluginRegistry();
    pluginRegistry.providers.push({ pluginId: "openai", source: pluginDir, provider });
    const config: OpenClawConfig = {};
    setCurrentPluginMetadataSnapshot(metadataSnapshot, { config, workspaceDir: root });
    setActivePluginRegistry(pluginRegistry, "effort-route", "default", root);
    const model = resolveBundledStaticCatalogModel({
      provider: "openai",
      modelId: MODEL_ID,
      cfg: config,
      env: {},
      metadataSnapshot,
      includeRuntimeDiscovery: true,
    });
    if (!model) {
      throw new Error("missing Platform catalog fixture");
    }
    platformModel = model;
    preparedModelRuntime = {
      catalogOwner: undefined,
      agentDir: path.join(root, "agent"),
      workspaceDir: root,
      activeProjectKeys: [],
      config,
      observationConfig: config,
      isCurrent: () => true,
      authModes: {},
      metadataSnapshot,
      pluginRegistry,
      allowGatewaySubagentBinding: false,
      modelCatalog: { entries: [], routeVariants: [] },
      configuredRuntimeModels: [],
      inlineProviderModels: [],
      createStores: createEmptyAgentDiscoveryStores,
    };
    fixtures.authStore = {
      version: 1,
      profiles: {
        "openai:platform": { type: "api_key", provider: "openai", key: "fixture-key" },
        "openai:subscription": { type: "token", provider: "openai", token: "fixture-token" },
      },
    };
  });

  afterEach(async () => {
    setCurrentPluginMetadataSnapshot(undefined);
    resetPluginRuntimeStateForTest();
    clearPluginMetadataLifecycleCaches();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  });

  it.each([
    { route: "platform", capability: "absent" },
    { route: "platform", capability: "platform" },
    { route: "platform", capability: "subscription" },
    { route: "subscription", capability: "absent" },
    { route: "subscription", capability: "platform" },
    { route: "subscription", capability: "subscription" },
  ] as const)(
    "preserves $route disablement with $capability prepared capability",
    async ({ route, capability }) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() => {
          throw new Error("unexpected network request");
        }),
      );
      const catalog = await provider.catalog!.run({
        config: {},
        env: {},
        resolveProviderAuth: () => ({ apiKey: "fixture-token", mode: "token", source: "profile" }),
        resolveProviderApiKey: () => ({ apiKey: undefined }),
      });
      if (!catalog || !("providers" in catalog)) {
        throw new Error("missing subscription catalog fixture");
      }
      const subscriptionRow = catalog.providers.openai?.models.find(
        (model) => model.id === MODEL_ID,
      );
      if (!subscriptionRow) {
        throw new Error("missing subscription model fixture");
      }
      const subscriptionModel = { ...subscriptionRow, provider: "openai" };
      expect(subscriptionModel.thinkingLevelMap?.off).toBeNull();
      expect(subscriptionModel.compat?.supportedReasoningEfforts).not.toContain("none");
      const capabilityModel = capability === "platform" ? platformModel : subscriptionModel;
      const capabilityApi =
        capability === "platform" ? "openai-responses" : "openai-chatgpt-responses";
      expect(capabilityModel.api).toBe(capabilityApi);
      const capabilityEntry = {
        ...capabilityModel,
        api: capabilityApi,
      } satisfies ModelCatalogEntry;
      const modelThinkingCapability =
        capability === "absent"
          ? undefined
          : prepareModelRunCapabilities([[capabilityEntry], []], ["openai", MODEL_ID, "codex"])
              .modelThinkingCapability;
      const runId = `effort-${route}-${capability}`;
      const runtime = await prepareEmbeddedRunRuntime({
        runParams: {
          runId,
          admittedRunContext: createTestAdmittedRunContext(runId),
          sessionId: "effort-session",
          sessionKey: "agent:main:effort-session",
          agentId: "main",
          prompt: "Reply briefly.",
          workspaceDir: root,
          timeoutMs: 5_000,
          config: preparedModelRuntime.config,
          authProfileId: `openai:${route}`,
          authProfileIdSource: "user",
          thinkLevel: "off",
          modelThinkingCapability,
        },
        provider: "openai",
        modelId: MODEL_ID,
        agentDir: preparedModelRuntime.agentDir,
        workspaceDir: root,
        globalLane: "test",
        hookRunner: undefined,
        hookContext: { sessionId: "effort-session", workspaceDir: root },
        markStartupStage: () => {},
        notifyExecutionPhase: () => {},
        fallbackConfigured: false,
        preparedModelRuntime,
      });
      try {
        const { effectiveModel, activePreparedAuthPlan } = runtime.snapshot();
        expect(activePreparedAuthPlan.modelRoute?.authRequirement).toBe(
          route === "platform" ? "api-key" : "subscription",
        );
        expect(effectiveModel.baseUrl).toBe(route === "platform" ? PLATFORM : SUBSCRIPTION);
        expect(effectiveModel.thinkingLevelMap?.off).toBe(route === "platform" ? "none" : null);
        const efforts = effectiveModel.compat?.supportedReasoningEfforts ?? [];
        if (modelThinkingCapability) {
          expect(modelThinkingCapability.route).toBeUndefined();
          expect(efforts).toEqual(
            expect.arrayContaining(
              modelThinkingCapability.compat.supportedReasoningEfforts?.filter(
                (effort) => effort !== "none",
              ) ?? [],
            ),
          );
        }
        if (route === "platform") {
          expect(efforts).toContain("none");
        } else {
          expect(efforts).not.toContain("none");
        }
      } finally {
        runtime.stopRuntimeAuthRefreshTimer();
      }
    },
  );
});
