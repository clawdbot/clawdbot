/**
 * Regression coverage for gateway-backed agent run waiting.
 * Exercises timeout normalization, run-owned replies, and dynamic drain loops.
 */
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
  readLatestAssistantReply,
  waitForAgentRun,
  waitForAgentRunsToDrain,
  waitForAgentRunReply,
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
    callGatewayMock.mockReset();
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

  it("skips trailing transcript-only OpenClaw assistant mirrors for normal latest-reply reads", async () => {
    callGatewayMock.mockResolvedValue({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "real worker reply" }],
          timestamp: 10,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "already delivered through message tool" }],
          openclawMessageToolMirror: {
            toolName: "message",
            toolCallId: "call-message-send",
          },
          timestamp: 11,
        },
        {
          role: "assistant",
          provider: "openclaw",
          model: "gateway-injected",
          content: [{ type: "text", text: "gateway notice" }],
          timestamp: 12,
        },
      ],
    });

    const result = await readLatestAssistantReply({ sessionKey: "agent:main:child" });

    expect(result).toBe("real worker reply");
  });

  it("skips trailing inter-session input rows for normal latest-reply reads", async () => {
    callGatewayMock.mockResolvedValue({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "older worker reply" }],
          timestamp: 10,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "forwarded sessions_send prompt" }],
          provenance: {
            kind: "inter_session",
            sourceSessionKey: "agent:main:source",
            sourceTool: "sessions_send",
          },
          timestamp: 11,
        },
      ],
    });

    const result = await readLatestAssistantReply({ sessionKey: "agent:main:target" });

    expect(result).toBe("older worker reply");
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
    callGatewayMock.mockReset();
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
      retryableTransportError: true,
    });
  });

  it.each([
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EPIPE",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "EAI_AGAIN",
    "UND_ERR_SOCKET",
  ])("records %s recovery only when the wait RPC rejects", async (code) => {
    const error = `connect ${code} 127.0.0.1:443`;
    callGatewayMock.mockResolvedValueOnce({
      status: "error",
      error,
      retryableTransportError: true,
    });
    const terminal = await waitForAgentRun({ runId: "run-terminal", timeoutMs: 500 });
    expect(terminal).toMatchObject({ status: "error", error });
    expect(terminal).not.toHaveProperty("retryableTransportError");

    callGatewayMock.mockRejectedValueOnce(new Error(error));
    await expect(waitForAgentRun({ runId: "run-disconnected", timeoutMs: 500 })).resolves.toEqual({
      status: "error",
      error,
      retryableTransportError: true,
    });
  });

  it.each([
    undefined,
    "",
    "gateway timeout",
    "gateway request timeout for agent.wait",
    "ENOENT: no such file",
    "getaddrinfo ENOTFOUND gateway.example.com",
  ])("does not mark a nonrecoverable rejected wait RPC: %s", async (error) => {
    callGatewayMock.mockRejectedValueOnce(new Error(error));
    const result = await waitForAgentRun({ runId: "run-unrecoverable", timeoutMs: 500 });
    expect(result).not.toHaveProperty("retryableTransportError");
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

  it("carries a bounded terminal reply snapshot from agent.wait", async () => {
    callGatewayMock.mockResolvedValue({
      status: "ok",
      terminalReply: { disposition: "visible", text: "final reply" },
    });

    await expect(waitForAgentRun({ runId: "run-reply", timeoutMs: 500 })).resolves.toEqual({
      status: "ok",
      terminalReply: { disposition: "visible", text: "final reply" },
    });
  });

  it.each([
    { name: "confirmed final source reply", sourceReplyDelivered: true, expected: true },
    { name: "progress-only reply", sourceReplyDelivered: false, expected: undefined },
    { name: "another destination", sourceReplyDelivered: undefined, expected: undefined },
    { name: "non-boolean marker", sourceReplyDelivered: "true", expected: undefined },
    {
      name: "another run",
      sourceReplyDelivered: true,
      receiptRunId: "run-other",
      expected: undefined,
    },
  ])("accepts source delivery evidence only for the waited run: $name", async (entry) => {
    callGatewayMock.mockResolvedValue({
      status: "ok",
      terminalReceipt: {
        runId: entry.receiptRunId ?? "run-source-reply",
        sessionId: "session-source",
        turnId: "turn-source",
        requested: { provider: "openai", model: "gpt-5.6-luna" },
        effective: {
          provider: "openai",
          model: "gpt-5.6-luna",
          responseModel: "gpt-5.6-luna",
        },
        successfulToolNames: ["message"],
        rerouted: false,
        terminalDisposition: "visible",
        sourceReplyDelivered: entry.sourceReplyDelivered,
      },
    });

    const result = await waitForAgentRun({ runId: "run-source-reply", timeoutMs: 500 });

    expect(result.sourceReplyDelivered).toBe(entry.expected);
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

describe("waitForAgentRunReply", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
  });

  it("returns the run's reply and metadata without consulting unrelated session history", async () => {
    callGatewayMock.mockImplementation(async (request) => {
      if (request.method !== "agent.wait") {
        throw new Error("session history is not delivery evidence");
      }
      return {
        status: "ok",
        startedAt: 100,
        endedAt: 200,
        stopReason: "completed",
        yielded: true,
        providerStarted: true,
        terminalReply: { disposition: "visible", text: "authoritative reply" },
      };
    });

    const result = await waitForAgentRunReply({
      runId: "run-visible-terminal-reply",
      timeoutMs: 1_000,
    });

    expect(result).toEqual({
      status: "ok",
      startedAt: 100,
      endedAt: 200,
      stopReason: "completed",
      yielded: true,
      providerStarted: true,
      terminalReply: { disposition: "visible", text: "authoritative reply" },
      replyText: "authoritative reply",
    });
    expect(callGatewayMock.mock.calls.map(([request]) => request.method)).toEqual(["agent.wait"]);
  });

  it.each([
    { name: "silent", terminalReply: { disposition: "silent" } },
    { name: "empty", terminalReply: { disposition: "empty" } },
    { name: "missing", terminalReply: undefined },
  ])("does not resurrect history for a $name terminal reply", async ({ terminalReply }) => {
    callGatewayMock.mockImplementation(async (request) => {
      if (request.method !== "agent.wait") {
        throw new Error("history must not override terminal reply evidence");
      }
      return { status: "ok", terminalReply };
    });

    const result = await waitForAgentRunReply({ runId: "run-no-reply", timeoutMs: 1_000 });

    expect(result).toEqual({ status: "ok", terminalReply });
    expect(result.replyText).toBeUndefined();
    expect(callGatewayMock.mock.calls.map(([request]) => request.method)).toEqual(["agent.wait"]);
  });

  it.each(["timeout", "error", "pending"] as const)(
    "does not return visible text from a run whose status is %s",
    async (status) => {
      callGatewayMock.mockResolvedValue({
        status,
        terminalReply: { disposition: "visible", text: "unfinished reply" },
      });

      const result = await waitForAgentRunReply({ runId: "run-unfinished", timeoutMs: 1_000 });

      expect(result.status).toBe(status);
      expect(result.replyText).toBeUndefined();
      expect(callGatewayMock).toHaveBeenCalledOnce();
    },
  );
});

describe("waitForAgentRunsToDrain", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
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
