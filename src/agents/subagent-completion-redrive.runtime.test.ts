// Compaction-unlock redrive process wiring: proves the run id handed to the
// redrive is resolved to the owning TaskRecord.taskId before the shared retry
// path runs (the task registry is keyed by taskId, not run id), and that only
// suspensions inside the compaction's lock-hold window are redriven.
// `findTaskByRunId` is mocked here; its own lookup behavior is covered by the
// task-registry suite.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import { redriveSuspendedSubagentCompletionsForRequester } from "./subagent-completion-redrive.runtime.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { createSubagentRunRecord } from "./subagent-test-fixtures.test-helpers.js";

const findTaskByRunId = vi.hoisted(() => vi.fn());
const retrySubagentCompletionDelivery = vi.hoisted(() =>
  vi.fn(async (_taskId: string) => ({ ok: true })),
);

vi.mock("../tasks/runtime-internal.js", () => ({ findTaskByRunId }));
vi.mock("./subagent-completion-delivery.js", () => ({ retrySubagentCompletionDelivery }));

const REQUESTER = "agent:main:main";
// Fixed clock so lock-window boundary assertions are exact and deterministic.
const NOW = 5_000_000_000;
const LOCK_WINDOW = { heldFrom: NOW - 5_000, releasedAt: NOW };

function makeTask(runId: string, taskId: string): TaskRecord {
  return {
    taskId,
    runtime: "subagent",
    requesterSessionKey: REQUESTER,
    ownerKey: REQUESTER,
    scopeKind: "session",
    childSessionKey: "agent:main:subagent:child",
    runId,
    task: "finish the work",
    status: "succeeded",
    deliveryStatus: "session_queued",
    terminalOutcome: "succeeded",
    notifyPolicy: "done_only",
    createdAt: NOW - 10_000,
    endedAt: NOW - 8_000,
    lastEventAt: NOW - 7_000,
  };
}

function makeSuspendedEntry(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return createSubagentRunRecord({
    runId: "run-sub",
    taskRunId: "run-task",
    endedAt: NOW - 8_000,
    outcome: { status: "ok" },
    expectsCompletionMessage: true,
    completion: { required: true, resultText: "canonical result", capturedAt: NOW - 6_000 },
    delivery: {
      status: "suspended",
      suspendedAt: NOW - 1_000,
      suspendedReason: "expiry",
      attemptCount: 3,
      lastError: "session file locked",
    },
    ...overrides,
  });
}

beforeEach(() => {
  subagentRuns.clear();
  findTaskByRunId.mockReset();
  retrySubagentCompletionDelivery.mockReset();
  retrySubagentCompletionDelivery.mockResolvedValue({ ok: true });
});

describe("redriveSuspendedSubagentCompletionsForRequester", () => {
  it("resolves the owning task id before retrying delivery", async () => {
    findTaskByRunId.mockReturnValue(makeTask("run-task", "task-completion"));
    subagentRuns.set("run-sub", makeSuspendedEntry());

    const result = await redriveSuspendedSubagentCompletionsForRequester(REQUESTER, LOCK_WINDOW);

    expect(findTaskByRunId).toHaveBeenCalledWith("run-task");
    expect(retrySubagentCompletionDelivery).toHaveBeenCalledTimes(1);
    expect(retrySubagentCompletionDelivery).toHaveBeenCalledWith("task-completion");
    expect(result).toEqual({ matched: 1, redriven: 1 });
  });

  it("does not retry a completion suspended outside the lock window", async () => {
    findTaskByRunId.mockReturnValue(makeTask("run-task", "task-completion"));
    subagentRuns.set(
      "run-sub",
      makeSuspendedEntry({
        delivery: {
          status: "suspended",
          suspendedAt: NOW - 20_000,
          suspendedReason: "expiry",
        },
      }),
    );

    const result = await redriveSuspendedSubagentCompletionsForRequester(REQUESTER, LOCK_WINDOW);

    expect(findTaskByRunId).not.toHaveBeenCalled();
    expect(retrySubagentCompletionDelivery).not.toHaveBeenCalled();
    expect(result).toEqual({ matched: 0, redriven: 0 });
  });

  it("leaves the completion suspended when the run id has no owning task", async () => {
    findTaskByRunId.mockReturnValue(undefined);
    subagentRuns.set("run-sub", makeSuspendedEntry());

    const result = await redriveSuspendedSubagentCompletionsForRequester(REQUESTER, LOCK_WINDOW);

    expect(retrySubagentCompletionDelivery).not.toHaveBeenCalled();
    expect(result).toEqual({ matched: 1, redriven: 0 });
  });

  it("refuses to redrive without a lock window (no causal compaction link)", async () => {
    findTaskByRunId.mockReturnValue(makeTask("run-task", "task-completion"));
    subagentRuns.set("run-sub", makeSuspendedEntry());

    const result = await redriveSuspendedSubagentCompletionsForRequester(REQUESTER);

    expect(findTaskByRunId).not.toHaveBeenCalled();
    expect(retrySubagentCompletionDelivery).not.toHaveBeenCalled();
    expect(result).toEqual({ matched: 0, redriven: 0 });
  });
});
