// Compaction-unlock redrive tests cover candidate selection and the
// per-completion orchestration of suspended subagent completions after a
// requester compaction releases its write lock.
import { describe, expect, it, vi } from "vitest";
import {
  COMPACTION_REDRIVE_WINDOW_GRACE_MS,
  redriveSuspendedSubagentCompletions,
  selectRedriveCandidates,
} from "./subagent-completion-redrive.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const REQUESTER = "agent:main:main";
// Fixed clock so lock-window boundary assertions are exact and deterministic.
const NOW = 5_000_000_000;
const LOCK_WINDOW = { heldFrom: NOW - 5_000, releasedAt: NOW };

function makeEntry(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId: "run-1",
    childSessionKey: "agent:main:subagent:child",
    requesterSessionKey: REQUESTER,
    requesterDisplayKey: "main",
    task: "test",
    cleanup: "keep",
    createdAt: NOW - 10_000,
    execution: { status: "terminal", endedAt: NOW - 8_000 },
    expectsCompletionMessage: true,
    completion: { required: true, resultText: "canonical result" },
    delivery: {
      status: "suspended",
      suspendedAt: NOW - 1_000,
      suspendedReason: "expiry",
      attemptCount: 3,
      lastError: "session file locked",
    },
    ...overrides,
  };
}

describe("selectRedriveCandidates", () => {
  it("selects an expiry suspension for the requester inside the lock window", () => {
    const entry = makeEntry();
    const candidates = selectRedriveCandidates(
      new Map([[entry.runId, entry]]),
      REQUESTER,
      LOCK_WINDOW,
    );
    expect(candidates).toEqual([entry]);
  });

  it("rejects a run owned by another requester session", () => {
    const entry = makeEntry({ requesterSessionKey: "agent:main:other" });
    expect(
      selectRedriveCandidates(new Map([[entry.runId, entry]]), REQUESTER, LOCK_WINDOW),
    ).toEqual([]);
  });

  it("rejects runs that do not require a completion message", () => {
    const entry = makeEntry({ expectsCompletionMessage: false });
    expect(
      selectRedriveCandidates(new Map([[entry.runId, entry]]), REQUESTER, LOCK_WINDOW),
    ).toEqual([]);
  });

  it("rejects runs whose delivery is not suspended", () => {
    const entry = makeEntry({ delivery: { status: "pending" } });
    expect(
      selectRedriveCandidates(new Map([[entry.runId, entry]]), REQUESTER, LOCK_WINDOW),
    ).toEqual([]);
  });

  it("rejects permanent-failure suspensions that must not be redriven", () => {
    const entry = makeEntry({
      delivery: {
        status: "suspended",
        suspendedAt: NOW - 1_000,
        suspendedReason: "permanent_failure",
      },
    });
    expect(
      selectRedriveCandidates(new Map([[entry.runId, entry]]), REQUESTER, LOCK_WINDOW),
    ).toEqual([]);
  });

  it("rejects the never-written retry-limit suspension value", () => {
    const entry = makeEntry({
      delivery: {
        status: "suspended",
        suspendedAt: NOW - 1_000,
        suspendedReason: "retry-limit",
      },
    });
    expect(
      selectRedriveCandidates(new Map([[entry.runId, entry]]), REQUESTER, LOCK_WINDOW),
    ).toEqual([]);
  });

  it("rejects suspended runs with no deliverable frozen result", () => {
    const entry = makeEntry({ completion: undefined });
    expect(
      selectRedriveCandidates(new Map([[entry.runId, entry]]), REQUESTER, LOCK_WINDOW),
    ).toEqual([]);
  });

  it("rejects a suspension stamped before the compaction held the lock", () => {
    const entry = makeEntry({
      delivery: {
        status: "suspended",
        suspendedAt: NOW - 20_000,
        suspendedReason: "expiry",
      },
    });
    expect(
      selectRedriveCandidates(new Map([[entry.runId, entry]]), REQUESTER, LOCK_WINDOW),
    ).toEqual([]);
  });

  it("rejects a suspension stamped after the lock-release grace window", () => {
    const entry = makeEntry({
      delivery: {
        status: "suspended",
        suspendedAt: NOW + COMPACTION_REDRIVE_WINDOW_GRACE_MS + 1_000,
        suspendedReason: "expiry",
      },
    });
    expect(
      selectRedriveCandidates(new Map([[entry.runId, entry]]), REQUESTER, LOCK_WINDOW),
    ).toEqual([]);
  });

  it("includes an expiry suspension with a frozen fallback result", () => {
    const entry = makeEntry({
      completion: { required: true, fallbackResultText: "payload result" },
      delivery: {
        status: "suspended",
        suspendedAt: NOW - 1_000,
        suspendedReason: "expiry",
        payload: {
          requesterSessionKey: REQUESTER,
          requesterDisplayKey: "main",
          childSessionKey: "agent:main:subagent:child",
          childRunId: "run-1",
          task: "test",
        },
      },
    });
    expect(
      selectRedriveCandidates(new Map([[entry.runId, entry]]), REQUESTER, LOCK_WINDOW),
    ).toEqual([entry]);
  });
});

