// The announce dispatch waits for requester lane admission and then for the
// announce turn. These cover that the two failures stay distinguishable, which
// one shared `announceTimeoutMs` could not express.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  runAnnounceDeliveryWithRetry,
  resolveSubagentAnnounceAdmissionTimeoutMs,
  resolveSubagentAnnounceRunTimeoutMs,
  resolveSubagentAnnounceTimeoutMs,
  resolveSubagentAnnounceWholeCallTimeoutMs,
} from "./subagent-announce-delivery-retry.js";
import { runWithAnnounceSplitDeadlines } from "./subagent-announce-split-deadline.js";

const ANNOUNCE_RUN_ID = "announce:v1:agent:tank:subagent:child-session:child-run";

function configWithSubagents(subagents: Record<string, number>): OpenClawConfig {
  return { agents: { defaults: { subagents } } } as OpenClawConfig;
}

function rejectsWhenAborted(_timeoutMs: number, signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const onAbort = () =>
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error(String(signal.reason ?? "announce aborted")),
      );
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  });
}

function createAbortableRun() {
  let markWorkLaneAdmitted: (() => void) | undefined;
  return {
    run: (timeoutMs: number, signal: AbortSignal, onWorkLaneAdmitted: () => void) => {
      markWorkLaneAdmitted = onWorkLaneAdmitted;
      return rejectsWhenAborted(timeoutMs, signal);
    },
    admit: () => {
      if (!markWorkLaneAdmitted) {
        throw new Error("announce dispatch did not publish its work-lane admission callback");
      }
      markWorkLaneAdmitted();
    },
  };
}

