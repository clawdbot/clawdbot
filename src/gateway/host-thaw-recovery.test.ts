import { describe, expect, it, vi } from "vitest";
import { createHostThawRecovery } from "./host-thaw-recovery.js";

// Mirrors the module-private threshold contract in host-thaw-recovery.ts.
const HOST_THAW_MIN_FROZEN_MS = 45_000;
import { TICK_INTERVAL_MS } from "./server-constants.js";

function createHarness() {
  let nowMs = 0;
  let admissionClosed = false;
  const deps = {
    nowMs: () => nowMs,
    restartChannels: vi.fn(async () => {}),
    refreshHealth: vi.fn(async () => {}),
    refreshPresence: vi.fn(),
    resetEventLoopHealth: vi.fn(),
    isAdmissionClosed: () => admissionClosed,
    logger: { info: vi.fn(), error: vi.fn() },
  };
  const recovery = createHostThawRecovery(deps);
  return {
    deps,
    setAdmissionClosed: (closed: boolean) => {
      admissionClosed = closed;
    },
    advance: async (gapMs: number) => {
      nowMs += gapMs;
      await recovery.tick();
    },
  };
}

function expectRecoveryCount(harness: ReturnType<typeof createHarness>, count: number) {
  expect(harness.deps.restartChannels).toHaveBeenCalledTimes(count);
  expect(harness.deps.refreshHealth).toHaveBeenCalledTimes(count);
  expect(harness.deps.refreshPresence).toHaveBeenCalledTimes(count);
  expect(harness.deps.resetEventLoopHealth).toHaveBeenCalledTimes(count);
}

describe("host thaw recovery", () => {
  it.each([
    ["normal cadence", TICK_INTERVAL_MS],
    ["one millisecond below the thaw threshold", TICK_INTERVAL_MS + HOST_THAW_MIN_FROZEN_MS - 1],
  ])("does not recover on %s", async (_label, gapMs) => {
    const harness = createHarness();

    await harness.advance(gapMs);

    expectRecoveryCount(harness, 0);
    expect(harness.deps.logger.info).not.toHaveBeenCalled();
  });

  it("recovers and reports the frozen duration at the threshold", async () => {
    const harness = createHarness();

    await harness.advance(TICK_INTERVAL_MS + HOST_THAW_MIN_FROZEN_MS);

    expectRecoveryCount(harness, 1);
    expect(harness.deps.logger.info).toHaveBeenCalledWith(
      expect.stringContaining(`frozen ~${HOST_THAW_MIN_FROZEN_MS}ms`),
    );
  });

  it("defers a detected thaw until admission reopens and recovers once", async () => {
    const harness = createHarness();
    harness.setAdmissionClosed(true);

    await harness.advance(TICK_INTERVAL_MS + HOST_THAW_MIN_FROZEN_MS);
    expectRecoveryCount(harness, 0);

    harness.setAdmissionClosed(false);
    await harness.advance(TICK_INTERVAL_MS);
    await harness.advance(TICK_INTERVAL_MS);

    expectRecoveryCount(harness, 1);
  });

  it("re-pends the full recovery when admission closes between steps", async () => {
    const harness = createHarness();
    harness.deps.resetEventLoopHealth.mockImplementationOnce(() => {
      harness.setAdmissionClosed(true);
    });

    await harness.advance(TICK_INTERVAL_MS + HOST_THAW_MIN_FROZEN_MS);

    expect(harness.deps.resetEventLoopHealth).toHaveBeenCalledTimes(1);
    expect(harness.deps.restartChannels).not.toHaveBeenCalled();
    expect(harness.deps.refreshHealth).not.toHaveBeenCalled();
    expect(harness.deps.refreshPresence).not.toHaveBeenCalled();

    harness.setAdmissionClosed(false);
    await harness.advance(TICK_INTERVAL_MS);

    expect(harness.deps.restartChannels).toHaveBeenCalledTimes(1);
    expect(harness.deps.refreshHealth).toHaveBeenCalledTimes(1);
    expect(harness.deps.refreshPresence).toHaveBeenCalledTimes(1);
    expect(harness.deps.resetEventLoopHealth).toHaveBeenCalledTimes(2);
    expect(harness.deps.logger.info).toHaveBeenCalledWith(
      "host thaw recovery deferred: gateway suspension began mid-recovery",
    );
  });

  it("recovers independently after consecutive thaws", async () => {
    const harness = createHarness();
    const thawGap = TICK_INTERVAL_MS + HOST_THAW_MIN_FROZEN_MS;

    await harness.advance(thawGap);
    await harness.advance(thawGap);

    expectRecoveryCount(harness, 2);
  });
});
