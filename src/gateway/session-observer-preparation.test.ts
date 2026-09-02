import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHarness,
  flushObserver,
  preparedModel,
  resetSessionObserverEventSequence,
  startAndAddToolNotes,
} from "./session-observer.test-utils.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetSessionObserverEventSequence();
});

describe("session observer model preparation", () => {
  it("does not start completion after observation ends during model preparation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let resolvePreparation: ((value: ReturnType<typeof preparedModel>) => void) | undefined;
    const prepareModel = vi.fn(
      () =>
        new Promise<ReturnType<typeof preparedModel>>((resolve) => {
          resolvePreparation = resolve;
        }),
    );
    const harness = createHarness({ prepareModel });
    startAndAddToolNotes(harness.observer);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(prepareModel).toHaveBeenCalledOnce();

    harness.subscribers.unsubscribe("conn-1", "agent:main:session-1");
    resolvePreparation?.(preparedModel());
    await flushObserver();

    expect(harness.completeModel).not.toHaveBeenCalled();
    harness.observer.dispose();
  });

  it("times out stalled model preparation without starting another preparation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const prepareModel = vi.fn(
      () =>
        new Promise<never>(() => {
          // Intentionally unresolved: the observer timeout owns this test path.
        }),
    );
    const harness = createHarness({ prepareModel });
    startAndAddToolNotes(harness.observer);

    await vi.advanceTimersByTimeAsync(34_000);
    await flushObserver();

    expect(prepareModel).toHaveBeenCalledOnce();
    expect(harness.completeModel).not.toHaveBeenCalled();
    harness.observer.dispose();
  });

  it.each([
    {
      failure: "a rejected promise",
      firstPreparation: () => Promise.reject(new Error("temporary preparation failure")),
    },
    {
      failure: "a resolved error",
      firstPreparation: async () => ({ error: "temporary preparation failure" }),
    },
  ])("retries after $failure", async ({ firstPreparation }) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const prepareModel = vi
      .fn()
      .mockImplementationOnce(firstPreparation)
      .mockResolvedValue(preparedModel());
    const harness = createHarness({ prepareModel });
    startAndAddToolNotes(harness.observer);

    await vi.advanceTimersByTimeAsync(24_000);
    await flushObserver();

    expect(prepareModel).toHaveBeenCalledTimes(2);
    expect(harness.completeModel).toHaveBeenCalledOnce();
    expect(harness.broadcastToConnIds).toHaveBeenCalledOnce();
    harness.observer.dispose();
  });
});
