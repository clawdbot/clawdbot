import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveModelAsync } from "../agents/embedded-agent-runner/model.js";
import {
  acquireReadOnlyPreparedModelRuntime,
  prepareModelRuntimeSnapshot,
  PreparedModelRuntimeOwnerNotPublishedError,
} from "../agents/prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../agents/prepared-model-runtime.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  cleanupPluginLoaderFixturesForTest,
  clearPluginLoaderCache,
  loadOpenClawPlugins,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { checkTouchedTextModelRefs } from "./config-model-validation.js";

const primary = "pin-alpha/exact-supported";
const fallback = "pin-beta/exact-supported";
const providerIds = ["pin-alpha", "pin-beta", "pin-unrelated"];

function clearRuntimeState() {
  resetPreparedModelRuntimeSnapshotsForTest();
  clearPluginLoaderCache();
}

async function withProviderFixtures(
  run: (fixture: {
    config: OpenClawConfig;
    state: OpenClawTestState;
    imported: (provider: string) => boolean;
  }) => Promise<void>,
) {
  await withOpenClawTestState(
    {
      label: "config-model-runtime",
      env: {
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      },
    },
    async (state) => {
      const imported = (provider: string) => fs.existsSync(state.path(`${provider}.imported`));
      const plugins = providerIds.map((id) => {
        const plugin = writePlugin({
          id,
          dir: state.path("plugins", id),
          body: `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(state.path(`${id}.imported`))}, "loaded");
module.exports = {
  id: ${JSON.stringify(id)},
  register(api) {
    api.registerProvider({
      id: ${JSON.stringify(id)},
      label: ${JSON.stringify(id)},
      auth: [],
      resolveDynamicModel({ modelId }) {
        if (modelId === "resolution-error") {
          throw new Error("fixture dynamic resolution failed");
        }
        if (modelId !== "exact-supported") return undefined;
        return {
          id: modelId,
          name: modelId,
          provider: ${JSON.stringify(id)},
          api: "openai-completions",
          baseUrl: "https://provider.invalid/v1",
          reasoning: false,
          input: ["text"],
          contextWindow: 32000,
          maxTokens: 4096,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        };
      },
    });
  },
};`,
        });
        fs.writeFileSync(
          path.join(plugin.dir, "openclaw.plugin.json"),
          JSON.stringify({
            id,
            configSchema: { type: "object", additionalProperties: false, properties: {} },
            providers: [id],
            modelCatalog: { providers: { [id]: { models: [{ id: "catalog-model" }] } } },
          }),
        );
        return plugin;
      });
      const config: OpenClawConfig = {
        agents: {
          defaults: { workspace: state.workspaceDir, model: { primary } },
          entries: { main: { default: true } },
        },
        plugins: {
          allow: [...providerIds],
          load: { paths: plugins.map((plugin) => plugin.file) },
          entries: Object.fromEntries(providerIds.map((id) => [id, { enabled: true }])),
        },
      };
      try {
        await run({ config, state, imported });
      } finally {
        clearRuntimeState();
      }
    },
  );
}

