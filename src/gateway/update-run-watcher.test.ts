import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateRunRecord } from "../infra/update-run-record.js";
import { startUpdateRunWatcher, wakeUpdateRunWatcher } from "./update-run-watcher.js";

const ledger = vi.hoisted(() => ({
  run: undefined as Pick<UpdateRunRecord, "runId" | "phase" | "status" | "updatedAtMs"> | undefined,
  reads: vi.fn(),
}));
vi.mock("../infra/update-run-ledger.js", () => ({
  findActiveUpdateRun: () => {
    ledger.reads();
    return ledger.run?.status === "running" ? ledger.run : undefined;
  },
  getUpdateRun: () => {
    ledger.reads();
    return ledger.run;
  },
}));

let watcher: ReturnType<typeof startUpdateRunWatcher> | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  ledger.run = undefined;
  ledger.reads.mockClear();
});
afterEach(() => {
  watcher?.stop();
  watcher = undefined;
  vi.useRealTimers();
});

function beginRun() {
  ledger.run = {
    runId: "b7150827-8222-4c12-bd20-9bfd6ae8e852",
    phase: "requested",
    status: "running",
    updatedAtMs: 1,
  };
}

describe("Gateway update run watcher", () => {
  it("wakes for admission, broadcasts changed rows, and stops polling after the terminal event", () => {
    const broadcast = vi.fn();
    watcher = startUpdateRunWatcher({ broadcast, log: { warn: vi.fn() } });
    vi.advanceTimersByTime(10_000);
    expect(ledger.reads).toHaveBeenCalledOnce();
    expect(broadcast).not.toHaveBeenCalled();

    beginRun();
    wakeUpdateRunWatcher();
    expect(broadcast).toHaveBeenLastCalledWith("update.run.changed", ledger.run);
    vi.advanceTimersByTime(2_000);
    expect(broadcast).toHaveBeenCalledOnce();
    ledger.run = { ...ledger.run!, phase: "staging", updatedAtMs: 2 };
    vi.advanceTimersByTime(2_000);
    expect(broadcast).toHaveBeenLastCalledWith("update.run.changed", ledger.run);
    ledger.run = { ...ledger.run!, phase: "finished", status: "succeeded", updatedAtMs: 3 };
    vi.advanceTimersByTime(2_000);
    expect(broadcast).toHaveBeenLastCalledWith("update.run.changed", ledger.run);
    const reads = ledger.reads.mock.calls.length;
    vi.advanceTimersByTime(60_000);
    expect(ledger.reads).toHaveBeenCalledTimes(reads);
    expect(broadcast).toHaveBeenCalledTimes(3);
  });

  it.each(["teardown", "deadline"] as const)("bounds a running watcher at %s", (ending) => {
    beginRun();
    const broadcast = vi.fn();
    watcher = startUpdateRunWatcher({ broadcast, log: { warn: vi.fn() } });
    if (ending === "teardown") {
      watcher.stop();
    } else {
      vi.advanceTimersByTime(45 * 60_000);
    }
    const reads = ledger.reads.mock.calls.length;
    vi.advanceTimersByTime(60_000);
    expect(ledger.reads).toHaveBeenCalledTimes(reads);
    expect(broadcast).toHaveBeenCalledTimes(ending === "teardown" ? 1 : 2);
    if (ending === "teardown") {
      wakeUpdateRunWatcher();
      expect(ledger.reads).toHaveBeenCalledTimes(reads);
    }
  });
});
