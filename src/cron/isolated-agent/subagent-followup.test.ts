import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted runs before module imports, ensuring FAST_TEST_MODE is picked up.
vi.hoisted(() => {
  process.env.OPENCLAW_TEST_FAST = "1";
});

import { expectsSubagentFollowup, isLikelyInterimCronMessage } from "./subagent-followup-hints.js";
import {
  readDescendantSubagentFallbackReply,
  waitForDescendantSubagentSummary,
} from "./subagent-followup.js";

vi.mock("../../agents/subagent-registry-read.js", () => ({
  listDescendantRunsForRequester: vi.fn().mockReturnValue([]),
}));

vi.mock("../../agents/run-wait.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/run-wait.js")>(
    "../../agents/run-wait.js",
  );
  return {
    ...actual,
    readLatestAssistantReply: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../../gateway/call.js", () => ({
  callGateway: vi.fn().mockResolvedValue({ status: "ok" }),
}));

const { listDescendantRunsForRequester } = await import("../../agents/subagent-registry-read.js");
const { __testing: runWaitTesting, readLatestAssistantReply } =
  await import("../../agents/run-wait.js");
const { callGateway } = await import("../../gateway/call.js");

async function resolveAfterAdvancingTimers<T>(promise: Promise<T>, advanceMs = 100): Promise<T> {
  await vi.advanceTimersByTimeAsync(advanceMs);
  return promise;
}

function createDescendantRun(params?: {
  runId?: string;
  childSessionKey?: string;
  task?: string;
  cleanup?: "keep" | "delete";
  endedAt?: number;
  frozenResultText?: string | null;
}) {
  return {
    runId: params?.runId ?? "run-1",
    childSessionKey: params?.childSessionKey ?? "child-1",
    requesterSessionKey: "test-session",
    requesterDisplayKey: "test-session",
    task: params?.task ?? "task-1",
    cleanup: params?.cleanup ?? "keep",
    createdAt: 1000,
    endedAt: params?.endedAt ?? 2000,
    ...(params?.frozenResultText === undefined
      ? {}
      : { frozenResultText: params.frozenResultText }),
  };
}

describe("isLikelyInterimCronMessage", () => {
  it("detects 'on it' as interim", () => {
    expect(isLikelyInterimCronMessage("on it")).toBe(true);
  });
  it("detects subagent-related interim text", () => {
    expect(isLikelyInterimCronMessage("spawned a subagent, it'll auto-announce when done")).toBe(
      true,
    );
  });
  it("rejects substantive content", () => {
    expect(isLikelyInterimCronMessage("Here are your results: revenue was $5000 this month")).toBe(
      false,
    );
  });
  it("does not treat empty as interim (empty = NO_REPLY was stripped)", () => {
    expect(isLikelyInterimCronMessage("")).toBe(false);
  });

  it("does not treat whitespace-only as interim", () => {
    expect(isLikelyInterimCronMessage("   ")).toBe(false);
  });
});

describe("expectsSubagentFollowup", () => {
  it("returns true for subagent spawn hints", () => {
    expect(expectsSubagentFollowup("subagent spawned")).toBe(true);
    expect(expectsSubagentFollowup("spawned a subagent")).toBe(true);
    expect(expectsSubagentFollowup("it'll auto-announce when done")).toBe(true);
    expect(expectsSubagentFollowup("both subagents are running")).toBe(true);
  });
  it("returns false for plain interim text", () => {
    expect(expectsSubagentFollowup("on it")).toBe(false);
    expect(expectsSubagentFollowup("working on it")).toBe(false);
  });
  it("returns false for empty string", () => {
    expect(expectsSubagentFollowup("")).toBe(false);
  });
});

