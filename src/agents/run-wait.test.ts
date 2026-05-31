import {
  addTimerTimeoutGraceMs,
  MAX_DATE_TIMESTAMP_MS,
  MAX_TIMER_TIMEOUT_MS,
} from "@openclaw/normalization-core/number-coercion";
import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.fn();
vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

import {
  testing,
  isRecoverableAgentWaitError,
  readLatestAssistantReply,
  readLatestAssistantReplySnapshot,
  waitForAgentRun,
  waitForAgentRunsToDrain,
  waitForAgentRunAndReadUpdatedAssistantReply,
} from "./run-wait.js";

type AgentWaitGatewayRequest = {
  method?: string;
  params?: {
    runId?: string;
    timeoutMs?: unknown;
  };
  timeoutMs?: unknown;
};

function expectNumber(value: unknown, label: string): number {
  expect(typeof value).toBe("number");
  if (typeof value !== "number") {
    throw new Error(`expected ${label} to be a number`);
  }
  return value;
}

function gatewayWaitRequests(): AgentWaitGatewayRequest[] {
  return callGatewayMock.mock.calls.map(([request]) => request as AgentWaitGatewayRequest);
}

function requireRequestAt(
  requests: readonly AgentWaitGatewayRequest[],
  index: number,
): AgentWaitGatewayRequest {
  const request = requests.at(index);
  if (!request) {
    throw new Error(`expected gateway request at index ${index}`);
  }
  return request;
}

function expectAgentWaitRequest(
  request: AgentWaitGatewayRequest,
  runId: string,
  maxParamTimeoutMs: number,
): void {
  expect(request.method).toBe("agent.wait");
  expect(request.params?.runId).toBe(runId);

  const paramTimeoutMs = expectNumber(request.params?.timeoutMs, `${runId} param timeoutMs`);
  const requestTimeoutMs = expectNumber(request.timeoutMs, `${runId} request timeoutMs`);
  expect(requestTimeoutMs).toBe(addTimerTimeoutGraceMs(paramTimeoutMs, 2_000));
  expect(requestTimeoutMs).toBeLessThanOrEqual(
    addTimerTimeoutGraceMs(maxParamTimeoutMs, 2_000) ?? MAX_TIMER_TIMEOUT_MS,
  );
  expect(paramTimeoutMs).toBeGreaterThanOrEqual(1);
  expect(paramTimeoutMs).toBeLessThanOrEqual(maxParamTimeoutMs);
}

describe("readLatestAssistantReply", () => {
  beforeEach(() => {
    callGatewayMock.mockClear();
    testing.setDepsForTest({
      callGateway: async (opts) => await callGatewayMock(opts),
    });
  });

  it("returns the most recent assistant message when compaction markers trail history", async () => {
    callGatewayMock.mockResolvedValue({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "All checks passed and changes were pushed." }],
        },
        { role: "toolResult", content: [{ type: "text", text: "tool output" }] },
        { role: "system", content: [{ type: "text", text: "Compaction" }] },
      ],
    });

    const result = await readLatestAssistantReply({ sessionKey: "agent:main:child" });

    expect(result).toBe("All checks passed and changes were pushed.");
    expect(callGatewayMock).toHaveBeenCalledWith({
      method: "chat.history",
      params: { sessionKey: "agent:main:child", limit: 50 },
    });
  });

  it("falls back to older assistant text when latest assistant has no text", async () => {
    callGatewayMock.mockResolvedValue({
      messages: [
        { role: "assistant", content: [{ type: "text", text: "older output" }] },
        { role: "assistant", content: [] },
        { role: "system", content: [{ type: "text", text: "Compaction" }] },
      ],
    });

    const result = await readLatestAssistantReply({ sessionKey: "agent:main:child" });

    expect(result).toBe("older output");
  });

  it("returns assistant fingerprints for delta comparisons", async () => {
    callGatewayMock.mockResolvedValue({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "new output" }],
          timestamp: 42,
        },
      ],
    });

    const result = await readLatestAssistantReplySnapshot({ sessionKey: "agent:main:child" });

    expect(result.text).toBe("new output");
    expect(result.fingerprint).toContain('"timestamp":42');
  });

  it("reads only final_answer text from phased assistant history", async () => {
    callGatewayMock.mockResolvedValue({
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Need fix line quoting properly.",
              textSignature: JSON.stringify({ v: 1, id: "commentary", phase: "commentary" }),
            },
            {
              type: "text",
              text: "Fixed the quoting issue.",
              textSignature: JSON.stringify({ v: 1, id: "final", phase: "final_answer" }),
            },
          ],
        },
      ],
    });

    const result = await readLatestAssistantReply({ sessionKey: "agent:main:child" });

    expect(result).toBe("Fixed the quoting issue.");
  });

  it("preserves spaces across split final_answer history blocks", async () => {
    callGatewayMock.mockResolvedValue({
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Need fix line quoting properly.",
              textSignature: JSON.stringify({ v: 1, id: "commentary", phase: "commentary" }),
            },
            {
              type: "text",
              text: "Hi ",
              textSignature: JSON.stringify({ v: 1, id: "final_1", phase: "final_answer" }),
            },
            {
              type: "text",
              text: "there",
              textSignature: JSON.stringify({ v: 1, id: "final_2", phase: "final_answer" }),
            },
          ],
        },
      ],
    });

    const result = await readLatestAssistantReply({ sessionKey: "agent:main:child" });

    expect(result).toBe("Hi there");
  });
});

