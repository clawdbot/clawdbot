// Full-entry coverage for retrying an already-capped mid-turn transcript.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildEmbeddedRunnerAssistant } from "../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import {
  makeAttemptResult,
  makeCompactionSuccess,
  makeOverflowError,
} from "./run.overflow-compaction.fixture.js";
import {
  mockedCompactDirect,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetSharedRunIntegrationHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import { loadSharedRunIntegrationHarness } from "./run.shared-integration-harness.test-support.js";

const settledExecAssistant = buildEmbeddedRunnerAssistant({
  content: [{ type: "toolCall" as const, id: "call-exec", name: "exec", arguments: {} }],
  stopReason: "toolUse" as const,
  timestamp: 1,
});
const settledExecResult = {
  role: "toolResult" as const,
  toolCallId: "call-exec",
  toolName: "exec",
  content: [{ type: "text" as const, text: "command completed" }],
  isError: false,
  timestamp: 2,
};

let runEmbeddedAgent: Awaited<ReturnType<typeof loadSharedRunIntegrationHarness>>;

function requireAttemptCall(index: number): {
  prompt?: string;
  promptCacheKey?: string;
  sessionId?: string;
  suppressNextUserMessagePersistence?: boolean;
} {
  const call = mockedRunEmbeddedAttempt.mock.calls[index];
  if (!call) {
    throw new Error(`expected embedded attempt call ${index}`);
  }
  return call[0] as {
    prompt?: string;
    promptCacheKey?: string;
    sessionId?: string;
    suppressNextUserMessagePersistence?: boolean;
  };
}

function expectRetryContinuesFromTranscript(): void {
  const retry = requireAttemptCall(1);
  expect(retry.prompt).toContain("Continue from the current transcript");
  expect(retry.suppressNextUserMessagePersistence).toBe(true);
  expect(retry.prompt).not.toBe(overflowBaseRunParams.prompt);
}

function makeReplayUnsafeMidTurnOverflow(params?: {
  activeCount?: number;
  asyncStarted?: boolean;
}) {
  const activeCount = params?.activeCount ?? 0;
  return makeAttemptResult({
    promptError: makeOverflowError("Context overflow: prompt too large (mid-turn precheck)."),
    promptErrorSource: "precheck",
    preflightRecovery: {
      route: "compact_only",
      source: "mid-turn",
      estimatedPromptTokens: 201_000,
    },
    assistantTexts: [],
    lastAssistant: settledExecAssistant,
    currentAttemptAssistant: settledExecAssistant,
    messagesSnapshot: [settledExecAssistant, settledExecResult],
    toolMetas: [
      {
        toolName: "exec",
        toolCallId: "call-exec",
        replaySafe: false,
        asyncStarted: params?.asyncStarted ?? false,
      },
    ],
    itemLifecycle: {
      startedCount: 1,
      completedCount: activeCount === 0 ? 1 : 0,
      activeCount,
    },
  });
}

describe("runEmbeddedAgent mid-turn precheck retry", () => {
  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
  });

  beforeEach(() => {
    resetSharedRunIntegrationHarnessMocks();
  });

  it("continues once when persisted truncation is already a no-op", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          preflightRecovery: {
            route: "truncate_tool_results_only",
            source: "mid-turn",
            handled: true,
            truncatedCount: 0,
          },
          toolMetas: [{ toolName: "read", meta: "step=1" }],
          latestMcpAppChannelView: { viewId: "view-before-retry" },
        }),
      )
      .mockResolvedValueOnce(makeAttemptResult());

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      runId: "run-midturn-precheck-noop",
      promptCacheKey: "stable-cache-key",
    });

    expect(mockedCompactDirect).not.toHaveBeenCalled();
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expectRetryContinuesFromTranscript();
    const initial = requireAttemptCall(0);
    const retry = requireAttemptCall(1);
    expect(retry.sessionId).toBe(initial.sessionId);
    expect(initial.promptCacheKey).toBe("stable-cache-key");
    expect(retry.promptCacheKey).toBe(initial.promptCacheKey);
    expect(result.latestMcpAppChannelView).toEqual({ viewId: "view-before-retry" });
    expect(result.meta.error).toBeUndefined();
  });

  it("still compacts after a real provider overflow follows the no-op", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          preflightRecovery: {
            route: "truncate_tool_results_only",
            source: "mid-turn",
            handled: true,
            truncatedCount: 0,
          },
        }),
      )
      .mockResolvedValueOnce(makeAttemptResult({ promptError: makeOverflowError() }))
      .mockResolvedValueOnce(makeAttemptResult());
    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "Compacted after provider rejection",
        firstKeptEntryId: "entry-provider-overflow",
        tokensBefore: 155_000,
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      runId: "run-midturn-precheck-provider-overflow",
    });

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(3);
    expectRetryContinuesFromTranscript();
    expect(result.meta.error).toBeUndefined();
  });

  it("compacts settled replay-unsafe tools and continues from their recorded result", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(makeReplayUnsafeMidTurnOverflow())
      .mockResolvedValueOnce(makeAttemptResult());
    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "Compacted after settled exec",
        firstKeptEntryId: "entry-settled-exec",
        tokensBefore: 201_000,
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      runId: "run-midturn-settled-unsafe",
    });

    expect(mockedCompactDirect).toHaveBeenCalledOnce();
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expectRetryContinuesFromTranscript();
    expect(result.meta.error).toBeUndefined();
  });

  it.each([
    ["an unsettled tool", { activeCount: 1 }, true],
    ["asynchronous tool activity", { asyncStarted: true }, false],
  ])("keeps %s fail-closed", async (_label, attemptParams, expectsWarning) => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeReplayUnsafeMidTurnOverflow(attemptParams));

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      runId: `run-midturn-fail-closed-${_label.replaceAll(" ", "-")}`,
    });

    expect(mockedCompactDirect).not.toHaveBeenCalled();
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledOnce();
    if (expectsWarning) {
      expect(result.payloads?.[0]?.text).toContain(
        "some tool actions may have already been executed",
      );
    } else {
      expect(result.payloads).toBeUndefined();
    }
  });

  it("preserves overflow recovery guidance when compaction fails after settled tools", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeReplayUnsafeMidTurnOverflow());
    mockedCompactDirect.mockResolvedValueOnce({
      ok: false,
      compacted: false,
      reason: "compaction unavailable",
    });

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      runId: "run-midturn-settled-compaction-failure",
    });

    expect(mockedCompactDirect).toHaveBeenCalledOnce();
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledOnce();
    expect(result.payloads?.[0]?.text).toContain("Try /reset (or /new)");
    expect(result.payloads?.[0]?.text).toContain("Completed tool actions were not replayed");
  });
});
