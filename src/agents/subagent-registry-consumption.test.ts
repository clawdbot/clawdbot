// Subagent registry consumption tests cover requester-owned orchestration credit.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markDescendantCompletionConsumedByRequester } from "./subagent-registry-consumption.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const restoreSubagentRunsFromDiskMock = vi.hoisted(() => vi.fn(() => 0));
const persistSubagentRunsToDiskMock = vi.hoisted(() => vi.fn());

vi.mock("./subagent-registry-state.js", () => ({
  persistSubagentRunsToDisk: persistSubagentRunsToDiskMock,
  restoreSubagentRunsFromDisk: restoreSubagentRunsFromDiskMock,
}));

function makeCompletedRun(
  overrides: Partial<SubagentRunRecord> & Pick<SubagentRunRecord, "runId">,
): SubagentRunRecord {
  const now = Date.now();
  const { runId, ...rest } = overrides;
  return {
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    requesterSessionKey: "agent:main:cron:daily:run:abc",
    requesterDisplayKey: "cron run",
    task: "child task",
    cleanup: "keep",
    expectsCompletionMessage: true,
    createdAt: now - 100,
    execution: {
      status: "terminal",
      startedAt: now - 90,
      endedAt: now - 10,
      outcome: { status: "ok" },
    },
    completion: { required: true, resultText: "child result" },
    delivery: { status: "pending" },
    ...rest,
  };
}

describe("markDescendantCompletionConsumedByRequester", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00Z"));
    subagentRuns.clear();
    restoreSubagentRunsFromDiskMock.mockClear();
    restoreSubagentRunsFromDiskMock.mockReturnValue(0);
    persistSubagentRunsToDiskMock.mockClear();
  });

  afterEach(() => {
    subagentRuns.clear();
    vi.useRealTimers();
  });

  it("credits requester-consumed descendant completion as delivered", () => {
    const now = Date.now();
    subagentRuns.set(
      "run-consumed-child",
      makeCompletedRun({
        runId: "run-consumed-child",
        childSessionKey: "agent:main:subagent:consumed-child",
        delivery: { status: "pending", lastError: "announce deferred" },
      }),
    );

    const updated = markDescendantCompletionConsumedByRequester({
      requesterSessionKey: "agent:main:cron:daily:run:abc",
      runStartedAt: now - 200,
      runIds: ["run-consumed-child"],
    });

    const run = subagentRuns.get("run-consumed-child");
    expect(updated).toBe(1);
    expect(run?.delivery).toMatchObject({
      status: "delivered",
      requesterConsumedAt: now,
    });
    expect(run?.delivery?.lastError).toBeUndefined();
    expect(persistSubagentRunsToDiskMock).toHaveBeenCalledWith(subagentRuns);
  });

  it("uses the requested run ids directly instead of scanning unrelated rows", () => {
    const now = Date.now();
    const unrelatedEntry = makeCompletedRun({
      runId: "run-unrelated",
      childSessionKey: "agent:main:subagent:unrelated",
      task: "unrelated task",
      completion: { required: true, resultText: "unrelated result" },
    });
    subagentRuns.set("run-unrelated", unrelatedEntry);

    const updated = markDescendantCompletionConsumedByRequester({
      requesterSessionKey: "agent:main:cron:daily:run:abc",
      runStartedAt: now - 200,
      runIds: ["missing-run-id"],
    });

    expect(updated).toBe(0);
    expect(subagentRuns.get("run-unrelated")?.delivery?.status).toBe("pending");
    expect(persistSubagentRunsToDiskMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "wrong requester",
      params: (now: number) => ({
        requesterSessionKey: "agent:main:cron:other:run:def",
        runStartedAt: now - 200,
      }),
    },
    {
      name: "stale window",
      params: (now: number) => ({
        requesterSessionKey: "agent:main:cron:daily:run:abc",
        runStartedAt: now,
      }),
    },
  ])("does not credit unrelated requester consumption: $name", ({ params: buildParams }) => {
    const now = Date.now();
    subagentRuns.set(
      "run-unrelated-child",
      makeCompletedRun({
        runId: "run-unrelated-child",
        childSessionKey: "agent:main:subagent:unrelated-child",
      }),
    );

    const updated = markDescendantCompletionConsumedByRequester({
      ...buildParams(now),
      runIds: ["run-unrelated-child"],
    });

    const run = subagentRuns.get("run-unrelated-child");
    expect(updated).toBe(0);
    expect(run?.delivery?.status).toBe("pending");
    expect(run?.delivery?.requesterConsumedAt).toBeUndefined();
    expect(persistSubagentRunsToDiskMock).not.toHaveBeenCalled();
  });
});