describe("waitForAgentRun", () => {
  beforeEach(() => {
    callGatewayMock.mockClear();
    testing.setDepsForTest({
      callGateway: async (opts) => await callGatewayMock(opts),
    });
  });

  it("maps gateway timeouts to timeout status", async () => {
    callGatewayMock.mockRejectedValue(new Error("gateway timeout while waiting"));

    const result = await waitForAgentRun({ runId: "run-1", timeoutMs: 500 });

    expect(result).toEqual({
      status: "timeout",
      error: "gateway timeout while waiting",
    });
  });

  it("keeps transport-close wait failures as errors for generic callers", async () => {
    callGatewayMock.mockRejectedValue(new Error("gateway closed (1006): transport close"));

    const result = await waitForAgentRun({ runId: "run-interrupted", timeoutMs: 500 });

    expect(result).toEqual({
      status: "error",
      error: "gateway closed (1006): transport close",
    });
    expect(isRecoverableAgentWaitError(result.error)).toBe(true);
  });

  it("preserves pending agent.wait status", async () => {
    callGatewayMock.mockResolvedValue({ status: "pending" });

    const result = await waitForAgentRun({ runId: "run-pending", timeoutMs: 500 });

    expect(result).toEqual({ status: "pending" });
  });

  it("preserves pending error diagnostics on wait timeouts", async () => {
    callGatewayMock.mockResolvedValue({
      status: "timeout",
      error: "429 RESOURCE_EXHAUSTED",
      pendingError: true,
    });

    const result = await waitForAgentRun({ runId: "run-pending-error", timeoutMs: 500 });

    expect(result).toEqual({
      status: "timeout",
      error: "429 RESOURCE_EXHAUSTED",
      pendingError: true,
    });
  });

  it("normalizes wait timeouts before sending agent.wait", async () => {
    callGatewayMock.mockResolvedValue({ status: "ok" });

    const result = await waitForAgentRun({ runId: "run-clamped", timeoutMs: 0.8 });

    expect(result).toEqual({ status: "ok" });
    expect(callGatewayMock).toHaveBeenCalledWith({
      method: "agent.wait",
      params: {
        runId: "run-clamped",
        timeoutMs: 1,
      },
      timeoutMs: 2_001,
    });
  });

  it("defaults non-finite wait timeouts before sending agent.wait", async () => {
    callGatewayMock.mockResolvedValue({ status: "ok" });

    const result = await waitForAgentRun({ runId: "run-nan", timeoutMs: Number.NaN });

    expect(result).toEqual({ status: "ok" });
    expect(callGatewayMock).toHaveBeenCalledWith({
      method: "agent.wait",
      params: {
        runId: "run-nan",
        timeoutMs: 1,
      },
      timeoutMs: 2_001,
    });
  });

  it("caps oversized wait timeouts before sending agent.wait", async () => {
    callGatewayMock.mockResolvedValue({ status: "ok" });

    const result = await waitForAgentRun({
      runId: "run-huge",
      timeoutMs: Number.MAX_VALUE,
    });

    expect(result).toEqual({ status: "ok" });
    expect(callGatewayMock).toHaveBeenCalledWith({
      method: "agent.wait",
      params: {
        runId: "run-huge",
        timeoutMs: MAX_TIMER_TIMEOUT_MS,
      },
      timeoutMs: MAX_TIMER_TIMEOUT_MS,
    });
  });

  it("preserves timing metadata on provider-attributed wait timeouts", async () => {
    callGatewayMock.mockResolvedValue({
      status: "ok",
      startedAt: 100,
      endedAt: 200,
      timeoutPhase: "provider",
      providerStarted: true,
    });

    const result = await waitForAgentRun({ runId: "run-2", timeoutMs: 500 });

    expect(result).toEqual({
      status: "timeout",
      startedAt: 100,
      endedAt: 200,
      timeoutPhase: "provider",
      providerStarted: true,
    });
  });

  it("keeps hard wait timeouts stronger than blocked liveness", async () => {
    callGatewayMock.mockResolvedValue({
      status: "error",
      error: "model timed out",
      livenessState: "blocked",
      timeoutPhase: "provider",
      providerStarted: true,
    });

    const result = await waitForAgentRun({ runId: "run-blocked-timeout", timeoutMs: 500 });

    expect(result).toEqual({
      status: "timeout",
      error: "model timed out",
      livenessState: "blocked",
      timeoutPhase: "provider",
      providerStarted: true,
    });
  });

  it("normalizes blocked ok waits to errors", async () => {
    callGatewayMock.mockResolvedValue({
      status: "ok",
      startedAt: 100,
      endedAt: 200,
      livenessState: "blocked",
      error: "Context overflow: prompt too large for the model.",
    });

    const result = await waitForAgentRun({ runId: "run-blocked", timeoutMs: 500 });

    expect(result).toEqual({
      status: "error",
      error: "Context overflow: prompt too large for the model.",
      startedAt: 100,
      endedAt: 200,
      livenessState: "blocked",
    });
  });

  it("normalizes aborted stop reasons to errors even when gateway reports ok", async () => {
    callGatewayMock.mockResolvedValue({
      status: "ok",
      startedAt: 100,
      endedAt: 200,
      stopReason: "aborted",
    });

    const result = await waitForAgentRun({ runId: "run-aborted", timeoutMs: 500 });

    expect(result).toEqual({
      status: "error",
      error: "agent run aborted",
      startedAt: 100,
      endedAt: 200,
      stopReason: "aborted",
    });
  });
});

