/** Covers plugin compaction provider registration and lookup behavior. */
import { afterEach, describe, expect, it } from "vitest";
import {
  clearCompactionProviders,
  getCompactionProvider,
  getRegisteredCompactionProvider,
  listRegisteredCompactionProviders,
  registerCompactionProvider,
  type CompactionProvider,
} from "./compaction-provider.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { setActivePluginRegistry, withPluginRegistrationContext } from "./runtime.js";

afterEach(() => {
  clearCompactionProviders();
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

function listCompactionProviderIdsForTest(): string[] {
  return listRegisteredCompactionProviders().map((entry) => entry.provider.id);
}

describe("compaction provider registry", () => {
  it("starts empty", () => {
    expect(listCompactionProviderIdsForTest()).toStrictEqual([]);
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

  it("writes direct registration helpers into the synchronous builder context", () => {
    const active = createEmptyPluginRegistry();
    const building = createEmptyPluginRegistry();
    setActivePluginRegistry(active);
    const provider = makeProvider("builder-owned");

    withPluginRegistrationContext(building, "builder-plugin", () => {
      registerCompactionProvider(provider);
    });

    expect(active.compactionProviders).toStrictEqual([]);
    expect(building.compactionProviders).toEqual([{ provider, ownerPluginId: "builder-plugin" }]);
  });

  it("does not let a registering plugin displace another owner's provider", () => {
    const building = createEmptyPluginRegistry();
    const original = makeProvider("shared", "original");
    building.compactionProviders.push({ provider: original, ownerPluginId: "first-plugin" });

    expect(() =>
      withPluginRegistrationContext(building, "failing-plugin", () => {
        registerCompactionProvider(makeProvider("shared", "replacement"));
      }),
    ).toThrow("compaction provider shared already registered by first-plugin");
    expect(building.compactionProviders).toEqual([
      { provider: original, ownerPluginId: "first-plugin" },
    ]);
  });

  it("lists registered provider ids", () => {
    registerCompactionProvider(makeProvider("alpha"));
    registerCompactionProvider(makeProvider("beta"));

    expect(listCompactionProviderIdsForTest()).toEqual(["alpha", "beta"]);
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
    expect(listCompactionProviderIdsForTest()).toHaveLength(3);
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
    expect(listCompactionProviderIdsForTest()).toEqual(["dup"]);
  });

  describe("lifecycle", () => {
    it("clear removes all providers", () => {
      registerCompactionProvider(makeProvider("a"));
      registerCompactionProvider(makeProvider("b"));
      expect(listCompactionProviderIdsForTest()).toHaveLength(2);

      clearCompactionProviders();
      expect(listCompactionProviderIdsForTest()).toStrictEqual([]);
      expect(getCompactionProvider("a")).toBeUndefined();
    });
  });
});
