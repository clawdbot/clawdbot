/**
 * Regression coverage for gateway-backed agent run waiting.
 * Exercises timeout normalization, reply snapshots, and dynamic drain loops.
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

  it("stops at trailing transcript artifacts for waited reply extraction", async () => {
    callGatewayMock.mockResolvedValue({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "older worker reply" }],
          timestamp: 10,
        },
        {
          role: "assistant",
          provider: "openclaw",
          model: "gateway-injected",
          content: [{ type: "text", text: "gateway notice" }],
          timestamp: 11,
        },
      ],
    });

    const result = await readLatestAssistantReplySnapshot({
      sessionKey: "agent:main:target",
      stopAtTranscriptArtifact: true,
    });

    expect(result).toEqual({});
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
    callGatewayMock.mockReset();
  });

  type TranscriptMessage = Record<string, unknown>;
  type WaitedReplyCase = {
    name: string;
    runId: string;
    messages: TranscriptMessage[];
    expected: Record<string, unknown>;
    baseline?: { text?: string; fingerprint?: string };
    sessionKey?: string;
    wait?: Record<string, unknown>;
  };

  const assistant = (text: string, metadata: TranscriptMessage = {}): TranscriptMessage => ({
    role: "assistant",
    content: [{ type: "text", text }],
    ...metadata,
  });
  const interSession = (text: string, metadata: TranscriptMessage = {}): TranscriptMessage =>
    assistant(text, {
      provenance: {
        kind: "inter_session",
        sourceSessionKey: "agent:main:source",
        sourceTool: "sessions_send",
      },
      ...metadata,
    });
  const messageToolMirror = (
    text: string,
    mirror: TranscriptMessage,
    metadata: TranscriptMessage = {},
  ): TranscriptMessage =>
    assistant(text, {
      openclawMessageToolMirror: { toolName: "message", ...mirror },
      ...metadata,
    });

  const sameReply = assistant("same reply", { timestamp: 42 });
  const previousReply = assistant("previous real reply", { timestamp: 41 });
  const forwardedRequest = interSession("forwarded request", {
    __openclaw: { seq: 41 },
    timestamp: 41,
  });
  const pendingSourceReply = messageToolMirror(
    "source reply awaiting delivery",
    {
      toolCallId: "call-message-send",
      sourceReplySink: "internal-ui",
      sourceMessageSeq: 42,
    },
    { timestamp: 42 },
  );
  const olderBaseline = { text: "older reply", fingerprint: "old-fingerprint" };

  const cases: WaitedReplyCase[] = [
    {
      name: "returns undefined when the latest assistant fingerprint matches the baseline",
      runId: "run-1",
      messages: [sameReply],
      baseline: { text: "same reply", fingerprint: JSON.stringify(sameReply) },
      expected: { status: "ok", replyText: undefined },
    },
    {
      name: "returns undefined when a text-only baseline matches the latest assistant reply",
      runId: "run-text-baseline",
      messages: [sameReply],
      baseline: { text: "same reply" },
      expected: { status: "ok", replyText: undefined },
    },
    {
      name: "does not treat a message-tool delivery mirror as a new waited reply",
      runId: "run-source-reply",
      messages: [
        previousReply,
        assistant("already delivered source reply", {
          provider: "openclaw",
          model: "delivery-mirror",
          timestamp: 42,
        }),
      ],
      baseline: { text: "previous real reply", fingerprint: JSON.stringify(previousReply) },
      expected: { status: "ok", replyText: undefined },
    },
    {
      name: "does not treat a projected message-tool mirror as a new waited reply",
      runId: "run-projected-source-reply",
      messages: [
        previousReply,
        messageToolMirror(
          "already delivered source reply",
          { toolCallId: "call-message-send" },
          { timestamp: 42 },
        ),
      ],
      baseline: { text: "previous real reply", fingerprint: JSON.stringify(previousReply) },
      expected: { status: "ok", replyText: undefined },
    },
    {
      name: "returns a projected message-tool reply held for outer A2A delivery",
      runId: "run-internal-source-reply",
      sessionKey: "agent:worker:main",
      messages: [forwardedRequest, pendingSourceReply],
      expected: { status: "ok", replyText: "source reply awaiting delivery" },
    },
    {
      name: "prefers an internal source reply over a later private final",
      runId: "run-internal-source-reply-with-private-final",
      sessionKey: "agent:worker:main",
      messages: [forwardedRequest, pendingSourceReply, assistant("Done", { timestamp: 43 })],
      expected: { status: "ok", replyText: "source reply awaiting delivery" },
    },
    {
      name: "does not let a late internal result cross an inter-session turn boundary",
      runId: "run-after-late-internal-source-reply",
      sessionKey: "agent:worker:main",
      messages: [
        interSession("new forwarded request", { __openclaw: { seq: 42 }, timestamp: 42 }),
        messageToolMirror(
          "stale source reply",
          {
            toolCallId: "call-message-before-request",
            sourceReplySink: "internal-ui",
            sourceMessageSeq: 41,
          },
          { timestamp: 41 },
        ),
        assistant("fresh reply", { timestamp: 43 }),
      ],
      expected: { status: "ok", replyText: "fresh reply" },
    },
    {
      name: "does not return a private final written after a message-tool delivery mirror",
      runId: "run-source-reply-with-private-final",
      messages: [
        interSession("forwarded request", { timestamp: 41 }),
        messageToolMirror(
          "already delivered source reply",
          { toolCallId: "call-message-send" },
          { timestamp: 42 },
        ),
        assistant("Done", { timestamp: 43 }),
      ],
      expected: { status: "ok", replyText: undefined },
    },
    {
      name: "does not let an older turn's message-tool mirror suppress a fresh reply",
      runId: "run-after-older-source-reply",
      messages: [
        messageToolMirror(
          "older delivered reply",
          { toolCallId: "call-older-message-send" },
          { timestamp: 40 },
        ),
        interSession("new forwarded request", { timestamp: 41 }),
        assistant("fresh reply", { timestamp: 42 }),
      ],
      expected: { status: "ok", replyText: "fresh reply" },
    },
    {
      name: "does not resurrect an older reply when only a delivery mirror is newer",
      runId: "run-source-reply-without-baseline",
      messages: [
        assistant("stale previous reply", { timestamp: 41 }),
        assistant("already delivered source reply", {
          provider: "openclaw",
          model: "delivery-mirror",
          timestamp: 42,
        }),
      ],
      expected: { status: "ok", replyText: undefined },
    },
    {
      name: "returns the new assistant text when the fingerprint changes",
      runId: "run-2",
      messages: [assistant("fresh reply", { timestamp: 99 })],
      baseline: olderBaseline,
      expected: { status: "ok", replyText: "fresh reply" },
    },
    {
      name: "preserves successful wait metadata when returning an updated reply",
      runId: "run-with-metadata",
      messages: [assistant("fresh reply", { timestamp: 99 })],
      baseline: olderBaseline,
      wait: {
        status: "ok",
        startedAt: 100,
        endedAt: 200,
        stopReason: "completed",
        yielded: true,
        providerStarted: true,
      },
      expected: {
        status: "ok",
        startedAt: 100,
        endedAt: 200,
        stopReason: "completed",
        yielded: true,
        providerStarted: true,
        replyText: "fresh reply",
      },
    },
  ];

  it.each(cases)("$name", async ({ runId, messages, expected, baseline, sessionKey, wait }) => {
    callGatewayMock
      .mockResolvedValueOnce(wait ?? { status: "ok" })
      .mockResolvedValueOnce({ messages });

    const result = await waitForAgentRunAndReadUpdatedAssistantReply({
      runId,
      sessionKey: sessionKey ?? "agent:main:child",
      timeoutMs: 1_000,
      baseline,
    });

    expect(result).toEqual(expected);
    expect(callGatewayMock.mock.calls.map(([request]) => request.method)).toEqual([
      "agent.wait",
      "chat.history",
    ]);
  });

  it("returns an authoritative visible terminal reply without reading history", async () => {
    callGatewayMock.mockImplementation(async (request) => {
      if (request.method === "agent.wait") {
        return {
          status: "ok",
          terminalReply: { disposition: "visible", text: "authoritative reply" },
        };
      }
      throw new Error("history unavailable");
    });

    const result = await waitForAgentRunAndReadUpdatedAssistantReply({
      runId: "run-visible-terminal-reply",
      sessionKey: "agent:main:child",
      timeoutMs: 1_000,
    });

    expect(result).toEqual({
      status: "ok",
      terminalReply: { disposition: "visible", text: "authoritative reply" },
      replyText: "authoritative reply",
    });
    expect(callGatewayMock.mock.calls.map(([request]) => request.method)).toEqual(["agent.wait"]);
  });

  it.each(["silent", "empty"] as const)(
    "does not resurrect transcript text after an authoritative %s terminal reply",
    async (disposition) => {
      callGatewayMock.mockImplementation(async (request) => {
        if (request.method === "agent.wait") {
          return { status: "ok", terminalReply: { disposition } };
        }
        throw new Error("history must not override terminal reply evidence");
      });

      const result = await waitForAgentRunAndReadUpdatedAssistantReply({
        runId: `run-${disposition}-terminal-reply`,
        sessionKey: "agent:main:child",
        timeoutMs: 1_000,
        baseline: { text: "older reply" },
      });

      expect(result).toEqual({ status: "ok", terminalReply: { disposition } });
      expect(callGatewayMock.mock.calls.map(([request]) => request.method)).toEqual(["agent.wait"]);
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
