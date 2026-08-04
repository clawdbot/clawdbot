// Compaction-unlock redrive tests cover candidate selection and the
// per-completion orchestration of suspended subagent completions after a
// requester compaction releases its write lock.
import { describe, expect, it } from "vitest";
import {
  redriveSuspendedSubagentCompletions,
  selectRedriveCandidates,
} from "./subagent-completion-redrive.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const REQUESTER = "agent:main:main";

function makeEntry(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId: "run-1",
    childSessionKey: "agent:main:subagent:child",
    requesterSessionKey: REQUESTER,
    requesterDisplayKey: "main",
    task: "test",
    cleanup: "keep",
    createdAt: 0,
    execution: { status: "terminal", endedAt: 1_000 },
    expectsCompletionMessage: true,
    completion: { required: true, resultText: "canonical result" },
    delivery: {
      status: "suspended",
      suspendedAt: 2_000,
      suspendedReason: "retry-limit",
      attemptCount: 3,
      lastError: "session file locked",
    },
    ...overrides,
  };
}

describe("selectRedriveCandidates", () => {
  it("selects a suspended completion with a frozen result for the requester", () => {
    const entry = makeEntry();
    const candidates = selectRedriveCandidates(new Map([[entry.runId, entry]]), REQUESTER);
    expect(candidates).toEqual([entry]);
  });

  it("rejects a run owned by another requester session", () => {
    const entry = makeEntry({ requesterSessionKey: "agent:main:other" });
    expect(selectRedriveCandidates(new Map([[entry.runId, entry]]), REQUESTER)).toEqual([]);
  });

  it("rejects runs that do not require a completion message", () => {
    const entry = makeEntry({ expectsCompletionMessage: false });
    expect(selectRedriveCandidates(new Map([[entry.runId, entry]]), REQUESTER)).toEqual([]);
  });

  it("rejects runs whose delivery is not suspended", () => {
    const entry = makeEntry({ delivery: { status: "pending" } });
    expect(selectRedriveCandidates(new Map([[entry.runId, entry]]), REQUESTER)).toEqual([]);
  });

  it("rejects permanent-failure suspensions that must not be redriven", () => {
    const entry = makeEntry({
      delivery: {
        status: "suspended",
        suspendedAt: 2_000,
        suspendedReason: "permanent_failure",
      },
    });
    expect(selectRedriveCandidates(new Map([[entry.runId, entry]]), REQUESTER)).toEqual([]);
  });

  it("rejects suspended runs with no deliverable frozen result", () => {
    const entry = makeEntry({ completion: undefined });
    expect(selectRedriveCandidates(new Map([[entry.runId, entry]]), REQUESTER)).toEqual([]);
  });

  it("includes expiry-suspended completions with a frozen fallback result", () => {
    const entry = makeEntry({
      completion: { required: true, fallbackResultText: "payload result" },
      delivery: {
        status: "suspended",
        suspendedAt: 2_000,
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
    expect(selectRedriveCandidates(new Map([[entry.runId, entry]]), REQUESTER)).toEqual([entry]);
  });
});

describe("redriveSuspendedSubagentCompletions", () => {
  it("redrives every matching candidate through the shared retry path", async () => {
    const entry = makeEntry();
    const retriedTaskIds: string[] = [];
    const retryDelivery = async (taskId: string) => {
      retriedTaskIds.push(taskId);
      return { ok: true };
    };
    const result = await redriveSuspendedSubagentCompletions(REQUESTER, {
      runs: new Map([[entry.runId, entry]]),
      retryDelivery,
    });

    expect(retriedTaskIds).toEqual(["run-1"]);
    expect(result).toEqual({ matched: 1, redriven: 1 });
  });

  it("uses the task run id when it differs from the run id", async () => {
    const entry = makeEntry({ taskRunId: "task-1" });
    const retriedTaskIds: string[] = [];
    const retryDelivery = async (taskId: string) => {
      retriedTaskIds.push(taskId);
      return { ok: true };
    };
    await redriveSuspendedSubagentCompletions(REQUESTER, {
      runs: new Map([[entry.runId, entry]]),
      retryDelivery,
    });

    expect(retriedTaskIds).toEqual(["task-1"]);
  });

  it("counts only deliveries the retry path accepted", async () => {
    const entry = makeEntry();
    const result = await redriveSuspendedSubagentCompletions(REQUESTER, {
      runs: new Map([[entry.runId, entry]]),
      retryDelivery: async () => ({ ok: false, reason: "no recoverable task" }),
    });

    expect(result).toEqual({ matched: 1, redriven: 0 });
  });

  it("is a no-op for an empty requester key", async () => {
    const entry = makeEntry();
    let retried = false;
    const retryDelivery = async (_taskId: string) => {
      retried = true;
      return { ok: true };
    };
    const result = await redriveSuspendedSubagentCompletions("  ", {
      runs: new Map([[entry.runId, entry]]),
      retryDelivery,
    });

    expect(retried).toBe(false);
    expect(result).toEqual({ matched: 0, redriven: 0 });
  });
});
