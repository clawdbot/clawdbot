// Regression coverage for the memory_search/memory_get tool boundary's
// dreaming-state wiring. See getMemoryManagerContextWithPurpose in
// tools.shared.ts: this lazy-module boundary reaches getMemorySearchManager()
// through a different path than createMemoryRuntime() (runtime-provider.ts),
// so it never inherited that boundary's configureMemoryCoreDreamingState()
// call. Every real agent-session sync (watch/session-delta/
// session-startup-catchup) that needed the dreaming state store threw
// "memory-core dreaming SQLite state store is not configured" even though
// the plugin's register() had already configured a different boundary.
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryCoreOpenKeyedStore } from "./dreaming-state.js";
import { openMemoryCoreStateStore } from "./dreaming-state.js";
import { resetMemoryCoreDreamingStateForTests } from "./test-helpers.js";

vi.mock("./tools.runtime.js", () => ({
  getMemorySearchManager: vi.fn(async () => ({ manager: undefined, error: "not needed here" })),
}));

const { getMemoryManagerContextWithPurpose } = await import("./tools.shared.js");

function createFakeOpenKeyedStore(): MemoryCoreOpenKeyedStore {
  return vi.fn((_options: OpenKeyedStoreOptions) => ({
    register: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
    close: vi.fn(),
  })) as unknown as MemoryCoreOpenKeyedStore;
}

describe("getMemoryManagerContextWithPurpose dreaming-state wiring", () => {
  beforeEach(() => {
    resetMemoryCoreDreamingStateForTests();
  });

  it("openMemoryCoreStateStore throws when nothing configured it (baseline)", () => {
    expect(() => openMemoryCoreStateStore({ namespace: "test", maxEntries: 1 })).toThrow(
      "memory-core dreaming SQLite state store is not configured",
    );
  });

  it("re-configures the dreaming state store from params.openKeyedStore before resolving the manager", async () => {
    const openKeyedStore = createFakeOpenKeyedStore();

    await getMemoryManagerContextWithPurpose({
      cfg: {} as never,
      agentId: "main",
      openKeyedStore,
    });

    const options: OpenKeyedStoreOptions = { namespace: "test", maxEntries: 1 };
    expect(() => openMemoryCoreStateStore(options)).not.toThrow();
    expect(openKeyedStore).toHaveBeenCalledWith(options);
  });

  it("still throws when openKeyedStore is omitted (no boundary configured it)", async () => {
    await getMemoryManagerContextWithPurpose({
      cfg: {} as never,
      agentId: "main",
    });

    expect(() => openMemoryCoreStateStore({ namespace: "test", maxEntries: 1 })).toThrow(
      "memory-core dreaming SQLite state store is not configured",
    );
  });
});
