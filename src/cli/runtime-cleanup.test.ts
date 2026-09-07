import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentHarness } from "../agents/harness/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeCliResources, getPendingCliDisposers } from "./runtime-cleanup.js";

const memoryClosed = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../agents/harness/registry.js", () => ({
  listRegisteredAgentHarnesses: () => [],
}));
vi.mock("../plugins/registry-lifecycle.js", () => ({ markPluginRegistryRetired() {} }));
vi.mock("../agents/provider-runtime-lifecycle.js", () => ({
  hasManagedProviderLocalServices: () => false,
  hasProviderTransportDispatcherPool: () => false,
}));
vi.mock("../gateway/mcp-http.loopback-runtime.js", () => ({
  getActiveMcpLoopbackRuntime: () => undefined,
}));
vi.mock("../plugins/memory-state.js", () => ({ hasMemoryRuntime: () => true }));
vi.mock("../plugins/memory-runtime.js", () => ({
  closeActiveMemorySearchManagersCore: memoryClosed,
}));

beforeEach(() => {
  vi.useFakeTimers();
  memoryClosed.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("continues later cleanup when a harness disposer never settles", async () => {
  const gate = createDeferredCore();
  const entered = createDeferredCore();
  const dispose = async () => {
    entered.resolve();
    await gate.promise;
  };
  const harness: AgentHarness = {
    id: "stalled-fixture",
    label: "Stalled fixture",
    supports: () => ({ supported: true }),
    runAttempt: async () => {
      throw new Error("cleanup-only fixture");
    },
    dispose,
  };
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  let returned = false;
  const closing = closeCliResources({
    harnesses: new Map([[harness, dispose]]),
    registries: new Set(),
  }).then(() => {
    returned = true;
  });
  try {
    await entered.promise;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(returned).toBe(true);
    expect(memoryClosed).toHaveBeenCalledOnce();
    expect(getPendingCliDisposers()).toEqual(["agent-harness/stalled-fixture"]);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("agent-harness/stalled-fixture"));
  } finally {
    gate.resolve();
    await closing;
    await gate.promise;
  }
  expect(getPendingCliDisposers()).toEqual([]);
});