describe("announce phase timeout resolution", () => {
  it("defaults admission short and the run budget generous", () => {
    const cfg = {} as OpenClawConfig;

    expect(resolveSubagentAnnounceAdmissionTimeoutMs(cfg)).toBe(30_000);
    expect(resolveSubagentAnnounceRunTimeoutMs(cfg)).toBe(900_000);
    expect(resolveSubagentAnnounceTimeoutMs(cfg)).toBe(120_000);
  });

  it("keeps a pinned legacy announceTimeoutMs governing both phases", () => {
    const cfg = configWithSubagents({ announceTimeoutMs: 45_000 });

    expect(resolveSubagentAnnounceAdmissionTimeoutMs(cfg)).toBe(45_000);
    expect(resolveSubagentAnnounceRunTimeoutMs(cfg)).toBe(45_000);
    expect(resolveSubagentAnnounceWholeCallTimeoutMs(cfg)).toBe(45_000);
  });

  it("does not impose the legacy whole-call cap when it is unset", () => {
    expect(resolveSubagentAnnounceWholeCallTimeoutMs({} as OpenClawConfig)).toBeUndefined();
  });

  it("preserves a pinned legacy announceTimeoutMs as the whole-call cap", async () => {
    vi.useFakeTimers();
    try {
      const abortable = createAbortableRun();
      const result = runWithAnnounceSplitDeadlines({
        runId: ANNOUNCE_RUN_ID,
        admissionTimeoutMs: 45,
        runTimeoutMs: 45,
        wholeCallTimeoutMs: 45,
        run: abortable.run,
      }).catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(30);
      abortable.admit();
      await vi.advanceTimersByTimeAsync(14);
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toMatchObject({ name: "AnnounceWholeCallTimeoutError" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets each phase-specific key override the legacy budget independently", () => {
    const cfg = configWithSubagents({
      announceTimeoutMs: 45_000,
      announceAdmissionTimeoutMs: 5_000,
      announceRunTimeoutMs: 600_000,
    });

    expect(resolveSubagentAnnounceAdmissionTimeoutMs(cfg)).toBe(5_000);
    expect(resolveSubagentAnnounceRunTimeoutMs(cfg)).toBe(600_000);
    expect(resolveSubagentAnnounceTimeoutMs(cfg)).toBe(45_000);
  });
});

describe("runWithAnnounceSplitDeadlines", () => {
  it("returns the dispatch result when it settles inside both budgets", async () => {
    const result = await runWithAnnounceSplitDeadlines({
      runId: ANNOUNCE_RUN_ID,
      admissionTimeoutMs: 30_000,
      runTimeoutMs: 900_000,
      run: async () => "delivered",
    });

    expect(result).toBe("delivered");
  });

  it("hands the dispatch a release backstop past both phase budgets", async () => {
    let dispatchTimeoutMs: number | undefined;

    await runWithAnnounceSplitDeadlines({
      runId: ANNOUNCE_RUN_ID,
      admissionTimeoutMs: 30_000,
      runTimeoutMs: 900_000,
      run: async (timeoutMs) => {
        dispatchTimeoutMs = timeoutMs;
        return "delivered";
      },
    });

    expect(dispatchTimeoutMs).toBeGreaterThan(930_000);
  });

  it("bounds the dispatch release backstop from the legacy whole-call cap", async () => {
    let dispatchTimeoutMs: number | undefined;

    await runWithAnnounceSplitDeadlines({
      runId: ANNOUNCE_RUN_ID,
      admissionTimeoutMs: 45_000,
      runTimeoutMs: 45_000,
      wholeCallTimeoutMs: 45_000,
      run: async (timeoutMs) => {
        dispatchTimeoutMs = timeoutMs;
        return "delivered";
      },
    });

    expect(dispatchTimeoutMs).toBe(75_000);
  });

  it("starts the full run budget only after admission", async () => {
    vi.useFakeTimers();
    try {
      const abortable = createAbortableRun();
      const result = runWithAnnounceSplitDeadlines({
        runId: ANNOUNCE_RUN_ID,
        admissionTimeoutMs: 50,
        runTimeoutMs: 80,
        run: abortable.run,
      }).catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(40);
      abortable.admit();
      await vi.advanceTimersByTimeAsync(79);
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toMatchObject({ name: "AnnounceRunBudgetExceededError" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails as not-admitted when the announce turn never starts", async () => {
    const call = runWithAnnounceSplitDeadlines({
      runId: ANNOUNCE_RUN_ID,
      admissionTimeoutMs: 20,
      runTimeoutMs: 900_000,
      run: rejectsWhenAborted,
    });

    await expect(call).rejects.toMatchObject({ name: "AnnounceNotAdmittedError" });
    await expect(call).rejects.toThrow(/announce not admitted \(lane busy\)/);
  });

  it("fails as run-budget-exceeded once the announce turn has started", async () => {
    const abortable = createAbortableRun();
    const call = runWithAnnounceSplitDeadlines({
      runId: ANNOUNCE_RUN_ID,
      admissionTimeoutMs: 20,
      runTimeoutMs: 80,
      run: abortable.run,
    });
    abortable.admit();

    await expect(call).rejects.toMatchObject({ name: "AnnounceRunBudgetExceededError" });
    await expect(call).rejects.toThrow(/announce run exceeded budget/);
  });

  it("propagates caller cancellation into the active dispatch", async () => {
    const caller = new AbortController();
    const reason = new Error("source delivery cancelled");
    const call = runWithAnnounceSplitDeadlines({
      runId: ANNOUNCE_RUN_ID,
      admissionTimeoutMs: 30_000,
      runTimeoutMs: 900_000,
      signal: caller.signal,
      run: rejectsWhenAborted,
    });

    caller.abort(reason);

    await expect(call).rejects.toBe(reason);
  });

  it("does not start the run budget without the facade admission callback", async () => {
    const call = runWithAnnounceSplitDeadlines({
      runId: ANNOUNCE_RUN_ID,
      admissionTimeoutMs: 40,
      runTimeoutMs: 900_000,
      run: rejectsWhenAborted,
    });

    await expect(call).rejects.toMatchObject({ name: "AnnounceNotAdmittedError" });
  });

  it("reports the two announce failures as distinct outcomes", async () => {
    const notAdmitted = runWithAnnounceSplitDeadlines({
      runId: ANNOUNCE_RUN_ID,
      admissionTimeoutMs: 20,
      runTimeoutMs: 900_000,
      run: rejectsWhenAborted,
    }).catch((err: unknown) => err);
    const admittedRunId = `${ANNOUNCE_RUN_ID}:admitted`;
    const abortable = createAbortableRun();
    const runExceeded = runWithAnnounceSplitDeadlines({
      runId: admittedRunId,
      admissionTimeoutMs: 20,
      runTimeoutMs: 80,
      run: abortable.run,
    }).catch((err: unknown) => err);
    abortable.admit();

    const [first, second] = await Promise.all([notAdmitted, runExceeded]);

    expect((first as Error).name).toBe("AnnounceNotAdmittedError");
    expect((second as Error).name).toBe("AnnounceRunBudgetExceededError");
    expect((first as Error).message).not.toBe((second as Error).message);
  });

  it.each([
    [
      "not admitted",
      () =>
        Object.assign(new Error("announce not admitted (lane busy)"), {
          name: "AnnounceNotAdmittedError",
        }),
    ],
    [
      "run budget exceeded",
      () =>
        Object.assign(new Error("announce run exceeded budget"), {
          name: "AnnounceRunBudgetExceededError",
        }),
    ],
  ])("does not retry a %s phase deadline", async (_name, createError) => {
    let attempts = 0;

    await expect(
      runAnnounceDeliveryWithRetry({
        operation: "split deadline test",
        run: async () => {
          attempts += 1;
          throw createError();
        },
      }),
    ).rejects.toBeInstanceOf(Error);

    expect(attempts).toBe(1);
  });
});