describe("waitForAgentRunAndReadUpdatedAssistantReply", () => {
  beforeEach(() => {
    callGatewayMock.mockClear();
    testing.setDepsForTest({
      callGateway: async (opts) => await callGatewayMock(opts),
    });
  });

  it("returns undefined when the latest assistant fingerprint matches the baseline", async () => {
    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "same reply" }],
      timestamp: 42,
    };
    callGatewayMock
      .mockResolvedValueOnce({
        status: "ok",
      })
      .mockResolvedValueOnce({
        messages: [assistantMessage],
      });

    const result = await waitForAgentRunAndReadUpdatedAssistantReply({
      runId: "run-1",
      sessionKey: "agent:main:child",
      timeoutMs: 1_000,
      baseline: {
        text: "same reply",
        fingerprint: JSON.stringify(assistantMessage),
      },
    });

    expect(result).toEqual({
      status: "ok",
      replyText: undefined,
    });
  });

  it("returns the new assistant text when the fingerprint changes", async () => {
    callGatewayMock
      .mockResolvedValueOnce({
        status: "ok",
      })
      .mockResolvedValueOnce({
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "fresh reply" }],
            timestamp: 99,
          },
        ],
      });

    const result = await waitForAgentRunAndReadUpdatedAssistantReply({
      runId: "run-2",
      sessionKey: "agent:main:child",
      timeoutMs: 1_000,
      baseline: {
        text: "older reply",
        fingerprint: "old-fingerprint",
      },
    });

    expect(result).toEqual({
      status: "ok",
      replyText: "fresh reply",
    });
  });
});