describe("redriveSuspendedSubagentCompletions", () => {
  it("redrives every matching candidate through the shared retry path", async () => {
    const entry = makeEntry();
    const retriedTaskIds: string[] = [];
    const retryDelivery = async (runId: string) => {
      retriedTaskIds.push(runId);
      return { ok: true };
    };
    const result = await redriveSuspendedSubagentCompletions(
      REQUESTER,
      {
        runs: new Map([[entry.runId, entry]]),
        retryDelivery,
      },
      LOCK_WINDOW,
    );

    expect(retriedTaskIds).toEqual(["run-1"]);
    expect(result).toEqual({ matched: 1, redriven: 1 });
  });

  it("uses the task run id when it differs from the run id", async () => {
    const entry = makeEntry({ taskRunId: "task-1" });
    const retriedTaskIds: string[] = [];
    const retryDelivery = async (runId: string) => {
      retriedTaskIds.push(runId);
      return { ok: true };
    };
    await redriveSuspendedSubagentCompletions(
      REQUESTER,
      {
        runs: new Map([[entry.runId, entry]]),
        retryDelivery,
      },
      LOCK_WINDOW,
    );

    expect(retriedTaskIds).toEqual(["task-1"]);
  });

  it("skips candidates suspended outside the lock window", async () => {
    const entry = makeEntry({
      delivery: {
        status: "suspended",
        suspendedAt: NOW - 20_000,
        suspendedReason: "expiry",
      },
    });
    const retryDelivery = vi.fn(async (_runId: string) => ({ ok: true }));
    const result = await redriveSuspendedSubagentCompletions(
      REQUESTER,
      {
        runs: new Map([[entry.runId, entry]]),
        retryDelivery,
      },
      LOCK_WINDOW,
    );

    expect(retryDelivery).not.toHaveBeenCalled();
    expect(result).toEqual({ matched: 0, redriven: 0 });
  });

  it("counts only deliveries the retry path accepted", async () => {
    const entry = makeEntry();
    const result = await redriveSuspendedSubagentCompletions(
      REQUESTER,
      {
        runs: new Map([[entry.runId, entry]]),
        retryDelivery: async () => ({ ok: false, reason: "no recoverable task" }),
      },
      LOCK_WINDOW,
    );

    expect(result).toEqual({ matched: 1, redriven: 0 });
  });

  it("is a no-op for an empty requester key", async () => {
    const entry = makeEntry();
    let retried = false;
    const retryDelivery = async (_runId: string) => {
      retried = true;
      return { ok: true };
    };
    const result = await redriveSuspendedSubagentCompletions(
      "  ",
      {
        runs: new Map([[entry.runId, entry]]),
        retryDelivery,
      },
      LOCK_WINDOW,
    );

    expect(retried).toBe(false);
    expect(result).toEqual({ matched: 0, redriven: 0 });
  });
});
