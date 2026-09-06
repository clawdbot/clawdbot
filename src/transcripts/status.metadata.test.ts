import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createPluginMetadataSnapshot } from "../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { installTemporaryCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import * as discovery from "../plugins/discovery.js";
import * as loader from "../plugins/loader.js";
import { loadPluginManifestRegistryForInstalledIndex } from "../plugins/manifest-registry-installed.js";
import { restorePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  getActivePluginRegistry,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readTranscriptLibraryStatus } from "./status.js";
import { TranscriptsStore } from "./store.js";

describe("transcript setup metadata boundary", () => {
  it("offers a cold manifest source before and after a provider-only scoped registration without discovering runtime in status", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const pluginId = "fixture-captions";
      const providerId = "fixture-caption-source";
      const rootDir = state.statePath("fixture-plugin");
      const source = await state.writeText(
        "fixture-plugin/index.cjs",
        `module.exports = {
        id: "fixture-captions", register(api) {
          api.registerTranscriptSourceProvider({ id: "fixture-caption-source", name: "Runtime captions", sourceKinds: ["live-caption"],
            async start() { throw new Error("status must not start capture"); }
          });
        }
      };`,
      );
      const descriptor = {
        name: "Fixture captions",
        autoStart: { accountId: "optional", meetingUrl: "required" },
      };
      const manifestPath = await state.writeJson("fixture-plugin/openclaw.plugin.json", {
        id: pluginId,
        configSchema: { type: "object", additionalProperties: false, properties: {} },
        contracts: { transcriptSourceProviders: [providerId] },
        transcriptSources: { [providerId]: descriptor },
      });
      const cfg: OpenClawConfig = {
        plugins: {
          allow: [pluginId],
          entries: { [pluginId]: { enabled: true } },
          load: { paths: [rootDir] },
          slots: { memory: "none" },
        },
      };
      const initial = createPluginMetadataSnapshot({
        config: cfg,
        manifestRegistry: { plugins: [], diagnostics: [] },
      });
      initial.index.plugins = [
        {
          pluginId,
          source,
          manifestPath,
          rootDir,
          manifestHash: "fixture",
          origin: "config",
          enabled: true,
          startup: { sidecar: false, memory: false, agentHarnesses: [] },
          compat: [],
        },
      ];
      const manifestRegistry = loadPluginManifestRegistryForInstalledIndex({
        index: initial.index,
        config: cfg,
        env: state.env,
      });
      const metadata = restorePluginMetadataSnapshot({
        ...initial,
        manifestRegistry,
        plugins: manifestRegistry.plugins,
        byPluginId: new Map(manifestRegistry.plugins.map((plugin) => [plugin.id, plugin])),
      });
      const previous = captureActivePluginRegistrySnapshot();
      const active = createEmptyPluginRegistry();
      setActivePluginRegistry(active);
      const lease = installTemporaryCurrentPluginMetadataSnapshot(metadata, { config: cfg });
      const store = new TranscriptsStore(state.statePath("transcripts"));
      const readStatus = async () => {
        const discover = vi.spyOn(discovery, "discoverOpenClawPlugins").mockImplementation(() => {
          throw new Error("status must not discover plugins");
        });
        const resolve = vi.spyOn(loader, "resolveRuntimePluginRegistry").mockImplementation(() => {
          throw new Error("status must not resolve runtime");
        });
        const read = vi.spyOn(fs, "readFileSync");
        try {
          const result = await readTranscriptLibraryStatus(store, cfg);
          expect(discover).not.toHaveBeenCalled();
          expect(resolve).not.toHaveBeenCalled();
          expect(
            read.mock.calls.some(
              ([file]) => String(file) === manifestPath || String(file) === source,
            ),
          ).toBe(false);
          return result;
        } finally {
          read.mockRestore();
          resolve.mockRestore();
          discover.mockRestore();
        }
      };
      try {
        const before = await readStatus();
        const scoped = loader.loadPluginRegistryHandle({
          config: cfg,
          env: state.env,
          onlyPluginIds: [pluginId],
          manifestRegistry,
          discovery: {
            candidates: [{ idHint: pluginId, source, rootDir, origin: "config" }],
            diagnostics: [],
          },
          cache: false,
        });
        expect(scoped.transcriptSourceProviders.map((entry) => entry.provider.id)).toEqual([
          providerId,
        ]);
        expect(getActivePluginRegistry()).toBe(active);
        expect(active.transcriptSourceProviders).toEqual([]);
        const after = await readStatus();
        for (const result of [before, after]) {
          expect(result.providers.find((provider) => provider.providerId === providerId)).toEqual({
            providerId,
            pluginId,
            name: descriptor.name,
            availability: "enabled",
            autoStart: descriptor.autoStart,
          });
        }
      } finally {
        lease.release();
        restoreActivePluginRegistrySnapshot(previous);
      }
    });
  });
});