describe("readDescendantSubagentFallbackReply", () => {
  const runStartedAt = 1000;

  it("returns undefined when no descendants exist", async () => {
    vi.mocked(listDescendantRunsForRequester).mockReturnValue([]);
    const result = await readDescendantSubagentFallbackReply({
      sessionKey: "test-session",
      runStartedAt,
    });
    expect(result).toBeUndefined();
  });

  it("reads reply from child session transcript", async () => {
    vi.mocked(listDescendantRunsForRequester).mockReturnValue([createDescendantRun()]);
    vi.mocked(readLatestAssistantReply).mockResolvedValue("child output text");
    const result = await readDescendantSubagentFallbackReply({
      sessionKey: "test-session",
      runStartedAt,
    });
    expect(result).toBe("child output text");
  });

  it("falls back to frozenResultText when session transcript unavailable", async () => {
    vi.mocked(listDescendantRunsForRequester).mockReturnValue([
      createDescendantRun({
        cleanup: "delete",
        frozenResultText: "frozen child output",
      }),
    ]);
    vi.mocked(readLatestAssistantReply).mockResolvedValue(undefined);
    const result = await readDescendantSubagentFallbackReply({
      sessionKey: "test-session",
      runStartedAt,
    });
    expect(result).toBe("frozen child output");
  });

  it("prefers session transcript over frozenResultText", async () => {
    vi.mocked(listDescendantRunsForRequester).mockReturnValue([
      createDescendantRun({ frozenResultText: "frozen text" }),
    ]);
    vi.mocked(readLatestAssistantReply).mockResolvedValue("live transcript text");
    const result = await readDescendantSubagentFallbackReply({
      sessionKey: "test-session",
      runStartedAt,
    });
    expect(result).toBe("live transcript text");
  });

  it("joins replies from multiple descendants", async () => {
    vi.mocked(listDescendantRunsForRequester).mockReturnValue([
      createDescendantRun({ frozenResultText: "first child output" }),
      createDescendantRun({
        runId: "run-2",
        childSessionKey: "child-2",
        task: "task-2",
        endedAt: 3000,
        frozenResultText: "second child output",
      }),
    ]);
    vi.mocked(readLatestAssistantReply).mockResolvedValue(undefined);
    const result = await readDescendantSubagentFallbackReply({
      sessionKey: "test-session",
      runStartedAt,
    });
    expect(result).toBe("first child output\n\nsecond child output");
  });

  it("skips SILENT_REPLY_TOKEN descendants", async () => {
    vi.mocked(listDescendantRunsForRequester).mockReturnValue([
      createDescendantRun(),
      createDescendantRun({
        runId: "run-2",
        childSessionKey: "child-2",
        task: "task-2",
        endedAt: 3000,
        frozenResultText: "useful output",
      }),
    ]);
    vi.mocked(readLatestAssistantReply).mockImplementation(async (params) => {
      if (params.sessionKey === "child-1") {
        return "NO_REPLY";
      }
      return undefined;
    });
    const result = await readDescendantSubagentFallbackReply({
      sessionKey: "test-session",
      runStartedAt,
    });
    expect(result).toBe("useful output");
  });

  it("returns undefined when frozenResultText is null", async () => {
    vi.mocked(listDescendantRunsForRequester).mockReturnValue([
      createDescendantRun({
        cleanup: "delete",
        frozenResultText: null,
      }),
    ]);
    vi.mocked(readLatestAssistantReply).mockResolvedValue(undefined);
    const result = await readDescendantSubagentFallbackReply({
      sessionKey: "test-session",
      runStartedAt,
    });
    expect(result).toBeUndefined();
  });

  it("ignores descendants that ended before run started", async () => {
    vi.mocked(listDescendantRunsForRequester).mockReturnValue([
      {
        runId: "run-1",
        childSessionKey: "child-1",
        requesterSessionKey: "test-session",
        requesterDisplayKey: "test-session",
        task: "task-1",
        cleanup: "keep",
        createdAt: 500,
        endedAt: 900,
        frozenResultText: "stale output from previous run",
      },
    ]);
    vi.mocked(readLatestAssistantReply).mockResolvedValue(undefined);
    const result = await readDescendantSubagentFallbackReply({
      sessionKey: "test-session",
      runStartedAt,
    });
    expect(result).toBeUndefined();
  });
});

