import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, expect, it, vi } from "vitest";
import { attemptMemoryCorpus, runMemoryCorpusDeadline } from "./memory-corpus.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each(["timer", "event-loop"] as const)(
  "retains completed results when the %s reaches the corpus deadline",
  async (clock) => {
    vi.useFakeTimers();
    const pending = createDeferred<string[]>();
    const partial = ["permitted keyword match"];
    const startedAt = performance.now();
    let signal: AbortSignal | undefined;
    const result = runMemoryCorpusDeadline({
      operation: "memory_search",
      run: async (currentSignal) => {
        signal = currentSignal;
        return await attemptMemoryCorpus({
          corpus: "memory",
          signal: currentSignal,
          unavailableValue: [],
          getPartialValue: () => partial,
          run: () => pending.promise,
        });
      },
    });
    if (clock === "timer") {
      await vi.advanceTimersByTimeAsync(15_000);
    } else {
      vi.spyOn(performance, "now").mockReturnValue(startedAt + 15_001);
      pending.resolve(["late semantic result"]);
    }
    expect(await result).toMatchObject({
      outcome: "partial",
      value: partial,
      deadline: true,
      error: "memory_search timed out after 15s",
    });
    expect(signal?.aborted).toBe(true);
    pending.resolve([]);
  },
);

it.each(["provider", "caller"] as const)(
  "does not replace a %s failure with partial results",
  async (source) => {
    const parent = new AbortController();
    const failure = new Error("memory_search timed out after 15s");
    const result = runMemoryCorpusDeadline({
      operation: "memory_search",
      parentSignal: parent.signal,
      run: async (signal) =>
        await attemptMemoryCorpus({
          corpus: "memory",
          signal,
          unavailableValue: [],
          getPartialValue: () => ["keyword match"],
          run: async () => {
            if (source === "caller") {
              parent.abort(failure);
            }
            throw failure;
          },
        }),
    });
    if (source === "caller") {
      await expect(result).rejects.toBe(failure);
    } else {
      expect(await result).toMatchObject({ outcome: "unavailable", value: [], deadline: false });
    }
  },
);
