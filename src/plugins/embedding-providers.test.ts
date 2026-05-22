import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearEmbeddingProviders,
  getEmbeddingProvider,
  getRegisteredEmbeddingProvider,
  listEmbeddingProviders,
  listRegisteredEmbeddingProviders,
  registerEmbeddingProvider,
  restoreEmbeddingProviders,
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
  it("registers and lists adapters in insertion order", () => {
    const alpha = createAdapter("alpha");
    const beta = createAdapter("beta");

    registerEmbeddingProvider(alpha);
    registerEmbeddingProvider(beta);

    expect(listEmbeddingProviders().map((adapter) => adapter.id)).toEqual(["alpha", "beta"]);
    expect(getEmbeddingProvider("alpha")).toBe(alpha);
  });

  it("restores adapter snapshots", () => {
    const alpha = createAdapter("alpha");
    const beta = createAdapter("beta");
    registerEmbeddingProvider(alpha);

    restoreEmbeddingProviders([beta]);

    expect(getEmbeddingProvider("alpha")).toBeUndefined();
    expect(getEmbeddingProvider("beta")).toBe(beta);
  });

  it("preserves owner metadata in registered snapshots", () => {
    const adapter = createAdapter("openai-compatible");
    const entry = {
      adapter,
      ownerPluginId: "openai-compatible",
    };

    restoreRegisteredEmbeddingProviders([entry]);

    expect(getRegisteredEmbeddingProvider("openai-compatible")).toEqual(entry);
    expect(listRegisteredEmbeddingProviders()).toEqual([entry]);
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
