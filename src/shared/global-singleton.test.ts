// Global singleton tests cover process-wide singleton creation and reset behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  drainGlobalSingletonLifecycleState,
  resolveGlobalMap,
  resolveGlobalSingleton,
} from "./global-singleton.js";

const TEST_KEY = Symbol("global-singleton:test");
const TEST_MAP_KEY = Symbol("global-singleton:test-map");

afterEach(() => {
  delete (globalThis as Record<PropertyKey, unknown>)[TEST_KEY];
  delete (globalThis as Record<PropertyKey, unknown>)[TEST_MAP_KEY];
});

describe("resolveGlobalSingleton", () => {
  it("reuses an initialized singleton", () => {
    const create = vi.fn(() => ({ value: 1 }));

    const first = resolveGlobalSingleton(TEST_KEY, create);
    const second = resolveGlobalSingleton(TEST_KEY, create);

    expect(first).toBe(second);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("does not re-run the factory when undefined was already stored", () => {
    const create = vi.fn(() => undefined);

    expect(resolveGlobalSingleton(TEST_KEY, create)).toBeUndefined();
    expect(resolveGlobalSingleton(TEST_KEY, create)).toBeUndefined();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("reuses a prepopulated global value without calling the factory", () => {
    const existing = { value: 7 };
    const create = vi.fn(() => ({ value: 1 }));
    (globalThis as Record<PropertyKey, unknown>)[TEST_KEY] = existing;

    expect(resolveGlobalSingleton(TEST_KEY, create)).toBe(existing);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("resolveGlobalMap", () => {
  it("reuses the same map instance", () => {
    const first = resolveGlobalMap<string, number>(TEST_MAP_KEY);
    const second = resolveGlobalMap<string, number>(TEST_MAP_KEY);

    expect(first).toBe(second);
  });

  it("preserves existing map contents across repeated resolution", () => {
    const map = resolveGlobalMap<string, number>(TEST_MAP_KEY);
    map.set("a", 1);

    expect(resolveGlobalMap<string, number>(TEST_MAP_KEY).get("a")).toBe(1);
  });

  it("reuses a prepopulated global map without creating a new one", () => {
    const existing = new Map<string, number>([["a", 1]]);
    (globalThis as Record<PropertyKey, unknown>)[TEST_MAP_KEY] = existing;

    const resolved = resolveGlobalMap<string, number>(TEST_MAP_KEY);

    expect(resolved).toBe(existing);
    expect(resolved.get("a")).toBe(1);
  });
});

describe("global singleton lifecycle resets", () => {
  it("registers an in-place reset for a prepopulated singleton", async () => {
    const existing = { values: new Set(["stale"]) };
    (globalThis as Record<PropertyKey, unknown>)[TEST_KEY] = existing;
    const resolved = resolveGlobalSingleton(
      TEST_KEY,
      () => ({ values: new Set<string>() }),
      (state) => state.values.clear(),
    );

    await drainGlobalSingletonLifecycleState();

    expect(resolved).toBe(existing);
    expect(existing.values.size).toBe(0);
  });

  it("keeps map resets registered across repeated lifecycle drains", async () => {
    const map = resolveGlobalMap<string, number>(TEST_MAP_KEY, (state) => state.clear());
    map.set("first", 1);
    await drainGlobalSingletonLifecycleState();
    map.set("second", 2);
    await drainGlobalSingletonLifecycleState();

    expect(map.size).toBe(0);
    expect(resolveGlobalMap<string, number>(TEST_MAP_KEY)).toBe(map);
  });

  it("keeps only the latest reset owner for a duplicated slot", async () => {
    const duplicateKey = Symbol("global-singleton:duplicate-owner");
    const firstReset = vi.fn();
    const secondReset = vi.fn();
    resolveGlobalSingleton(duplicateKey, () => ({}), firstReset);
    resolveGlobalSingleton(duplicateKey, () => ({}), secondReset);

    await drainGlobalSingletonLifecycleState();

    expect(firstReset).not.toHaveBeenCalled();
    expect(secondReset).toHaveBeenCalledOnce();
    delete (globalThis as Record<PropertyKey, unknown>)[duplicateKey];
  });

  it("awaits asynchronous resets while starting sibling owners", async () => {
    const asyncKey = Symbol("global-singleton:async-reset");
    const siblingKey = Symbol("global-singleton:async-sibling");
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const siblingReset = vi.fn();
    resolveGlobalSingleton(
      asyncKey,
      () => ({}),
      async () => await held,
    );
    resolveGlobalSingleton(siblingKey, () => ({}), siblingReset);

    const drain = drainGlobalSingletonLifecycleState();
    expect(siblingReset).toHaveBeenCalledOnce();
    release();
    await drain;

    delete (globalThis as Record<PropertyKey, unknown>)[asyncKey];
    delete (globalThis as Record<PropertyKey, unknown>)[siblingKey];
  });

  it("runs every registered reset before reporting failures", async () => {
    const failingKey = Symbol("global-singleton:failing-reset");
    const succeedingKey = Symbol("global-singleton:succeeding-reset");
    let shouldThrow = true;
    const succeedingReset = vi.fn();
    resolveGlobalSingleton(
      failingKey,
      () => ({}),
      () => {
        if (shouldThrow) {
          throw new Error("reset failed");
        }
      },
    );
    resolveGlobalSingleton(succeedingKey, () => ({}), succeedingReset);

    await expect(drainGlobalSingletonLifecycleState()).rejects.toThrow(AggregateError);
    shouldThrow = false;
    expect(succeedingReset).toHaveBeenCalledOnce();

    delete (globalThis as Record<PropertyKey, unknown>)[failingKey];
    delete (globalThis as Record<PropertyKey, unknown>)[succeedingKey];
  });

  it("preserves close-only state across restart drains", async () => {
    const closeOnlyKey = Symbol("global-singleton:close-only");
    const state = resolveGlobalMap<string, number>(
      closeOnlyKey,
      (value) => value.clear(),
      "close-only",
    );
    state.set("pending", 1);

    await drainGlobalSingletonLifecycleState("restart");
    expect(state.get("pending")).toBe(1);

    await drainGlobalSingletonLifecycleState("close");
    expect(state.size).toBe(0);
    delete (globalThis as Record<PropertyKey, unknown>)[closeOnlyKey];
  });
});
