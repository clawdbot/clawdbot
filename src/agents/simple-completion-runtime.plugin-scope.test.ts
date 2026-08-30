import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import {
  createColdPluginFixture,
  createColdPluginHermeticEnv,
  isColdPluginRuntimeLoaded,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { createSyncSuiteTempRootTracker } from "../plugins/test-helpers/fs-fixtures.js";
import { withEnvAsync } from "../test-utils/env.js";
import type { resolveModelAsync } from "./embedded-agent-runner/model.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";
import { AuthStorage, ModelRegistry } from "./sessions/index.js";
import {
  prepareSimpleCompletionModel,
  prepareSimpleCompletionModelForAgent,
} from "./simple-completion-runtime.js";

const tempRoots = createSyncSuiteTempRootTracker("openclaw-simple-completion-plugin-scope");

afterEach(() => {
  resetPreparedModelRuntimeSnapshotsForTest();
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
  tempRoots.cleanup();
});

describe("simple completion prepared plugin scope", () => {
  it.each([
    {
      name: "direct provider and model",
      expectedModelId: "selected-model",
      prepare: (params: {
        config: OpenClawConfig;
        modelResolver: typeof resolveModelAsync;
        provider: string;
        modelId: string;
      }) =>
        prepareSimpleCompletionModel({
          cfg: params.config,
          agentId: "main",
          provider: params.provider,
          modelId: params.modelId,
          modelResolver: params.modelResolver,
        }),
    },
    {
      name: "agent-selected manifest utility model",
      expectedModelId: "utility-model",
      prepare: (params: {
        config: OpenClawConfig;
        modelResolver: typeof resolveModelAsync;
        provider: string;
        modelId: string;
      }) =>
        prepareSimpleCompletionModelForAgent({
          cfg: params.config,
          agentId: "main",
          useUtilityModel: true,
          modelResolver: params.modelResolver,
        }),
    },
  ])(
    "loads only the selected plugin generation for $name",
    async ({ expectedModelId, prepare }) => {
      const tempRoot = tempRoots.makeTempDir();
      const selectedRoot = path.join(tempRoot, "selected");
      const unrelatedRoot = path.join(tempRoot, "unrelated");
      fs.mkdirSync(selectedRoot, { recursive: true });
      fs.mkdirSync(unrelatedRoot, { recursive: true });
      const selected = createColdPluginFixture({
        rootDir: selectedRoot,
        pluginId: "selected-provider-plugin",
        providerId: "selected-provider",
        manifest: {
          modelCatalog: {
            providers: {
              "selected-provider": {
                defaultUtilityModel: "utility-model",
                models: [{ id: "primary-model" }, { id: "utility-model" }],
              },
            },
          },
        },
      });
      const unrelated = createColdPluginFixture({
        rootDir: unrelatedRoot,
        pluginId: "unrelated-provider-plugin",
        providerId: "unrelated-provider",
        runtimeMessage: "unrelated provider runtime must remain cold",
      });
      fs.writeFileSync(
        selected.runtimeSource,
        `const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(selected.runtimeMarker)}, "loaded", "utf8");
module.exports = {
  id: ${JSON.stringify(selected.pluginId)},
  register(api) {
    api.registerProvider({ id: ${JSON.stringify(selected.providerId)}, label: "Selected", auth: [] });
  },
};
`,
        "utf8",
      );
      const config = {
        agents: {
          defaults: { model: `${selected.providerId}/primary-model@work` },
        },
        plugins: {
          load: { paths: [selected.rootDir, unrelated.rootDir] },
          slots: { memory: "none" },
          entries: {
            [selected.pluginId]: { enabled: true },
            [unrelated.pluginId]: { enabled: true },
          },
        },
      } satisfies OpenClawConfig;
      let preparedRuntime: PreparedModelRuntimeSnapshot | undefined;
      const modelResolver: typeof resolveModelAsync = vi.fn(
        async (provider, modelId, _agentDir, _cfg, options) => {
          preparedRuntime = options?.preparedModelRuntime;
          return {
            error: `stop after selected resolver ${provider}/${modelId}`,
            authStorage: options?.authStorage ?? AuthStorage.inMemory({}),
            modelRegistry:
              options?.modelRegistry ?? ModelRegistry.inMemory(AuthStorage.inMemory({})),
          };
        },
      );
      const env = {
        ...createColdPluginHermeticEnv(tempRoot, { bundledPluginsDir: tempRoots.makeTempDir() }),
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_STATE_DIR: path.join(tempRoot, "state"),
      };

      const result = await withEnvAsync(env, () =>
        prepare({
          config,
          modelResolver,
          provider: selected.providerId,
          modelId: expectedModelId,
        }),
      );

      expect(result).toMatchObject({
        error: `stop after selected resolver ${selected.providerId}/${expectedModelId}`,
      });
      expect(modelResolver).toHaveBeenCalledOnce();
      expect(isColdPluginRuntimeLoaded(selected)).toBe(true);
      expect(isColdPluginRuntimeLoaded(unrelated)).toBe(false);
      expect(preparedRuntime?.metadataSnapshot.pluginIds).toContain(selected.pluginId);
      expect(preparedRuntime?.metadataSnapshot.pluginIds).not.toContain(unrelated.pluginId);
      expect(preparedRuntime?.metadataSnapshot.plugins.map((plugin) => plugin.id)).toEqual([
        selected.pluginId,
      ]);
    },
  );

  it.each([
    {
      name: "another competing provider",
      keepOtherAlias: true,
      expectedProvider: "other-provider",
    },
    {
      name: "the raw fallback provider",
      keepOtherAlias: false,
      expectedProvider: "fallback-provider",
    },
  ])(
    "prepares $name before runtime alias collisions choose it",
    async ({ keepOtherAlias, expectedProvider }) => {
      const tempRoot = tempRoots.makeTempDir();
      const fixtures = [
        "alias-provider",
        "other-provider",
        "fallback-provider",
        "unrelated-provider",
      ].map((providerId) => {
        const rootDir = path.join(tempRoot, providerId);
        fs.mkdirSync(rootDir, { recursive: true });
        return createColdPluginFixture({
          rootDir,
          pluginId: `${providerId}-plugin`,
          providerId,
        });
      });
      for (const fixture of fixtures.slice(0, 3)) {
        fs.writeFileSync(
          fixture.runtimeSource,
          `const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(fixture.runtimeMarker)}, "loaded", "utf8");
module.exports = {
  id: ${JSON.stringify(fixture.pluginId)},
  register(api) {
    api.registerProvider({
      id: ${JSON.stringify(fixture.providerId)}, label: "Alias collision provider", auth: [],
      normalizeModelId({ modelId }) {
        fs.appendFileSync(${JSON.stringify(`${fixture.runtimeMarker}.hooks`)}, modelId + "\\n", "utf8");
        if (${JSON.stringify(fixture.providerId)} === "alias-provider" && modelId === "legacy") {
          return "current";
        }
        if (${JSON.stringify(fixture.providerId)} === "other-provider" && modelId === "legacy-other") {
          return "runtime-other";
        }
        if (${JSON.stringify(fixture.providerId)} === "fallback-provider" && modelId === "fast") {
          return "runtime-fast";
        }
        return undefined;
      },
    });
  },
};
`,
          "utf8",
        );
      }
      const config: OpenClawConfig = {
        agents: {
          defaults: {
            model: "fallback-provider/primary",
            models: {
              "alias-provider/older": { alias: "fast" },
              "other-provider/legacy-other": { alias: keepOtherAlias ? "fast" : "unused-other" },
              "alias-provider/legacy": { alias: "fast" },
              "unrelated-provider/unused": { alias: "unused" },
            },
          },
          entries: {
            main: {
              workspace: path.join(tempRoot, "workspace"),
              models: {
                "alias-provider/current": { alias: "" },
                ...(!keepOtherAlias ? { "alias-provider/older": { alias: "slow" } } : {}),
              },
            },
          },
        },
        plugins: {
          load: { paths: fixtures.map((fixture) => fixture.rootDir) },
          slots: { memory: "none" },
          entries: Object.fromEntries(
            fixtures.map((fixture) => [fixture.pluginId, { enabled: true }]),
          ),
        },
      };
      let preparedRuntime: PreparedModelRuntimeSnapshot | undefined;
      const modelResolver: typeof resolveModelAsync = vi.fn(
        async (provider, modelId, _agentDir, _cfg, options) => {
          preparedRuntime = options?.preparedModelRuntime;
          return {
            error: `selected ${provider}/${modelId}`,
            authStorage: options?.authStorage ?? AuthStorage.inMemory({}),
            modelRegistry:
              options?.modelRegistry ?? ModelRegistry.inMemory(AuthStorage.inMemory({})),
          };
        },
      );
      const env = {
        ...createColdPluginHermeticEnv(tempRoot, { bundledPluginsDir: tempRoots.makeTempDir() }),
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_STATE_DIR: path.join(tempRoot, "state"),
      };

      const result = await withEnvAsync(env, () =>
        prepareSimpleCompletionModelForAgent({
          cfg: config,
          agentId: "main",
          modelRef: "fast@work",
          modelResolver,
        }),
      );

      const modelId = keepOtherAlias ? "runtime-other" : "runtime-fast";
      expect(result).toMatchObject({
        error: `selected ${expectedProvider}/${modelId}`,
        selection: { provider: expectedProvider, modelId, profileId: "work" },
      });
      const expectedProviders = [
        "alias-provider",
        "fallback-provider",
        ...(keepOtherAlias ? ["other-provider"] : []),
      ].toSorted();
      expect(
        preparedRuntime?.pluginRegistry?.providers.map(({ provider }) => provider.id).toSorted(),
      ).toEqual(expectedProviders);
      expect(preparedRuntime?.metadataSnapshot.pluginIds).toEqual(
        expectedProviders.map((provider) => `${provider}-plugin`),
      );
      for (const fixture of fixtures) {
        expect(isColdPluginRuntimeLoaded(fixture)).toBe(
          expectedProviders.includes(fixture.providerId),
        );
      }
      const fallbackHooks = path.join(tempRoot, "fallback-provider", "runtime-loaded.txt.hooks");
      const fallbackModelIds = fs.existsSync(fallbackHooks)
        ? fs.readFileSync(fallbackHooks, "utf8").trim().split("\n")
        : [];
      expect(fallbackModelIds).toEqual(keepOtherAlias ? [] : ["fast"]);
    },
  );
});
