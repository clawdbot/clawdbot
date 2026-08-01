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

const EMBEDDING_PROVIDERS_KEY = Symbol.for("openclaw.embeddingProviders");
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

  it("stores adapters in a process-global singleton map", () => {
    const adapter = createAdapter("local-protocol");
    registerEmbeddingProvider(adapter, { ownerPluginId: "local-protocol" });

    const globalRegistry = (globalThis as Record<PropertyKey, unknown>)[
      EMBEDDING_PROVIDERS_KEY
    ] as Map<string, { adapter: EmbeddingProviderAdapter; ownerPluginId?: string }>;

    expect(globalRegistry.get("local-protocol")).toEqual({
      adapter,
      ownerPluginId: "local-protocol",
    });
  });
});

describe("collectRegisteredEmbeddingProviderIds", () => {
  // Boot-equivalence: the shared helper unions the same three sources the gateway
  // startup "configured but unregistered" warning uses, so the /status drift line and
  // the boot warning agree on what counts as "registered".
  it("unions registry memory + general embedding providers with the global registry", () => {
    registerEmbeddingProvider(createAdapter("global-embed"), { ownerPluginId: "p" });
    const registry = {
      memoryEmbeddingProviders: [{ provider: { id: "mem-embed" } }],
      embeddingProviders: [{ provider: { id: "gen-embed" } }],
    } as never;

    const ids = collectRegisteredEmbeddingProviderIds(registry);

    expect(ids.has("mem-embed")).toBe(true);
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
