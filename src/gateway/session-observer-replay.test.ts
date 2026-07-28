import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHarness,
  event,
  resetSessionObserverEventSequence,
} from "./session-observer.test-utils.js";

afterEach(() => {
  vi.useRealTimers();
  resetSessionObserverEventSequence();
});

function preamble(runId: string, progressText: string) {
  return event({
    runId,
    stream: "item",
    data: { kind: "preamble", progressText },
  });
}

describe("session observer preamble replay selection", () => {
  it("does not replay an older dormant run after the latest run clears its preamble", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const harness = createHarness();

    harness.observer.handleEvent(preamble("run-1", "Older progress"));
    harness.observer.handleEvent(preamble("run-2", "Latest progress"));
    harness.observer.handleEvent(preamble("run-2", ""));
    harness.observer.removeConnection("conn-1");

    expect(harness.observer.getPreambleReplay("agent:main:session-1")).toBeUndefined();
    harness.observer.dispose();
  });

  it("does not expose an older replay after the latest run terminates", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const harness = createHarness({ utilityModelRef: null });

    harness.observer.handleEvent(preamble("run-1", "Older progress"));
    harness.observer.handleEvent(preamble("run-2", "Latest progress"));
    harness.observer.handleEvent(
      event({
        runId: "run-2",
        stream: "lifecycle",
        data: { phase: "end", startedAt: 1_000, endedAt: 41_000 },
      }),
    );

    expect(harness.observer.getPreambleReplay("agent:main:session-1")).toBeUndefined();

    harness.observer.handleEvent(preamble("run-3", "New progress"));
    expect(harness.observer.getPreambleReplay("agent:main:session-1")).toEqual(
      expect.objectContaining({ runId: "run-3", progressText: "New progress" }),
    );
    harness.observer.dispose();
  });

  it("does not dormantize an older active replay after a newer unseen run terminates", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const harness = createHarness({ utilityModelRef: null });

    harness.observer.handleEvent(preamble("run-1", "Older active progress"));
    harness.observer.handleEvent(
      event({
        runId: "run-2",
        stream: "lifecycle",
        data: { phase: "end", startedAt: 2_000, endedAt: 42_000 },
      }),
    );

    harness.observer.removeConnection("conn-1");
    expect(harness.observer.getPreambleReplay("agent:main:session-1")).toBeUndefined();
    harness.observer.dispose();
  });
});
