// Covers plugin embedding provider registration and lookup.
import { beforeEach, describe, expect, it } from "vitest";
import { collectRegisteredEmbeddingProviderIds } from "./channel-plugin-ids.js";
import { CORE_EMBEDDING_PROVIDERS } from "./core-embedding-providers.js";
import {
  getRegisteredEmbeddingProvider,
  listRegisteredEmbeddingProviders,
  registerEmbeddingProvider,
  restoreRegisteredEmbeddingProviders,
  type EmbeddingProviderAdapter,
} from "./embedding-providers.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  rollbackStagedPluginRegistry,
  stageActivePluginRegistry,
  withPluginRegistrationContext,
} from "./runtime.js";

function createAdapter(id: string): EmbeddingProviderAdapter {
  return {
    id,
    create: async () => ({ provider: null }),
  };
}

beforeEach(({ onTestFinished }) => {
  const previous = captureActivePluginRegistrySnapshot();
  onTestFinished(() => rollbackStagedPluginRegistry(previous));
  stageActivePluginRegistry(createEmptyPluginRegistry(), null, "default");
});

describe("embedding provider registry", () => {
  it("preserves owner metadata in registered snapshots", () => {
    const adapter = createAdapter("local-compatible");
    const entry = {
      adapter,
      ownerPluginId: "local-compatible",
    };

    restoreRegisteredEmbeddingProviders([entry]);

    expect(getRegisteredEmbeddingProvider("local-compatible")).toEqual(entry);
    expect(listRegisteredEmbeddingProviders()).toEqual([...CORE_EMBEDDING_PROVIDERS, entry]);
  });

  it.each(CORE_EMBEDDING_PROVIDERS)(
    "keeps core provider $adapter.id from being shadowed by restored snapshots",
    (coreEntry) => {
      const adapter = createAdapter(coreEntry.adapter.id);

      expect(() =>
        restoreRegisteredEmbeddingProviders([
          {
            adapter,
            ownerPluginId: "shadow",
          },
        ]),
      ).toThrow(`embedding provider already registered: ${adapter.id} (owner: core)`);

      expect(getRegisteredEmbeddingProvider(adapter.id)).toBe(coreEntry);
    },
  );

  it("stores adapters in the active registry", () => {
    const adapter = createAdapter("local-protocol");
    registerEmbeddingProvider(adapter, { ownerPluginId: "local-protocol" });

    expect(getRegisteredEmbeddingProvider("local-protocol")).toEqual({
      adapter,
      ownerPluginId: "local-protocol",
    });
  });

  it("uses builder ownership without displacing another plugin's adapter", () => {
    const building = createEmptyPluginRegistry();
    const original = createAdapter("shared");
    building.embeddingProviders.push({
      pluginId: "first-plugin",
      provider: original,
      source: "runtime",
    });

    expect(() =>
      withPluginRegistrationContext(building, "failing-plugin", () => {
        registerEmbeddingProvider(createAdapter("shared"));
      }),
    ).toThrow("embedding provider shared already registered by first-plugin");
    expect(building.embeddingProviders[0]?.provider).toBe(original);

    withPluginRegistrationContext(building, "builder-plugin", () => {
      registerEmbeddingProvider(createAdapter("owned"));
    });
    expect(building.embeddingProviders[1]?.pluginId).toBe("builder-plugin");
  });
});

describe("collectRegisteredEmbeddingProviderIds", () => {
  // Boot-equivalence: the shared helper unions the same three sources the gateway
  // startup "configured but unregistered" warning uses, so the /status drift line and
  // the boot warning agree on what counts as "registered".
  it("unions registry embedding providers with the global registry", () => {
    registerEmbeddingProvider(createAdapter("global-embed"), { ownerPluginId: "p" });
    const registry = {
      embeddingProviders: [{ provider: { id: "gen-embed" } }],
    } as never;

    const ids = collectRegisteredEmbeddingProviderIds(registry);

    expect(ids.has("gen-embed")).toBe(true);
    expect(ids.has("global-embed")).toBe(true);
    // Every globally registered provider (core + plugin-registered) is always included.
    for (const entry of listRegisteredEmbeddingProviders()) {
      expect(ids.has(entry.adapter.id)).toBe(true);
    }
  });

  it("returns only the global registry ids when the runtime registry omits embedding providers", () => {
    const ids = collectRegisteredEmbeddingProviderIds({});

    expect(ids).toEqual(
      new Set(listRegisteredEmbeddingProviders().map((entry) => entry.adapter.id)),
    );
  });
});
