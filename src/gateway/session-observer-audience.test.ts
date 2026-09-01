import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHarness,
  event,
  flushObserver,
  resetSessionObserverEventSequence,
  startAndAddToolNotes,
} from "./session-observer.test-utils.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetSessionObserverEventSequence();
});

describe("session observer audience", () => {
  it("reserves utility-model digests for directly watched sessions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const sessionListOnly = createHarness({ subscribe: false, broadSubscribe: true });
    const directlyWatched = createHarness({ broadSubscribe: true });

    startAndAddToolNotes(sessionListOnly.observer);
    startAndAddToolNotes(directlyWatched.observer);
    sessionListOnly.observer.handleEvent(
      event({
        stream: "item",
        data: {
          kind: "preamble",
          phase: "update",
          progressText: "Preparing the next session",
        },
      }),
    );

    expect(sessionListOnly.broadcastToConnIds).toHaveBeenCalledWith(
      "session.observer",
      expect.objectContaining({ headline: "Preparing the next session" }),
      new Set(["conn-1"]),
      expect.objectContaining({ dropIfSlow: true }),
    );

    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();

    expect(sessionListOnly.prepareModel).not.toHaveBeenCalled();
    expect(sessionListOnly.completeModel).not.toHaveBeenCalled();
    expect(directlyWatched.prepareModel).toHaveBeenCalledOnce();
    expect(directlyWatched.completeModel).toHaveBeenCalledOnce();

    sessionListOnly.observer.dispose();
    directlyWatched.observer.dispose();
  });

  it("stops model work when only the broad session-list audience remains", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const harness = createHarness({ broadSubscribe: true });
    startAndAddToolNotes(harness.observer);

    harness.subscribers.unsubscribe("conn-1", "agent:main:session-1");
    await vi.advanceTimersByTimeAsync(12_000);

    expect(harness.prepareModel).not.toHaveBeenCalled();
    expect(harness.completeModel).not.toHaveBeenCalled();

    harness.observer.handleEvent(
      event({
        stream: "item",
        data: { kind: "preamble", phase: "update", progressText: "Still visible in the list" },
      }),
    );

    expect(harness.broadcastToConnIds).toHaveBeenCalledWith(
      "session.observer",
      expect.objectContaining({ headline: "Still visible in the list" }),
      new Set(["conn-1"]),
      expect.objectContaining({ dropIfSlow: true }),
    );
    harness.observer.dispose();
  });
});
