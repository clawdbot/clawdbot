// Covers plugin embedding provider registration and lookup.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectRegisteredEmbeddingProviderIds } from "./channel-plugin-ids.js";
import {
  clearEmbeddingProviders,
  getRegisteredEmbeddingProvider,
  listRegisteredEmbeddingProviders,
  registerEmbeddingProvider,
  restoreRegisteredEmbeddingProviders,
  type EmbeddingProviderAdapter,
} from "./embedding-providers.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { withPluginRegistrationContext } from "./runtime.js";

const INITIAL_REGISTERED_EMBEDDING_PROVIDERS = listRegisteredEmbeddingProviders();

function createAdapter(id: string): EmbeddingProviderAdapter {
  return {
    id,
    create: async () => ({ provider: null }),
  };
}

beforeEach(() => {
  clearEmbeddingProviders();
});

afterEach(() => {
  restoreRegisteredEmbeddingProviders(INITIAL_REGISTERED_EMBEDDING_PROVIDERS);
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
    expect(listRegisteredEmbeddingProviders()).toEqual([
      INITIAL_REGISTERED_EMBEDDING_PROVIDERS[0],
      entry,
    ]);
  });

  it("keeps core providers from being shadowed by restored snapshots", () => {
    const adapter = createAdapter("openai-compatible");

    expect(() =>
      restoreRegisteredEmbeddingProviders([
        {
          adapter,
          ownerPluginId: "shadow",
        },
      ]),
    ).toThrow("embedding provider already registered: openai-compatible (owner: core)");

    expect(getRegisteredEmbeddingProvider("openai-compatible")).toEqual(
      INITIAL_REGISTERED_EMBEDDING_PROVIDERS[0],
    );
  });

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
