// Full-entry coverage for retrying an already-capped mid-turn transcript.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
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
});
