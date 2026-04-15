import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDetachedMemorySync } from "./manager-sync-ops.js";

describe("memory manager sync failures", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
  });

  it("does not raise unhandledRejection when watch-triggered sync fails", async () => {
    const unhandled: unknown[] = [];
    const handler = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", handler);
    const syncSpy = vi
      .fn()
      .mockRejectedValueOnce(new Error("openai embeddings failed: 400 bad request"));
    setTimeout(() => {
      runDetachedMemorySync(syncSpy, "watch");
    }, 1);

    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
    await syncSpy.mock.results[0]?.value?.catch(() => undefined);

    process.off("unhandledRejection", handler);
    expect(unhandled).toHaveLength(0);
  });
});
