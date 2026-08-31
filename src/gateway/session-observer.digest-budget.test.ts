import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHarness,
  event,
  flushObserver,
  modelMessage,
  resetSessionObserverEventSequence,
  startAndAddToolNotes,
} from "./session-observer.test-utils.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetSessionObserverEventSequence();
});

describe("session observer digest budget", () => {
  it("accepts a model digest after the preamble generation advances", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let resolveModel: ((value: ReturnType<typeof modelMessage>) => void) | undefined;
    const completeModel = vi.fn(
      () =>
        new Promise<ReturnType<typeof modelMessage>>((resolve) => {
          resolveModel = resolve;
        }),
    );
    const harness = createHarness({ completeModel });
    startAndAddToolNotes(harness.observer);
    await vi.advanceTimersByTimeAsync(11_500);
    harness.observer.handleEvent(
      event({
        stream: "item",
        data: { kind: "preamble", phase: "update", progressText: "Checking files" },
      }),
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(completeModel).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(100);
    harness.observer.handleEvent(
      event({
        stream: "item",
        data: { kind: "preamble", phase: "update", progressText: "Running focused tests" },
      }),
    );
    resolveModel?.(modelMessage({ headline: "Stale model summary", health: "on-track" }));
    await flushObserver();
    expect(harness.broadcastToConnIds.mock.calls.at(-1)?.[1]).toMatchObject({
      headline: "Stale model summary",
    });
    await vi.advanceTimersByTimeAsync(1_900);
    expect(harness.broadcastToConnIds.mock.calls.at(-1)?.[1]).toMatchObject({
      headline: "Stale model summary",
    });
    harness.observer.dispose();
  });

  it("stops live model attempts at the budget when requests are superseded", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let utilityModelRef = "openai/gpt-a";
    const completeModel = vi.fn(
      () =>
        new Promise<never>(() => {
          // Each request is superseded through the model slot before it completes.
        }),
    );
    const harness = createHarness({
      completeModel,
      resolveUtilityModelRef: vi.fn(() => utilityModelRef),
    });
    startAndAddToolNotes(harness.observer);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(completeModel).toHaveBeenCalledOnce();

    for (let attempt = 1; attempt <= 39; attempt += 1) {
      utilityModelRef = "openai/gpt-b";
      harness.observer.handleEvent(
        event({ stream: "tool", data: { phase: "start", name: "read", args: { attempt } } }),
      );
      utilityModelRef = "openai/gpt-a";
      harness.observer.handleEvent(
        event({ stream: "tool", data: { phase: "start", name: "read", args: { attempt } } }),
      );
      await flushObserver();
      if (attempt === 39) {
        break;
      }
      for (let note = 0; note < 4; note += 1) {
        harness.observer.handleEvent(
          event({
            stream: "tool",
            data: { phase: "start", name: "read", args: { attempt, note } },
          }),
        );
      }
      await vi.advanceTimersByTimeAsync(12_000);
      expect(completeModel).toHaveBeenCalledTimes(attempt + 1);
    }

    startAndAddToolNotes(harness.observer, { count: 4 });
    await vi.advanceTimersByTimeAsync(24_000);
    expect(completeModel).toHaveBeenCalledTimes(39);
    harness.observer.dispose();
  });

  it("disables model work when digest persistence reports a missing entry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const persistDigest = vi.fn(async () => null);
    const harness = createHarness({ persistDigest });
    startAndAddToolNotes(harness.observer);

    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();
    expect(harness.completeModel).toHaveBeenCalledOnce();
    expect(persistDigest).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);

    startAndAddToolNotes(harness.observer, { count: 4 });
    await vi.advanceTimersByTimeAsync(24_000);
    expect(harness.completeModel).toHaveBeenCalledOnce();
    harness.observer.dispose();
  });
});
