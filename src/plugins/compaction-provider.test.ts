import { afterEach, describe, expect, it } from "vitest";
import {
  clearCompactionProviders,
  getCompactionProvider,
  getRegisteredCompactionProvider,
  listCompactionProviderIds,
  listRegisteredCompactionProviders,
  registerCompactionProvider,
  restoreRegisteredCompactionProviders,
  type CompactionProvider,
} from "./compaction-provider.js";

const REGISTRY_KEY = Symbol.for("openclaw.compactionProviderRegistryState");

/** Reset the process-global registry between tests. */
afterEach(() => {
  const g = globalThis as Record<symbol, unknown>;
  delete g[REGISTRY_KEY];
});

function makeProvider(id: string, label?: string): CompactionProvider {
  return {
    id,
    label: label ?? id,
    async summarize() {
      return `summary-from-${id}`;
    },
  };
}

function requireCompactionProvider(id: string): CompactionProvider {
  const provider = getCompactionProvider(id);
  if (!provider) {
    throw new Error(`Expected compaction provider ${id}`);
  }
  return provider;
}

describe("compaction provider registry", () => {
  it("starts empty", () => {
    expect(listCompactionProviderIds()).toStrictEqual([]);
    expect(listRegisteredCompactionProviders()).toStrictEqual([]);
  });

  it("returns undefined for an unknown id", () => {
    expect(getCompactionProvider("nonexistent")).toBeUndefined();
    expect(getRegisteredCompactionProvider("nonexistent")).toBeUndefined();
  });

  it("registers and retrieves a provider", () => {
    const p = makeProvider("test-compactor");
    registerCompactionProvider(p);

    expect(getCompactionProvider("test-compactor")).toBe(p);
  });

  it("tracks ownerPluginId", () => {
    const p = makeProvider("owned");
    registerCompactionProvider(p, { ownerPluginId: "my-plugin" });

    const entry = getRegisteredCompactionProvider("owned");
    expect(entry?.provider).toBe(p);
    expect(entry?.ownerPluginId).toBe("my-plugin");
  });

  it("lists registered provider ids", () => {
    registerCompactionProvider(makeProvider("alpha"));
    registerCompactionProvider(makeProvider("beta"));

    expect(listCompactionProviderIds()).toEqual(["alpha", "beta"]);
  });

  it("lists registered entries with owner metadata", () => {
    registerCompactionProvider(makeProvider("a"), { ownerPluginId: "plugin-a" });
    registerCompactionProvider(makeProvider("b"));

    const entries = listRegisteredCompactionProviders();
    expect(entries).toHaveLength(2);
    expect(entries[0]?.provider.id).toBe("a");
    expect(entries[0]?.ownerPluginId).toBe("plugin-a");
    expect(entries[1]?.provider.id).toBe("b");
    expect(entries[1]?.ownerPluginId).toBeUndefined();
  });

  it("supports multiple providers", () => {
    registerCompactionProvider(makeProvider("a"));
    registerCompactionProvider(makeProvider("b"));
    registerCompactionProvider(makeProvider("c"));

    expect(getCompactionProvider("a")?.id).toBe("a");
    expect(getCompactionProvider("b")?.id).toBe("b");
    expect(getCompactionProvider("c")?.id).toBe("c");
    expect(listCompactionProviderIds()).toHaveLength(3);
  });

  it("calls summarize and returns expected result", async () => {
    registerCompactionProvider(makeProvider("my-compactor"));

    const provider = requireCompactionProvider("my-compactor");
    const result = await provider.summarize({ messages: [] });

    expect(result).toBe("summary-from-my-compactor");
  });

  it("overwrites when re-registering the same id", () => {
    const first = makeProvider("dup", "first-label");
    const second = makeProvider("dup", "second-label");

    registerCompactionProvider(first);
    registerCompactionProvider(second);

    expect(getCompactionProvider("dup")).toBe(second);
    expect(getCompactionProvider("dup")?.label).toBe("second-label");
    expect(listCompactionProviderIds()).toEqual(["dup"]);
  });

  describe("lifecycle (clear / restore)", () => {
    it("clear removes all providers", () => {
      registerCompactionProvider(makeProvider("a"));
      registerCompactionProvider(makeProvider("b"));
      expect(listCompactionProviderIds()).toHaveLength(2);

      clearCompactionProviders();
      expect(listCompactionProviderIds()).toStrictEqual([]);
      expect(getCompactionProvider("a")).toBeUndefined();
    });

    it("restore replaces current entries with snapshot", () => {
      const provA = makeProvider("a");
      const provB = makeProvider("b");
      registerCompactionProvider(provA, { ownerPluginId: "p-a" });
      registerCompactionProvider(provB, { ownerPluginId: "p-b" });

      const snapshot = listRegisteredCompactionProviders();

      // Register a third provider to change state
      registerCompactionProvider(makeProvider("c"));
      expect(listCompactionProviderIds()).toHaveLength(3);

      // Restore from snapshot — should have only a and b
      restoreRegisteredCompactionProviders(snapshot);
      expect(listCompactionProviderIds()).toEqual(["a", "b"]);
      expect(getCompactionProvider("c")).toBeUndefined();
      expect(getRegisteredCompactionProvider("a")?.ownerPluginId).toBe("p-a");
    });

    it("restore with empty array clears everything", () => {
      registerCompactionProvider(makeProvider("x"));
      restoreRegisteredCompactionProviders([]);
      expect(listCompactionProviderIds()).toStrictEqual([]);
    });
  });
});
