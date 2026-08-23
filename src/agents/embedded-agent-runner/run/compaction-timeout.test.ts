// Coverage for timeout decisions and snapshots during compaction.
import { describe, expect, it } from "vitest";
import { castAgentMessage } from "../../test-helpers/agent-message-fixtures.js";
import {
  resolveRunTimeoutDuringCompaction,
  selectCompactionTimeoutSnapshot,
  shouldFlagCompactionTimeout,
  trimToContinuableTail,
} from "./compaction-timeout.js";

function expectSelectedSnapshot(params: {
  currentSessionId: string;
  currentSnapshot: Parameters<typeof selectCompactionTimeoutSnapshot>[0]["currentSnapshot"];
  expectedSessionIdUsed: string;
  expectedSnapshot: ReadonlyArray<ReturnType<typeof castAgentMessage>>;
  expectedSource: "current" | "pre-compaction";
  preCompactionSessionId: string;
  preCompactionSnapshot: Parameters<
    typeof selectCompactionTimeoutSnapshot
  >[0]["preCompactionSnapshot"];
  timedOutDuringCompaction: boolean;
}) {
  // Snapshot selection determines what can be replayed after compaction timeout,
  // so tests assert source, session id, and messages together.
  const selected = selectCompactionTimeoutSnapshot({
    timedOutDuringCompaction: params.timedOutDuringCompaction,
    preCompactionSnapshot: params.preCompactionSnapshot,
    preCompactionSessionId: params.preCompactionSessionId,
    currentSnapshot: params.currentSnapshot,
    currentSessionId: params.currentSessionId,
  });
  expect(selected.source).toBe(params.expectedSource);
  expect(selected.sessionIdUsed).toBe(params.expectedSessionIdUsed);
  expect(selected.messagesSnapshot).toEqual(params.expectedSnapshot);
}