describe("waitForAgentRunsToDrain", () => {
  beforeEach(() => {
    callGatewayMock.mockClear();
    testing.setDepsForTest({
      callGateway: async (opts) => await callGatewayMock(opts),
    });
  });

  it("waits across rounds until descendant runs stop changing", async () => {
    let activeRunIds = ["run-1"];
    callGatewayMock.mockImplementation(async (opts) => {
      const request = opts as { method?: string; params?: { runId?: string } };
      if (request.method !== "agent.wait") {
        throw new Error(`unexpected method: ${String(request.method)}`);
      }
      if (request.params?.runId === "run-1") {
        activeRunIds = ["run-2"];
      } else if (request.params?.runId === "run-2") {
        activeRunIds = [];
      }
      return { status: "ok" };
    });

    const result = await waitForAgentRunsToDrain({
      timeoutMs: 1_000,
      getPendingRunIds: () => activeRunIds,
    });

    expect(result.timedOut).toBe(false);
    expect(result.pendingRunIds).toStrictEqual([]);
    expectNumber(result.deadlineAtMs, "deadlineAtMs");

    const requests = gatewayWaitRequests();
    expect(requests).toHaveLength(2);
    expectAgentWaitRequest(requireRequestAt(requests, 0), "run-1", 1_000);
    expectAgentWaitRequest(requireRequestAt(requests, 1), "run-2", 1_000);
  });

  it("deduplicates and trims pending run ids", async () => {
    callGatewayMock.mockResolvedValue({ status: "ok" });
    let activeRunIds = [" run-1 ", "run-1", "", "run-2"];

    const result = await waitForAgentRunsToDrain({
      timeoutMs: 1_000,
      getPendingRunIds: () => {
        const current = activeRunIds;
        activeRunIds = [];
        return current;
      },
    });

    expect(result.timedOut).toBe(false);
    expect(callGatewayMock.mock.calls).toHaveLength(2);
  });

  it("keeps the initial pending run ids before refreshing", async () => {
    callGatewayMock.mockResolvedValue({ status: "ok" });
    let activeRunIds = ["run-2"];

    const result = await waitForAgentRunsToDrain({
      timeoutMs: 1_000,
      initialPendingRunIds: ["run-1"],
      getPendingRunIds: () => {
        const current = activeRunIds;
        activeRunIds = [];
        return current;
      },
    });

    expect(result.timedOut).toBe(false);
    const requests = gatewayWaitRequests();
    expect(requests).toHaveLength(2);
    expectAgentWaitRequest(requireRequestAt(requests, 0), "run-1", 1_000);
    expectAgentWaitRequest(requireRequestAt(requests, 1), "run-2", 1_000);
  });

  it("defaults non-finite drain timeouts before computing the deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-30T00:00:00Z"));
    callGatewayMock.mockResolvedValue({ status: "ok" });
    let activeRunIds = ["run-1"];

    try {
      const result = await waitForAgentRunsToDrain({
        timeoutMs: Number.NaN,
        getPendingRunIds: () => {
          const current = activeRunIds;
          activeRunIds = [];
          return current;
        },
      });

      expect(result.timedOut).toBe(false);
      expect(Number.isFinite(result.deadlineAtMs)).toBe(true);
      expectAgentWaitRequest(requireRequestAt(gatewayWaitRequests(), 0), "run-1", 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out immediately when the computed drain deadline exceeds the Date range", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(MAX_DATE_TIMESTAMP_MS));
    try {
      const result = await waitForAgentRunsToDrain({
        timeoutMs: 1,
        getPendingRunIds: () => ["run-1"],
      });

      expect(result).toEqual({
        timedOut: true,
        pendingRunIds: ["run-1"],
        deadlineAtMs: MAX_DATE_TIMESTAMP_MS,
      });
      expect(callGatewayMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores invalid caller-supplied drain deadlines", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-30T00:00:00Z"));
    try {
      const result = await waitForAgentRunsToDrain({
        deadlineAtMs: Number.POSITIVE_INFINITY,
        getPendingRunIds: () => ["run-1"],
      });

      expect(result.timedOut).toBe(true);
      expect(result.pendingRunIds).toStrictEqual(["run-1"]);
      expect(result.deadlineAtMs).toBe(Date.now());
      expect(callGatewayMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