describe("config model validation with provider runtime", () => {
  beforeEach(() => {
    clearRuntimeState();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("Unexpected network request during config model validation");
    });
  });

  afterEach(() => {
    try {
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      clearRuntimeState();
    }
  });

  afterAll(cleanupPluginLoaderFixturesForTest);

  it("resolves an uncataloged fixture pin when its provider runtime is prepared", async () => {
    await withProviderFixtures(async ({ config, state, imported }) => {
      const lease = await acquireReadOnlyPreparedModelRuntime({
        config,
        agentId: "main",
        agentDir: state.agentDir(),
        workspaceDir: state.workspaceDir,
        loadRuntimePlugins: true,
        runtimePluginSelections: [{ provider: "pin-alpha", modelId: "exact-supported" }],
      });
      try {
        const prepared = lease.snapshot;
        const result = await resolveModelAsync(
          "pin-alpha",
          "exact-supported",
          state.agentDir(),
          config,
          {
            ...prepared.createStores(),
            agentId: "main",
            workspaceDir: state.workspaceDir,
            preparedModelRuntime: prepared,
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.model).toMatchObject({ provider: "pin-alpha", id: "exact-supported" });
        expect(imported("pin-alpha")).toBe(true);
        expect(imported("pin-beta")).toBe(false);
        expect(imported("pin-unrelated")).toBe(false);
      } finally {
        lease.release();
      }
    });
  });

  it("accepts a fresh supported exact primary without changing the input or loading unrelated plugins", async () => {
    await withProviderFixtures(async ({ config, imported }) => {
      const original = structuredClone(config);
      expect(providerIds.some(imported)).toBe(false);

      const result = await checkTouchedTextModelRefs({
        config,
        touchedPaths: [["agents", "defaults", "model", "primary"]],
      });

      expect(config).toEqual(original);
      expect(imported("pin-unrelated")).toBe(false);
      expect(result).toEqual({ refsChecked: 1, refsTotal: 1, errors: [] });
    });
  });

  it.each([
    { modelId: "unsupported", refsChecked: 1, error: "Unknown model: pin-alpha/unsupported" },
    {
      modelId: "resolution-error",
      refsChecked: 0,
      error: "Unable to validate model reference: fixture dynamic resolution failed",
    },
  ])(
    "rejects $modelId and releases its isolated runtime owner",
    async ({ modelId, refsChecked, error }) => {
      await withProviderFixtures(async ({ config, state, imported }) => {
        config.agents!.defaults!.model = { primary: `pin-alpha/${modelId}` };

        const result = await checkTouchedTextModelRefs({
          config,
          touchedPaths: [["agents", "defaults", "model", "primary"]],
        });

        expect(result).toEqual({
          refsChecked,
          refsTotal: 1,
          errors: [expect.stringContaining(error)],
        });
        expect(imported("pin-unrelated")).toBe(false);
        const pendingSnapshot = prepareModelRuntimeSnapshot({
          config,
          agentId: "main",
          agentDir: state.agentDir(),
          workspaceDir: state.workspaceDir,
          readOnly: true,
          loadRuntimePlugins: true,
          runtimePluginSelections: [{ provider: "pin-alpha", modelId, agentId: "main" }],
        });
        if (modelId === "resolution-error") {
          await expect(pendingSnapshot).rejects.toThrow("fixture dynamic resolution failed");
        } else {
          await expect(pendingSnapshot).rejects.toBeInstanceOf(
            PreparedModelRuntimeOwnerNotPublishedError,
          );
        }
      });
    },
  );

  it("validates distinct primary and fallback providers for every inheriting agent in one operation", async () => {
    await withProviderFixtures(async ({ config, state, imported }) => {
      config.agents!.defaults!.model = { primary, fallbacks: [fallback] };
      config.agents!.entries!.ops = { workspace: state.workspaceDir };
      const original = structuredClone(config);

      const result = await checkTouchedTextModelRefs({
        config,
        touchedPaths: [["agents", "defaults", "model"]],
      });

      expect(config).toEqual(original);
      expect(imported("pin-unrelated")).toBe(false);
      expect(result).toEqual({ refsChecked: 4, refsTotal: 4, errors: [] });
    });
  });

  it.each(["disabled", "denied", "not allowed"] as const)(
    "rejects a %s provider even when an ambient registry has its hook",
    async (policy) => {
      await withProviderFixtures(async ({ config, state, imported }) => {
        const ambient = loadOpenClawPlugins({
          config,
          workspaceDir: state.workspaceDir,
          onlyPluginIds: ["pin-alpha"],
          activate: true,
        });
        expect(ambient.providers).toContainEqual(
          expect.objectContaining({
            provider: expect.objectContaining({
              id: "pin-alpha",
              resolveDynamicModel: expect.any(Function),
            }),
          }),
        );
        const blocked = structuredClone(config);
        if (policy === "disabled") {
          blocked.plugins!.entries!["pin-alpha"] = { enabled: false };
        } else if (policy === "denied") {
          blocked.plugins!.deny = ["pin-alpha"];
        } else {
          blocked.plugins!.allow = ["pin-beta", "pin-unrelated"];
        }

        const result = await checkTouchedTextModelRefs({
          config: blocked,
          touchedPaths: [["agents", "defaults", "model", "primary"]],
        });
        expect(result).toEqual({
          refsChecked: 1,
          refsTotal: 1,
          errors: [expect.stringContaining("Unknown model: pin-alpha/exact-supported")],
        });
        expect(imported("pin-unrelated")).toBe(false);
      });
    },
  );
});
