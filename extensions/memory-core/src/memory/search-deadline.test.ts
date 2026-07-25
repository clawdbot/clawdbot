import { afterEach, describe, expect, it, vi } from "vitest";
import { runMemorySearchWithDeadline, type MemorySearchDeadlineAction } from "./search-deadline.js";

describe("runMemorySearchWithDeadline", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears its timer and parent abort listener after success", async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const removeEventListener = vi.spyOn(parent.signal, "removeEventListener");

    await expect(
      runMemorySearchWithDeadline({
        timeoutMs: 15_000,
        parentSignal: parent.signal,
        run: async () => "done",
      }),
    ).resolves.toBe("done");

    expect(removeEventListener).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts the task with the stable deadline error and clears its timer", async () => {
    vi.useFakeTimers();
    let taskSignal: AbortSignal | undefined;
    const result = runMemorySearchWithDeadline({
      timeoutMs: 15_000,
      run: async (signal) => {
        taskSignal = signal;
        return await new Promise(() => {});
      },
    });
    const resultAssertion = expect(result).rejects.toThrow("memory_search timed out after 15s");
    await vi.advanceTimersByTimeAsync(15_000);

    await resultAssertion;
    expect(taskSignal?.aborted).toBe(true);
    expect(taskSignal?.reason).toEqual(new Error("memory_search timed out after 15s"));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves caller cancellation and removes its listener", async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const removeEventListener = vi.spyOn(parent.signal, "removeEventListener");
    const reason = new Error("agent run cancelled");
    let taskSignal: AbortSignal | undefined;
    const result = runMemorySearchWithDeadline({
      timeoutMs: 15_000,
      parentSignal: parent.signal,
      run: async (signal) => {
        taskSignal = signal;
        return await new Promise(() => {});
      },
    });
    const resultAssertion = expect(result).rejects.toBe(reason);
    await Promise.resolve();
    parent.abort(reason);

    await resultAssertion;
    expect(taskSignal?.reason).toBe(reason);
    expect(removeEventListener).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["pause", "handoff"] satisfies MemorySearchDeadlineAction[])(
    "does not allow %s to override an already-expired deadline",
    async (action) => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      let controlDeadline: ((action: MemorySearchDeadlineAction) => void) | undefined;
      const result = runMemorySearchWithDeadline({
        timeoutMs: 15_000,
        run: async (_signal, control) => {
          controlDeadline = control;
          return await new Promise(() => {});
        },
      });
      const resultAssertion = expect(result).rejects.toThrow("memory_search timed out after 15s");
      await Promise.resolve();

      // Advance wall time without running the timer callback, matching an I/O
      // continuation that reaches the transition before the timers phase.
      vi.setSystemTime(15_000);
      controlDeadline?.(action);

      await resultAssertion;
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("does not accept task success after the active deadline has expired", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let resolveTask: ((value: string) => void) | undefined;
    let taskSignal: AbortSignal | undefined;
    const result = runMemorySearchWithDeadline({
      timeoutMs: 15_000,
      run: async (signal) => {
        taskSignal = signal;
        return await new Promise<string>((resolve) => {
          resolveTask = resolve;
        });
      },
    });
    const resultAssertion = expect(result).rejects.toThrow("memory_search timed out after 15s");
    await Promise.resolve();

    // Resolve from an I/O-style continuation before the overdue timer callback
    // receives its turn; the live budget check must still make timeout win.
    vi.setSystemTime(15_000);
    resolveTask?.("late success");

    await resultAssertion;
    expect(taskSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
