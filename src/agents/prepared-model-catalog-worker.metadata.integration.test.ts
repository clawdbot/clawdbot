import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  createPluginCache,
  getPluginMetadataSnapshotCache,
  withPluginCache,
} from "../plugins/plugin-cache.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { preparePublishedModelCatalogOwnerIdentity } from "./prepared-model-catalog-owner.js";
import { createCatalogFixture, PROVIDER_ID } from "./prepared-model-catalog-worker.test-support.js";
import { usePreparedCatalogWorkerFixtures } from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir, retireAfterTest, waitForWorkers } = usePreparedCatalogWorkerFixtures();

describe("prepared catalog parent metadata ownership", () => {
  it("retains canonical metadata across module evaluation and clones only for the worker", async () => {
    const fixture = createCatalogFixture(makeTempDir, 0);
    const { agentDir, config, env, workspaceDir } = fixture;
    const cache = createPluginCache();
    const metadata = withPluginCache(cache, () =>
      loadPluginMetadataSnapshot({ config, env, workspaceDir, allowCurrent: false }),
    );
    const input = {
      agentId: "main",
      agentDir,
      inheritedAuthDir: agentDir,
      config,
      env,
      workspaceDir,
    };
    let current = true;
    retireAfterTest(() => {
      current = false;
    });

    // The operation owns this frozen graph across module evaluation, as retained
    // Gateway generations do. A new module must not reinstall its Map mutators.
    vi.resetModules();
    const [runtimeBuild, providerRuntime, metadataRuntime, generationScope] = await Promise.all([
      import("./prepared-model-runtime.build.js"),
      import("../plugins/provider-runtime.js"),
      import("../plugins/current-plugin-metadata-snapshot.js"),
      import("../plugins/runtime/generation-scope.js"),
    ]);
    let registry: PluginRegistry | undefined;
    const capture = providerRuntime.captureProviderSyntheticAuthFacts;
    const captureSpy = vi
      .spyOn(providerRuntime, "captureProviderSyntheticAuthFacts")
      .mockImplementation((params) => {
        expect(metadataRuntime.getCurrentPluginMetadataSnapshot()).toBe(metadata);
        expect(generationScope.getPluginRuntimeGenerationRegistry()).toBe(registry);
        expect(getPluginMetadataSnapshotCache(metadata)).toBe(cache);
        return capture(params);
      });
    try {
      await withPluginCache(cache, async () => {
        const build = runtimeBuild.startSerializedSnapshotBuildBatch(
          [
            {
              input,
              catalogOwner: preparePublishedModelCatalogOwnerIdentity(input),
              isGenerationCurrent: () => current,
              isBuildCurrent: () => current,
            },
          ],
          new Map(),
          30_000,
          "static",
          undefined,
          metadata,
        );
        let prepared: Awaited<typeof build.pending>[number] | undefined;
        try {
          [prepared] = await build.pending;
        } finally {
          await build.completion;
        }
        if (!prepared) {
          throw new Error("prepared runtime produced no snapshot");
        }
        registry = prepared.pluginGeneration.pluginRegistry;
        expect(registry).toBeDefined();
        expect(prepared.snapshot.metadataSnapshot).toBe(metadata);
        expect(prepared.snapshot.metadataSnapshot.index).toBe(metadata.index);
        expect(metadata.normalizePluginId(` ${PROVIDER_ID.toUpperCase()} `)).toBe(PROVIDER_ID);
        expect(fs.existsSync(fixture.marker)).toBe(false);
        expect(captureSpy).not.toHaveBeenCalled();
        await waitForWorkers();

        const catalog = await prepared.snapshot.loadFullModelCatalog!();
        expect(captureSpy).toHaveBeenCalledOnce();
        expect(catalog.entries).toContainEqual(
          expect.objectContaining({ provider: PROVIDER_ID, id: "plugin-generation-v1" }),
        );
        expect(fs.readFileSync(fixture.marker, "utf8")).toBe("start\ndone\n");
        expect(Object.isFrozen(metadata.byPluginId)).toBe(true);
      });
    } finally {
      current = false;
      try {
        await waitForWorkers();
      } finally {
        captureSpy.mockRestore();
        cache.disposeModules?.();
      }
    }
  });
});
