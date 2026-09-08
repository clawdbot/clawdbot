import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadAndActivateRootPluginRegistry } from "../../plugins/loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../../plugins/loader.test-fixtures.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  acquireAgentRunPreparedModelRuntime,
  getPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "../prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../prepared-model-runtime.test-support.js";
import { resolveCompactionRuntimeSelection } from "./compaction-runtime-preparation.js";

let state: OpenClawTestState;
beforeEach(async () => {
  await resetPreparedModelRuntimeSnapshotsForTest();
  state = await createOpenClawTestState({ label: "compaction-provider-owner" });
  useNoBundledPlugins();
});
afterEach(async () => {
  await resetPreparedModelRuntimeSnapshotsForTest();
  resetPluginLoaderTestStateForTest();
  await state.cleanup();
});
afterAll(cleanupPluginLoaderFixturesForTest);

it.each([
  { nextProvider: "summary-new", locked: false },
  { nextProvider: "summary-new", locked: false, alias: true },
  { nextProvider: "summary-new", locked: false, mutate: "input" },
  { nextProvider: "summary-new", locked: false, mutate: "recipe" },
  { nextProvider: undefined, locked: false },
  { nextProvider: "summary-new", locked: true },
])(
  "prepares compaction owners after reload (next=$nextProvider, locked=$locked, alias=$alias, mutate=$mutate)",
  async ({ nextProvider, locked, alias, mutate }) => {
    const ids = ["caller-provider", "requested-extra", "summary-old", "summary-new"];
    const pluginPaths = await Promise.all(
      ids.map(async (id) => {
        const plugin = writePlugin({
          id,
          body: `module.exports = {
            id: ${JSON.stringify(id)},
            register(api) {
              api.registerProvider({ id: ${JSON.stringify(id)}, label: ${JSON.stringify(id)}, auth: [] });
            },
          };`,
        });
        await fs.writeFile(
          path.join(plugin.dir, "openclaw.plugin.json"),
          JSON.stringify({
            id,
            providers: [id],
            configSchema: { type: "object", properties: {}, additionalProperties: false },
            modelIdNormalization: { providers: { [id]: { aliases: { legacy: "model" } } } },
          }),
        );
        return plugin.dir;
      }),
    );
    const gatewayWorkspace = state.workspaceDir;
    const requestWorkspace = path.join(state.root, "requested-workspace");
    const agentDir = state.agentDir("main");
    await fs.mkdir(requestWorkspace, { recursive: true });
    const config = (summaryProvider?: string): OpenClawConfig => ({
      agents: {
        ownership: "explicit",
        entries: { main: { agentDir, workspace: gatewayWorkspace } },
        defaults: {
          model: "caller-provider/model",
          models: { "summary-new/legacy": { alias: "summary-alias" } },
          ...(summaryProvider
            ? {
                compaction: {
                  model:
                    alias && summaryProvider === "summary-new"
                      ? "summary-alias"
                      : `${summaryProvider}/model`,
                },
              }
            : {}),
        },
      },
      plugins: { allow: ids, load: { paths: pluginPaths }, slots: { memory: "none" } },
    });
    const previousConfig = config("summary-old");
    const committedConfig = config(nextProvider);
    loadAndActivateRootPluginRegistry({
      config: previousConfig,
      workspaceDir: gatewayWorkspace,
      onlyPluginIds: ["caller-provider"],
      cache: false,
    });
    const publication = { gatewayLifecycle: true, catalogMode: "static" as const };
    await refreshPreparedModelRuntimeSnapshots(previousConfig, publication);
    const requested = { provider: "caller-provider", modelId: "model", runtime: "openclaw" };
    const extra = { ...requested, provider: "requested-extra" };
    const input = {
      config: previousConfig,
      agentId: "main",
      agentDir,
      workspaceDir: requestWorkspace,
      runtimePluginSelections: [requested, extra],
    };
    const previous = await acquireAgentRunPreparedModelRuntime({
      ...input,
      runtimePluginSelections: [requested, extra, { ...requested, provider: "summary-old" }],
    });
    const resumePublication = createDeferred();
    const publishing = refreshPreparedModelRuntimeSnapshots(async () => {
      await resumePublication.promise;
      return committedConfig;
    }, publication);
    const admissionOptions = {
      deriveRuntimePluginSelections: ({
        config: admittedConfig,
        metadataSnapshot,
      }: {
        config: OpenClawConfig;
        metadataSnapshot: PluginMetadataSnapshot;
      }) => {
        const selection = resolveCompactionRuntimeSelection({
          ...requested,
          config: admittedConfig,
          modelSelectionLocked: locked,
          manifestPlugins: metadataSnapshot,
          allowPluginNormalization: false,
        });
        return [{ provider: selection.provider, modelId: selection.modelId, runtime: "openclaw" }];
      },
    };
    const pending = acquireAgentRunPreparedModelRuntime(input, admissionOptions);
    const derive = admissionOptions.deriveRuntimePluginSelections;
    if (mutate === "input") {
      extra.provider = "summary-old";
    } else if (mutate === "recipe") {
      admissionOptions.deriveRuntimePluginSelections = () => [
        { ...requested, provider: "summary-old" },
      ];
    }
    try {
      resumePublication.resolve();
      await publishing;
      const lease = await pending;
      extra.provider = "requested-extra";
      admissionOptions.deriveRuntimePluginSelections = derive;
      try {
        const providers = lease.snapshot.pluginRegistry?.providers.map(
          ({ provider }) => provider.id,
        );
        expect(lease.snapshot.config).toBe(committedConfig);
        expect(lease.snapshot.workspaceDir).toBe(requestWorkspace);
        expect(providers).toEqual(
          !locked && nextProvider
            ? ["caller-provider", "requested-extra", nextProvider]
            : ["caller-provider", "requested-extra"],
        );
        const expectedSelections = [requested, extra];
        if (!locked && nextProvider) {
          expectedSelections.push({ ...requested, provider: nextProvider });
        }
        expect(
          getPreparedModelRuntimeSnapshot({
            ...input,
            config: committedConfig,
            runtimePluginSelections: expectedSelections,
          }),
        ).toBe(lease.snapshot);
        const repeated = await acquireAgentRunPreparedModelRuntime(input, admissionOptions);
        expect(repeated.snapshot).toBe(lease.snapshot);
        repeated.release();
        expect(
          previous.snapshot.pluginRegistry?.providers.map(({ provider }) => provider.id),
        ).toEqual(["caller-provider", "requested-extra", "summary-old"]);
      } finally {
        lease.release();
      }
    } finally {
      resumePublication.resolve();
      await publishing;
      await pending.then(
        (lease) => lease.release(),
        () => {},
      );
      previous.release();
    }
  },
);