describe("waitForDescendantSubagentSummary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    vi.mocked(listDescendantRunsForRequester).mockReturnValue([]);
    vi.mocked(readLatestAssistantReply).mockResolvedValue(undefined);
    vi.mocked(callGateway).mockResolvedValue({ status: "ok" });
    runWaitTesting.setDepsForTest({
      callGateway: ((opts) => vi.mocked(callGateway)(opts as never)) as typeof callGateway,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    runWaitTesting.setDepsForTest();
  });

  it("returns initialReply immediately when no active descendants and observedActiveDescendants=false", async () => {
    vi.mocked(listDescendantRunsForRequester).mockReturnValue([]);
    const result = await waitForDescendantSubagentSummary({
      sessionKey: "cron-session",
      initialReply: "on it",
      timeoutMs: 100,
      observedActiveDescendants: false,
    });
    expect(result).toBe("on it");
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("awaits active descendants via agent.wait and returns synthesis after grace period", async () => {
    // First call: active run; second call (after agent.wait resolves): no active runs
    vi.mocked(listDescendantRunsForRequester)
      .mockReturnValueOnce([
        {
          runId: "run-abc",
          childSessionKey: "child-session",
          requesterSessionKey: "cron-session",
          requesterDisplayKey: "cron-session",
          task: "morning briefing",
          cleanup: "keep",
          createdAt: 1000,
          // no endedAt → active
        },
      ])
      .mockReturnValue([]); // subsequent calls: all done

    vi.mocked(callGateway).mockResolvedValue({ status: "ok" });
    vi.mocked(readLatestAssistantReply).mockResolvedValue("Morning briefing complete!");

    const result = await waitForDescendantSubagentSummary({
      sessionKey: "cron-session",
      initialReply: "on it",
      timeoutMs: 30_000,
      observedActiveDescendants: true,
    });

    expect(result).toBe("Morning briefing complete!");
    // agent.wait should have been called with the active run's ID
    const gatewayCalls = (
      callGateway as unknown as {
        mock: { calls: Array<[{ method?: string; params?: { runId?: string } }]> };
      }
    ).mock.calls;
    const waitCall = gatewayCalls.find(([request]) => request.method === "agent.wait")?.[0];
    expect(waitCall?.method).toBe("agent.wait");
    expect(waitCall?.params?.runId).toBe("run-abc");
  });

  it("returns undefined when descendants finish but only interim text remains after grace period", async () => {
    vi.useFakeTimers();
    // No active runs at call time, but observedActiveDescendants=true (saw them before)
    vi.mocked(listDescendantRunsForRequester).mockReturnValue([]);
    // readLatestAssistantReply keeps returning interim text
    vi.mocked(readLatestAssistantReply).mockResolvedValue("on it");

    const resultPromise = waitForDescendantSubagentSummary({
      sessionKey: "cron-session",
      initialReply: "on it",
      timeoutMs: 100,
      observedActiveDescendants: true,
    });

    const result = await resolveAfterAdvancingTimers(resultPromise);

    expect(result).toBeUndefined();
  });

  it("returns synthesis even if initial reply was undefined", async () => {
    vi.mocked(listDescendantRunsForRequester)
      .mockReturnValueOnce([
        {
          runId: "run-xyz",
          childSessionKey: "child-2",
          requesterSessionKey: "cron-session",
          requesterDisplayKey: "cron-session",
          task: "report",
          cleanup: "keep",
          createdAt: 1000,
        },
      ])
      .mockReturnValue([]);

    vi.mocked(callGateway).mockResolvedValue({ status: "ok" });
    vi.mocked(readLatestAssistantReply).mockResolvedValue("Report generated successfully.");

    const result = await waitForDescendantSubagentSummary({
      sessionKey: "cron-session",
      initialReply: undefined,
      timeoutMs: 30_000,
      observedActiveDescendants: true,
    });

    expect(result).toBe("Report generated successfully.");
  });

  it("uses agent.wait for each active run when multiple descendants exist", async () => {
    vi.mocked(listDescendantRunsForRequester)
      .mockReturnValueOnce([
        {
          runId: "run-1",
          childSessionKey: "child-1",
          requesterSessionKey: "cron-session",
          requesterDisplayKey: "cron-session",
          task: "task-1",
          cleanup: "keep",
          createdAt: 1000,
        },
        {
          runId: "run-2",
          childSessionKey: "child-2",
          requesterSessionKey: "cron-session",
          requesterDisplayKey: "cron-session",
          task: "task-2",
          cleanup: "keep",
          createdAt: 1000,
        },
      ])
      .mockReturnValue([]);

    vi.mocked(callGateway).mockResolvedValue({ status: "ok" });
    vi.mocked(readLatestAssistantReply).mockResolvedValue("All tasks complete.");

    await waitForDescendantSubagentSummary({
      sessionKey: "cron-session",
      initialReply: "spawned a subagent",
      timeoutMs: 30_000,
      observedActiveDescendants: true,
    });

    // agent.wait called once for each active run
    const waitCalls = vi
      .mocked(callGateway)
      .mock.calls.filter((c) => (c[0] as { method?: string }).method === "agent.wait");
    expect(waitCalls).toHaveLength(2);
    const runIds = waitCalls.map((c) => (c[0] as { params: { runId: string } }).params.runId);
    expect(runIds).toContain("run-1");
    expect(runIds).toContain("run-2");
  });

  it("waits for newly discovered active descendants after the first wait round", async () => {
    vi.mocked(listDescendantRunsForRequester)
      .mockReturnValueOnce([
        {
          runId: "run-1",
          childSessionKey: "child-1",
          requesterSessionKey: "cron-session",
          requesterDisplayKey: "cron-session",
          task: "task-1",
          cleanup: "keep",
          createdAt: 1000,
        },
      ])
      .mockReturnValueOnce([
        {
          runId: "run-2",
          childSessionKey: "child-2",
          requesterSessionKey: "cron-session",
          requesterDisplayKey: "cron-session",
          task: "task-2",
          cleanup: "keep",
          createdAt: 1001,
        },
      ])
      .mockReturnValue([]);

    vi.mocked(callGateway).mockResolvedValue({ status: "ok" });
    vi.mocked(readLatestAssistantReply).mockResolvedValue("Nested descendant work complete.");

    const result = await waitForDescendantSubagentSummary({
      sessionKey: "cron-session",
      initialReply: "spawned a subagent",
      timeoutMs: 30_000,
      observedActiveDescendants: true,
    });

    expect(result).toBe("Nested descendant work complete.");
    const waitedRunIds = vi
      .mocked(callGateway)
      .mock.calls.filter((c) => (c[0] as { method?: string }).method === "agent.wait")
      .map((c) => (c[0] as { params: { runId: string } }).params.runId);
    expect(waitedRunIds).toEqual(["run-1", "run-2"]);
  });

  it("handles agent.wait errors gracefully and still reads the synthesis", async () => {
    vi.mocked(listDescendantRunsForRequester)
      .mockReturnValueOnce([
        {
          runId: "run-err",
          childSessionKey: "child-err",
          requesterSessionKey: "cron-session",
          requesterDisplayKey: "cron-session",
          task: "task-err",
          cleanup: "keep",
          createdAt: 1000,
        },
      ])
      .mockReturnValue([]);

    vi.mocked(callGateway).mockRejectedValue(new Error("gateway unavailable"));
    vi.mocked(readLatestAssistantReply).mockResolvedValue("Completed despite gateway error.");

    const result = await waitForDescendantSubagentSummary({
      sessionKey: "cron-session",
      initialReply: "on it",
      timeoutMs: 30_000,
      observedActiveDescendants: true,
    });

    expect(result).toBe("Completed despite gateway error.");
  });

  it("skips NO_REPLY synthesis and returns undefined", async () => {
    vi.useFakeTimers();
    vi.mocked(listDescendantRunsForRequester).mockReturnValue([]);
    vi.mocked(readLatestAssistantReply).mockResolvedValue("NO_REPLY");

    const resultPromise = waitForDescendantSubagentSummary({
      sessionKey: "cron-session",
      initialReply: "on it",
      timeoutMs: 100,
      observedActiveDescendants: true,
    });

    const result = await resolveAfterAdvancingTimers(resultPromise);

    expect(result).toBeUndefined();
  });
});