describe("compaction-timeout helpers", () => {
  it("flags compaction timeout consistently for internal and external timeout sources", () => {
    const internalTimer = shouldFlagCompactionTimeout({
      isTimeout: true,
      isCompactionPendingOrRetrying: true,
      isCompactionInFlight: false,
    });
    const externalAbort = shouldFlagCompactionTimeout({
      isTimeout: true,
      isCompactionPendingOrRetrying: true,
      isCompactionInFlight: false,
    });
    expect(internalTimer).toBe(true);
    expect(externalAbort).toBe(true);
  });

  it("does not flag when timeout is false", () => {
    expect(
      shouldFlagCompactionTimeout({
        isTimeout: false,
        isCompactionPendingOrRetrying: true,
        isCompactionInFlight: true,
      }),
    ).toBe(false);
  });

  it("extends the first run timeout reached during compaction", () => {
    expect(
      resolveRunTimeoutDuringCompaction({
        isCompactionPendingOrRetrying: false,
        isCompactionInFlight: true,
        graceAlreadyUsed: false,
      }),
    ).toBe("extend");
  });

  it("aborts after compaction grace has already been used", () => {
    expect(
      resolveRunTimeoutDuringCompaction({
        isCompactionPendingOrRetrying: true,
        isCompactionInFlight: false,
        graceAlreadyUsed: true,
      }),
    ).toBe("abort");
  });

  it("aborts immediately when no compaction is active", () => {
    expect(
      resolveRunTimeoutDuringCompaction({
        isCompactionPendingOrRetrying: false,
        isCompactionInFlight: false,
        graceAlreadyUsed: false,
      }),
    ).toBe("abort");
  });

  it("uses pre-compaction snapshot when compaction timeout occurs", () => {
    const pre = [castAgentMessage({ role: "user", content: "pre" })] as const;
    const current = [castAgentMessage({ role: "assistant", content: "current" })] as const;
    expectSelectedSnapshot({
      timedOutDuringCompaction: true,
      preCompactionSnapshot: [...pre],
      preCompactionSessionId: "session-pre",
      currentSnapshot: [...current],
      currentSessionId: "session-current",
      expectedSource: "pre-compaction",
      expectedSessionIdUsed: "session-pre",
      expectedSnapshot: pre,
    });
  });

  it("trims assistant-tailed pre-compaction snapshots after compaction timeout", () => {
    // Assistant tails are not continuable after compaction timeout; keep the
    // latest safe user/tool boundary instead.
    const user = castAgentMessage({ role: "user", content: "pre-user" });
    const pre = [user, castAgentMessage({ role: "assistant", content: "pre-assistant" })] as const;
    const current = [
      castAgentMessage({ role: "user", content: "current-user" }),
      castAgentMessage({ role: "assistant", content: "current-assistant" }),
    ] as const;
    expectSelectedSnapshot({
      timedOutDuringCompaction: true,
      preCompactionSnapshot: [...pre],
      preCompactionSessionId: "session-pre",
      currentSnapshot: [...current],
      currentSessionId: "session-current",
      expectedSource: "pre-compaction",
      expectedSessionIdUsed: "session-pre",
      expectedSnapshot: [user],
    });
  });

  it("keeps tool-result tails continuable after compaction timeout", () => {
    const toolResult = castAgentMessage({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "lookup",
      content: [{ type: "text", text: "result" }],
      isError: false,
      timestamp: 1,
    });
    const pre = [
      castAgentMessage({ role: "user", content: "pre-user" }),
      castAgentMessage({ role: "assistant", content: "tool call" }),
      toolResult,
      castAgentMessage({ role: "assistant", content: "pre-assistant" }),
    ] as const;
    expectSelectedSnapshot({
      timedOutDuringCompaction: true,
      preCompactionSnapshot: [...pre],
      preCompactionSessionId: "session-pre",
      currentSnapshot: [castAgentMessage({ role: "user", content: "current-user" })],
      currentSessionId: "session-current",
      expectedSource: "pre-compaction",
      expectedSessionIdUsed: "session-pre",
      expectedSnapshot: pre.slice(0, 3),
    });
  });

  it("keeps replay-normalized summary tails continuable after compaction timeout", () => {
    const summary = castAgentMessage({
      role: "compactionSummary",
      summary: "older work was summarized",
      tokensBefore: 120_000,
      timestamp: 1,
    });
    expectSelectedSnapshot({
      timedOutDuringCompaction: true,
      preCompactionSnapshot: null,
      preCompactionSessionId: "session-pre",
      currentSnapshot: [summary],
      currentSessionId: "session-current",
      expectedSource: "current",
      expectedSessionIdUsed: "session-current",
      expectedSnapshot: [summary],
    });
  });

  it("falls back to current snapshot when the pre-compaction timeout snapshot has no continuable tail", () => {
    const current = [castAgentMessage({ role: "user", content: "current" })] as const;
    expectSelectedSnapshot({
      timedOutDuringCompaction: true,
      preCompactionSnapshot: [castAgentMessage({ role: "assistant", content: "pre" })],
      preCompactionSessionId: "session-pre",
      currentSnapshot: [...current],
      currentSessionId: "session-current",
      expectedSource: "current",
      expectedSessionIdUsed: "session-current",
      expectedSnapshot: current,
    });
  });

  it("returns an empty snapshot when compaction timeout leaves only assistant-tailed snapshots", () => {
    expectSelectedSnapshot({
      timedOutDuringCompaction: true,
      preCompactionSnapshot: [castAgentMessage({ role: "assistant", content: "pre" })],
      preCompactionSessionId: "session-pre",
      currentSnapshot: [castAgentMessage({ role: "assistant", content: "current" })],
      currentSessionId: "session-current",
      expectedSource: "current",
      expectedSessionIdUsed: "session-current",
      expectedSnapshot: [],
    });
  });

  it("falls back to current snapshot when pre-compaction snapshot is unavailable", () => {
    const current = [castAgentMessage({ role: "user", content: "current" })] as const;
    expectSelectedSnapshot({
      timedOutDuringCompaction: true,
      preCompactionSnapshot: null,
      preCompactionSessionId: "session-pre",
      currentSnapshot: [...current],
      currentSessionId: "session-current",
      expectedSource: "current",
      expectedSessionIdUsed: "session-current",
      expectedSnapshot: current,
    });
  });

  it.each([
    {
      name: "assistant tail",
      tail: castAgentMessage({ role: "assistant", content: "partial" }),
      expectedLength: 1,
    },
    {
      name: "excluded bash tail",
      tail: castAgentMessage({
        role: "bashExecution",
        command: "echo hi",
        output: "hi\n",
        exitCode: 0,
        cancelled: false,
        truncated: false,
        excludeFromContext: true,
      }),
      expectedLength: 1,
    },
    {
      name: "tool result tail",
      tail: castAgentMessage({
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "lookup",
        content: [{ type: "text", text: "result" }],
        isError: false,
        timestamp: 2,
      }),
      expectedLength: 2,
    },
    {
      name: "summary tail",
      tail: castAgentMessage({
        role: "compactionSummary",
        summary: "older work",
        tokensBefore: 100,
        timestamp: 2,
      }),
      expectedLength: 2,
    },
  ])("normalizes $name for compaction recovery exits", ({ tail, expectedLength }) => {
    const normalized = trimToContinuableTail([
      castAgentMessage({ role: "user", content: "safe" }),
      tail,
    ]);

    expect(normalized).toHaveLength(expectedLength);
    expect(normalized?.at(-1)?.role).not.toBe("assistant");
  });
});
