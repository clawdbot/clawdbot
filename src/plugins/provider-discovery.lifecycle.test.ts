import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginCache, retirePluginCache, withPluginCache } from "./plugin-cache.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import { runProviderStaticCatalog } from "./provider-discovery.js";
import { resolvePluginDiscoveryProvidersRuntime } from "./provider-discovery.runtime.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

// The sibling unit suite mocks this graph in shared plugin workers.
vi.hoisted(() => vi.resetModules());

const tempDirs: string[] = [];
const caches: ReturnType<typeof createPluginCache>[] = [];
const listenerEvents: string[] = [];

afterEach(async () => {
  try {
    await Promise.all(caches.splice(0).map(retirePluginCache));
  } finally {
    for (const event of listenerEvents.splice(0)) {
      process.removeAllListeners(event);
    }
    cleanupTrackedTempDirs(tempDirs);
  }
});

describe("provider discovery inventory lifecycle", () => {
  it("keeps source graphs and callbacks with their exact metadata inventory", async () => {
    const rootDir = fs.realpathSync(makeTrackedTempDir("openclaw-discovery-lifecycle", tempDirs));
    const source = path.join(rootDir, "provider-discovery.ts");
    const runtimeSource = path.join(rootDir, "index.ts");
    const event = `openclaw.discovery-lifecycle.${path.basename(rootDir)}`;
    listenerEvents.push(event);
    fs.writeFileSync(runtimeSource, 'throw new Error("runtime entry must remain unloaded");\n');
    const write = (version: string) => {
      fs.writeFileSync(
        path.join(rootDir, "dependency.ts"),
        `const value: string = "dependency-${version}"; export default value;\n`,
      );
      fs.writeFileSync(
        path.join(rootDir, "lazy.ts"),
        `const value: string = "lazy-${version}"; export default value;\n`,
      );
      fs.writeFileSync(
        source,
        `import dependency from "./dependency.ts";
         process.on(${JSON.stringify(event)}, () => {});
         export default {
           id: "discovery-lifecycle", label: "entry-${version}:" + dependency, auth: [],
           staticCatalog: { order: "simple", async run() {
             const lazy = (await import("./lazy.ts")).default;
             return { provider: {
               baseUrl: "https://catalog.example.test/entry-${version}/" + dependency + "/" + lazy,
               models: []
             } };
           } }
         };\n`,
      );
    };
    const previous = createPluginCache();
    const next = createPluginCache();
    const ambient = createPluginCache();
    caches.push(previous, next, ambient);
    const snapshot = (cache: ReturnType<typeof createPluginCache>) =>
      withPluginCache(cache, () =>
        createPluginMetadataSnapshotFixture({
          plugins: [
            {
              id: "discovery-lifecycle",
              origin: "global",
              rootDir,
              source: runtimeSource,
              providerDiscoverySource: source,
              providers: ["discovery-lifecycle"],
            },
          ],
        }),
      );
    const discover = (pluginMetadataSnapshot: PluginMetadataSnapshot) => {
      // Deferred catalog readers can hold a snapshot outside its original async scope.
      const providers = withPluginCache(ambient, () =>
        resolvePluginDiscoveryProvidersRuntime({
          config: { plugins: { entries: { "discovery-lifecycle": { enabled: true } } } },
          env: {},
          pluginMetadataSnapshot,
          onlyPluginIds: ["discovery-lifecycle"],
          discoveryEntriesOnly: true,
        }),
      );
      expect(providers.map((provider) => provider.id)).toEqual(["discovery-lifecycle"]);
      return providers[0]!;
    };
    const catalog = (version: string) => ({
      provider: {
        baseUrl: `https://catalog.example.test/entry-${version}/dependency-${version}/lazy-${version}`,
        models: [],
      },
    });

    write("before");
    const previousSnapshot = snapshot(previous);
    const before = discover(previousSnapshot);
    expect(before.label).toBe("entry-before:dependency-before");
    expect(process.listenerCount(event)).toBe(1);

    write("after");
    // The lazy dependency has not executed yet, but belongs to the captured old graph.
    expect(await runProviderStaticCatalog({ provider: before })).toEqual(catalog("before"));
    expect(discover(previousSnapshot).label).toBe("entry-before:dependency-before");
    const after = discover(snapshot(next));
    expect(after.label).toBe("entry-after:dependency-after");
    expect(await runProviderStaticCatalog({ provider: after })).toEqual(catalog("after"));
    expect(process.listenerCount(event)).toBe(2);

    await retirePluginCache(previous);
    await expect(async () => runProviderStaticCatalog({ provider: before })).rejects.toThrow(
      /reloaded|disabled/,
    );
    expect(process.listenerCount(event)).toBe(1);
    await retirePluginCache(ambient);
    expect(await runProviderStaticCatalog({ provider: after })).toEqual(catalog("after"));
    await retirePluginCache(next);
    expect(process.listenerCount(event)).toBe(0);
  });
});
