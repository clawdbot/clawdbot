/** Covers canonical plugin compaction provider registration and runtime lookup. */
import { afterEach, describe, expect, it } from "vitest";
import { getCompactionProvider, type CompactionProvider } from "./compaction-provider.js";
import { createPluginRecord } from "./loader-records.js";
import { createPluginRegistry } from "./registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";
import type { PluginRuntime } from "./runtime/types.js";

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

function createTestRegistry() {
  return createPluginRegistry({
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    runtime: {} as PluginRuntime,
    activateGlobalSideEffects: false,
  });
}

function createRecord(id: string) {
  return createPluginRecord({
    id,
    source: `/plugins/${id}/index.ts`,
    origin: "global",
    enabled: true,
    configSchema: false,
  });
}

function makeProvider(id: string, label?: string): CompactionProvider {
  return {
    id,
    label: label ?? id,
    async summarize() {
      return `summary-from-${id}`;
    },
  };
}

describe("compaction provider registry", () => {
  it("reads providers registered through the plugin API from the active registry", async () => {
    const pluginRegistry = createTestRegistry();
    const provider = makeProvider("owned");
    pluginRegistry
      .createApi(createRecord("owner"), { config: {} })
      .registerCompactionProvider(provider);
    setActivePluginRegistry(pluginRegistry.registry);

    expect(pluginRegistry.registry.compactionProviders).toEqual([
      { provider, ownerPluginId: "owner" },
    ]);
    await expect(getCompactionProvider("owned")?.summarize({ messages: [] })).resolves.toBe(
      "summary-from-owned",
    );
  });

  it("keeps the first provider when another plugin registers the same id", () => {
    const pluginRegistry = createTestRegistry();
    const first = makeProvider("shared", "first");
    const second = makeProvider("shared", "second");
    pluginRegistry
      .createApi(createRecord("first-owner"), { config: {} })
      .registerCompactionProvider(first);
    pluginRegistry
      .createApi(createRecord("second-owner"), { config: {} })
      .registerCompactionProvider(second);

    expect(pluginRegistry.registry.compactionProviders).toEqual([
      { provider: first, ownerPluginId: "first-owner" },
    ]);
    expect(pluginRegistry.registry.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        pluginId: "second-owner",
        message: "compaction provider already registered: shared (owner: first-owner)",
      }),
    );
  });
});
