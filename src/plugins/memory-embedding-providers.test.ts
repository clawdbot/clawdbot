// Covers plugin-provided memory embedding provider registration.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearMemoryEmbeddingProviders,
  getRegisteredMemoryEmbeddingProvider,
  listRegisteredMemoryEmbeddingProviders,
  registerMemoryEmbeddingProvider,
  restoreRegisteredMemoryEmbeddingProviders,
  type MemoryEmbeddingProviderAdapter,
} from "./memory-embedding-providers.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { withPluginRegistrationContext } from "./runtime.js";

const INITIAL_REGISTERED_MEMORY_EMBEDDING_PROVIDERS = listRegisteredMemoryEmbeddingProviders();

function createAdapter(id: string): MemoryEmbeddingProviderAdapter {
  return {
    id,
    create: async () => ({ provider: null }),
  };
}

function expectRegisteredProviderEntry(
  id: string,
  entry: {
    adapter: MemoryEmbeddingProviderAdapter;
    ownerPluginId?: string;
  },
) {
  expect(getRegisteredMemoryEmbeddingProvider(id)).toEqual(entry);
}

function createOwnedAdapterEntry(id: string) {
  return {
    adapter: createAdapter(id),
    ownerPluginId: "memory-core",
  };
}

function expectRegisteredProviderState(params: {
  entry: {
    adapter: MemoryEmbeddingProviderAdapter;
    ownerPluginId?: string;
  };
  expectedList?: Array<{
    adapter: MemoryEmbeddingProviderAdapter;
    ownerPluginId?: string;
  }>;
}) {
  expectRegisteredProviderEntry(params.entry.adapter.id, params.entry);
  if (params.expectedList) {
    expect(listRegisteredMemoryEmbeddingProviders()).toEqual(params.expectedList);
  }
}

function expectMemoryEmbeddingProviderIds(expectedIds: readonly string[]) {
  expect(listRegisteredMemoryEmbeddingProviders().map((entry) => entry.adapter.id)).toEqual([
    ...expectedIds,
  ]);
}

function expectCurrentMemoryEmbeddingProvider(
  id: string,
  adapter: MemoryEmbeddingProviderAdapter | undefined,
) {
  expect(getRegisteredMemoryEmbeddingProvider(id)?.adapter).toBe(adapter);
}

function expectMemoryEmbeddingProviderState(params: {
  expectedIds: readonly string[];
  expectedCurrent?: { id: string; adapter: MemoryEmbeddingProviderAdapter };
}) {
  if (params.expectedCurrent) {
    expectCurrentMemoryEmbeddingProvider(params.expectedCurrent.id, params.expectedCurrent.adapter);
  }
  expectMemoryEmbeddingProviderIds(params.expectedIds);
}

function expectRegisteredProviderSnapshotCase(params: {
  entry: {
    adapter: MemoryEmbeddingProviderAdapter;
    ownerPluginId?: string;
  };
  setup: (entry: { adapter: MemoryEmbeddingProviderAdapter; ownerPluginId?: string }) => void;
  expectedList?: Array<{
    adapter: MemoryEmbeddingProviderAdapter;
    ownerPluginId?: string;
  }>;
}) {
  params.setup(params.entry);
  expectRegisteredProviderState({
    entry: params.entry,
    ...(params.expectedList ? { expectedList: params.expectedList } : {}),
  });
}

beforeEach(() => {
  clearMemoryEmbeddingProviders();
});

afterEach(() => {
  restoreRegisteredMemoryEmbeddingProviders(INITIAL_REGISTERED_MEMORY_EMBEDDING_PROVIDERS);
});

describe("memory embedding provider registry", () => {
  it("registers and lists adapters in insertion order", () => {
    const alpha = createAdapter("alpha");
    const beta = createAdapter("beta");
    registerMemoryEmbeddingProvider(alpha);
    registerMemoryEmbeddingProvider(beta);

    expectMemoryEmbeddingProviderState({
      expectedIds: ["alpha", "beta"],
      expectedCurrent: { id: "alpha", adapter: alpha },
    });
  });

  it.each([
    {
      name: "tracks owner plugin ids in registered snapshots",
      entry: createOwnedAdapterEntry("alpha"),
      setup: (entry: { adapter: MemoryEmbeddingProviderAdapter; ownerPluginId?: string }) =>
        registerMemoryEmbeddingProvider(entry.adapter, { ownerPluginId: entry.ownerPluginId }),
      expectList: true,
    },
    {
      name: "restores registered snapshots with owner metadata",
      entry: createOwnedAdapterEntry("beta"),
      setup: (entry: { adapter: MemoryEmbeddingProviderAdapter; ownerPluginId?: string }) =>
        restoreRegisteredMemoryEmbeddingProviders([entry]),
      expectList: false,
    },
  ] as const)("$name", ({ entry, setup, expectList }) => {
    expectRegisteredProviderSnapshotCase({
      entry,
      setup,
      ...(expectList ? { expectedList: [entry] } : {}),
    });
  });

  it("clears the registry", () => {
    registerMemoryEmbeddingProvider(createAdapter("alpha"));

    clearMemoryEmbeddingProviders();

    expectMemoryEmbeddingProviderIds([]);
  });

  it("stores adapters in the active registry", () => {
    const alpha = createAdapter("alpha");
    registerMemoryEmbeddingProvider(alpha, { ownerPluginId: "memory-core" });

    expect(getRegisteredMemoryEmbeddingProvider("alpha")).toEqual({
      adapter: alpha,
      ownerPluginId: "memory-core",
    });
  });

  it("uses builder ownership without displacing another plugin's adapter", () => {
    const building = createEmptyPluginRegistry();
    const original = createAdapter("shared");
    building.memoryEmbeddingProviders.push({
      pluginId: "first-plugin",
      provider: original,
      source: "runtime",
    });

    expect(() =>
      withPluginRegistrationContext(building, "failing-plugin", () => {
        registerMemoryEmbeddingProvider(createAdapter("shared"));
      }),
    ).toThrow("memory embedding provider shared already registered by first-plugin");
    expect(building.memoryEmbeddingProviders[0]?.provider).toBe(original);

    withPluginRegistrationContext(building, "builder-plugin", () => {
      registerMemoryEmbeddingProvider(createAdapter("owned"));
    });
    expect(building.memoryEmbeddingProviders[1]?.pluginId).toBe("builder-plugin");
  });
});
