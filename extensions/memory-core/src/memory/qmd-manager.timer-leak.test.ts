import { describe, expect, it, vi } from "vitest";
import { QmdMemoryManager } from "./qmd-manager.js";

describe("QmdMemoryManager.waitForPendingUpdateBeforeSearch timer cleanup", () => {
  it("clears the wait timeout when the pending update settles first", async () => {
    // Real instance carrying the real prototype method. The method reads only
    // this.pendingUpdate, so the instance is otherwise uninitialized; the full
    // create() factory spawns the external qmd process, which is out of scope here.
    const mgr = Object.create(QmdMemoryManager.prototype) as {
      pendingUpdate: Promise<void> | null;
      waitForPendingUpdateBeforeSearch: () => Promise<void>;
    };

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const iterations = 20;
    try {
      for (let index = 0; index < iterations; index += 1) {
        mgr.pendingUpdate = index % 2 === 0 ? Promise.resolve() : Promise.reject(new Error("done"));
        await mgr.waitForPendingUpdateBeforeSearch();
      }

      const waitTimers = setTimeoutSpy.mock.results.map((result) => result.value);
      const clearedTimers = new Set(clearTimeoutSpy.mock.calls.map(([timer]) => timer));

      expect(waitTimers).toHaveLength(iterations);
      expect(waitTimers.every((timer) => clearedTimers.has(timer))).toBe(true);
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });
});
