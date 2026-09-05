import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateRunRecord } from "../infra/update-run-record.js";
import { startUpdateRunWatcher, wakeUpdateRunWatcher } from "./update-run-watcher.js";

const ledger = vi.hoisted(() => ({
  run: undefined as
    | Pick<UpdateRunRecord, "runId" | "phase" | "status" | "updatedAtMs" | "steps">
    | undefined,
  reads: vi.fn(),
  notice: vi.fn(async (_run: UpdateRunRecord) => {}),
}));
vi.mock("./update-run-notice.runtime.js", () => ({ notifyUpdateRunPhase: ledger.notice }));
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
  ledger.notice.mockClear();
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
    steps: [],
  };
}

function currentRunEvent() {
  const { runId, phase, status, updatedAtMs } = ledger.run!;
  return { runId, phase, status, updatedAtMs };
}

describe("Gateway update run watcher", () => {
  it("notifies only activating and terminal phase changes, not detail revisions", async () => {
    beginRun();
    ledger.run!.steps = [{ step: "notice:ack", status: "completed" }];
    watcher = startUpdateRunWatcher({ broadcast: vi.fn(), log: { warn: vi.fn() } });
    ledger.run = { ...ledger.run!, phase: "activating", updatedAtMs: 2 };
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ledger.notice).toHaveBeenCalledOnce();
    ledger.run = { ...ledger.run!, updatedAtMs: 3 };
    await vi.advanceTimersByTimeAsync(4_000);
    expect(ledger.notice).toHaveBeenCalledOnce();
    ledger.run = { ...ledger.run!, phase: "finished", status: "succeeded", updatedAtMs: 4 };
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ledger.notice.mock.calls.map(([run]) => run.phase)).toEqual(["activating", "finished"]);
  });

  it("leaves pre-acknowledgement refusal reporting to the command", async () => {
    beginRun();
    const broadcast = vi.fn();
    watcher = startUpdateRunWatcher({ broadcast, log: { warn: vi.fn() } });
    ledger.run = { ...ledger.run!, phase: "finished", status: "failed", updatedAtMs: 2 };
    await vi.advanceTimersByTimeAsync(2_000);
    expect(broadcast).toHaveBeenLastCalledWith("update.run.changed", {
      runId: ledger.run.runId,
      phase: "finished",
      status: "failed",
      updatedAtMs: 2,
    });
    expect(ledger.notice).not.toHaveBeenCalled();
  });
  it("wakes for admission, broadcasts changed rows, and stops polling after the terminal event", () => {
    const broadcast = vi.fn();
    watcher = startUpdateRunWatcher({ broadcast, log: { warn: vi.fn() } });
    vi.advanceTimersByTime(10_000);
    expect(ledger.reads).toHaveBeenCalledOnce();
    expect(broadcast).not.toHaveBeenCalled();

    beginRun();
    wakeUpdateRunWatcher();
    expect(broadcast).toHaveBeenLastCalledWith("update.run.changed", currentRunEvent());
    vi.advanceTimersByTime(2_000);
    expect(broadcast).toHaveBeenCalledOnce();
    ledger.run = { ...ledger.run!, phase: "staging", updatedAtMs: 2 };
    vi.advanceTimersByTime(2_000);
    expect(broadcast).toHaveBeenLastCalledWith("update.run.changed", currentRunEvent());
    ledger.run = { ...ledger.run!, phase: "finished", status: "succeeded", updatedAtMs: 3 };
    vi.advanceTimersByTime(2_000);
    expect(broadcast).toHaveBeenLastCalledWith("update.run.changed", currentRunEvent());
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
