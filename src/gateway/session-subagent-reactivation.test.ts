/**
 * Subagent session reactivation tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const getLatestSubagentRunByChildSessionKeyMock = vi.fn();
const getLatestLiveSubagentRunByChildSessionKeyMock = vi.fn();
const replaceSubagentRunAfterSteerMock = vi.fn();

vi.mock("../agents/subagents/registry/subagent-registry-read.js", async () => {
  const actual = await vi.importActual<
    typeof import("../agents/subagents/registry/subagent-registry-read.js")
  >("../agents/subagents/registry/subagent-registry-read.js");
  return {
    ...actual,
    getLatestSubagentRunByChildSessionKey: (...args: unknown[]) =>
      getLatestSubagentRunByChildSessionKeyMock(...args),
    getLatestLiveSubagentRunByChildSessionKey: (...args: unknown[]) =>
      getLatestLiveSubagentRunByChildSessionKeyMock(...args),
  };
});

vi.mock("../agents/subagents/registry/subagent-registry-runtime.js", () => ({
  replaceSubagentRunAfterSteer: (...args: unknown[]) => replaceSubagentRunAfterSteerMock(...args),
}));

import { reactivateCompletedSubagentSession } from "./session-subagent-reactivation.js";

describe("reactivateCompletedSubagentSession", () => {
  beforeEach(() => {
    getLatestSubagentRunByChildSessionKeyMock.mockReset();
    getLatestLiveSubagentRunByChildSessionKeyMock.mockReset();
    replaceSubagentRunAfterSteerMock.mockReset();
  });

  it("reactivates the newest ended row even when stale active rows still exist for the same child session", async () => {
    const childSessionKey = "agent:main:subagent:followup-race";
    const resolveGatewayContext = vi.fn(() => ({ owner: "gateway-b" }) as never);
    const latestEndedRun = {
      runId: "run-current-ended",
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "current ended task",
      cleanup: "keep" as const,
      createdAt: 20,
      execution: {
        status: "terminal" as const,
        startedAt: 21,
        endedAt: 22,
        outcome: { status: "ok" as const },
      },
    };

    getLatestSubagentRunByChildSessionKeyMock.mockReturnValue(latestEndedRun);
    replaceSubagentRunAfterSteerMock.mockReturnValue(true);

    await expect(
      reactivateCompletedSubagentSession({
        sessionKey: childSessionKey,
        runId: "run-next",
        gatewayContextResolver: resolveGatewayContext,
      }),
    ).resolves.toBe(true);

    expect(getLatestSubagentRunByChildSessionKeyMock).toHaveBeenCalledWith(childSessionKey);
    expect(replaceSubagentRunAfterSteerMock).toHaveBeenCalledWith({
      previousRunId: "run-current-ended",
      nextRunId: "run-next",
      fallback: latestEndedRun,
      runTimeoutSeconds: 0,
      persistenceFailure: "throw",
      gatewayContextResolver: resolveGatewayContext,
    });
  });

  it("does not replace an ended row after its Gateway owner retires", async () => {
    getLatestSubagentRunByChildSessionKeyMock.mockReturnValue({
      runId: "run-ended",
      runTimeoutSeconds: 0,
      execution: { endedAt: 1 },
    });
    const resolveGatewayContext = vi.fn(() => undefined);

    await expect(
      reactivateCompletedSubagentSession({
        sessionKey: "agent:main:subagent:retired-owner",
        runId: "run-next",
        gatewayContextResolver: resolveGatewayContext,
      }),
    ).resolves.toBe(false);

    expect(resolveGatewayContext).toHaveBeenCalledOnce();
    expect(replaceSubagentRunAfterSteerMock).not.toHaveBeenCalled();
  });

  it("threads the exact follow-up task into the replacement so restart redispatch rewraps the new prompt instead of the stale original", async () => {
    // Regression for the ClawSweeper P2 finding on #77539: the helper-level
    // task override reaches active steer, descendant wake, and orphan
    // recovery, but the completed-session reactivation sibling path used by
    // sessions.send and agent run dispatch was passing only sessionKey + runId.
    // After a gateway restart the orphan recovery would rewrap the stale
    // `task` from the previous run instead of the canonical follow-up text.
    const childSessionKey = "agent:main:subagent:reactivate-with-task";
    const latestEndedRun = {
      runId: "run-prev-ended",
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "stale original task",
      cleanup: "keep" as const,
      createdAt: 30,
      execution: {
        status: "terminal" as const,
        startedAt: 31,
        endedAt: 32,
        outcome: { status: "ok" as const },
      },
    };

    getLatestSubagentRunByChildSessionKeyMock.mockReturnValue(latestEndedRun);
    replaceSubagentRunAfterSteerMock.mockReturnValue(true);

    await expect(
      reactivateCompletedSubagentSession({
        sessionKey: childSessionKey,
        runId: "run-next",
        task: "  follow-up prompt text  ",
      }),
    ).resolves.toBe(true);

    expect(replaceSubagentRunAfterSteerMock).toHaveBeenCalledWith({
      previousRunId: "run-prev-ended",
      nextRunId: "run-next",
      fallback: latestEndedRun,
      runTimeoutSeconds: 0,
      persistenceFailure: "throw",
      task: "  follow-up prompt text  ",
    });
  });

  it("omits the task field entirely when no follow-up text is supplied (caller-side backward compat)", async () => {
    const childSessionKey = "agent:main:subagent:no-task";
    const latestEndedRun = {
      runId: "run-prev-ended",
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "stale original task",
      cleanup: "keep" as const,
      createdAt: 40,
      execution: {
        status: "terminal" as const,
        startedAt: 41,
        endedAt: 42,
        outcome: { status: "ok" as const },
      },
    };
    getLatestSubagentRunByChildSessionKeyMock.mockReturnValue(latestEndedRun);
    replaceSubagentRunAfterSteerMock.mockReturnValue(true);

    await reactivateCompletedSubagentSession({
      sessionKey: childSessionKey,
      runId: "run-next",
    });
    await reactivateCompletedSubagentSession({
      sessionKey: childSessionKey,
      runId: "run-next-2",
      task: "   ",
    });

    for (const call of replaceSubagentRunAfterSteerMock.mock.calls) {
      expect(call[0]).not.toHaveProperty("task");
    }
  });

  it("rejects an accepted run when its owner replacement cannot persist", async () => {
    const childSessionKey = "agent:main:subagent:persistence-failure";
    getLatestSubagentRunByChildSessionKeyMock.mockReturnValue({
      runId: "run-prev-ended",
      childSessionKey,
      task: "previous task",
      cleanup: "keep",
      createdAt: 40,
      execution: { status: "terminal", startedAt: 41, endedAt: 42 },
    });
    replaceSubagentRunAfterSteerMock.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(
      reactivateCompletedSubagentSession({
        sessionKey: childSessionKey,
        runId: "run-next",
      }),
    ).rejects.toThrow("database unavailable");
  });

  it("rejects an accepted run when another replacement owns the child session", async () => {
    const childSessionKey = "agent:main:subagent:replacement-race";
    getLatestSubagentRunByChildSessionKeyMock.mockReturnValue({
      runId: "run-prev-ended",
      childSessionKey,
      task: "previous task",
      cleanup: "keep",
      createdAt: 40,
      execution: { status: "terminal", startedAt: 41, endedAt: 42 },
    });
    replaceSubagentRunAfterSteerMock.mockReturnValueOnce(false);
    getLatestLiveSubagentRunByChildSessionKeyMock.mockReturnValue({
      runId: "run-other-successor",
    });

    await expect(
      reactivateCompletedSubagentSession({
        sessionKey: childSessionKey,
        runId: "run-losing-successor",
      }),
    ).rejects.toThrow("subagent follow-up owner replacement was rejected");
  });

  it("keeps an accepted run that already owns the child session", async () => {
    const childSessionKey = "agent:main:subagent:already-replaced";
    getLatestSubagentRunByChildSessionKeyMock.mockReturnValue({
      runId: "run-prev-ended",
      childSessionKey,
      task: "previous task",
      cleanup: "keep",
      createdAt: 40,
      execution: { status: "terminal", startedAt: 41, endedAt: 42 },
    });
    replaceSubagentRunAfterSteerMock.mockReturnValueOnce(false);
    getLatestLiveSubagentRunByChildSessionKeyMock.mockReturnValue({ runId: "run-next" });

    await expect(
      reactivateCompletedSubagentSession({
        sessionKey: childSessionKey,
        runId: "run-next",
      }),
    ).resolves.toBe(true);
  });
});
