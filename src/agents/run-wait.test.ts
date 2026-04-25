import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.fn();
vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

import {
  __testing,
  isRecoverableAgentWaitError,
  readLatestAssistantReply,
  readLatestAssistantReplySnapshot,
  waitForAgentRun,
  waitForAgentRunsToDrain,
  waitForAgentRunAndReadUpdatedAssistantReply,
} from "./run-wait.js";

describe("readLatestAssistantReply", () => {
  beforeEach(() => {
    callGatewayMock.mockClear();
    __testing.setDepsForTest({
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
    __testing.setDepsForTest({
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

  it("preserves timing metadata from agent.wait", async () => {
    callGatewayMock.mockResolvedValue({
      status: "ok",
      startedAt: 100,
      endedAt: 200,
    });

    const result = await waitForAgentRun({ runId: "run-2", timeoutMs: 500 });

    expect(result).toEqual({
      status: "ok",
      startedAt: 100,
      endedAt: 200,
    });
  });
});

describe("waitForAgentRunAndReadUpdatedAssistantReply", () => {
  beforeEach(() => {
    callGatewayMock.mockClear();
    __testing.setDepsForTest({
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
    __testing.setDepsForTest({
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

    expect(result).toEqual({
      timedOut: false,
      pendingRunIds: [],
      deadlineAtMs: expect.any(Number),
    });
    expect(callGatewayMock.mock.calls.map((call) => call[0])).toEqual([
      {
        method: "agent.wait",
        params: {
          runId: "run-1",
          timeoutMs: expect.any(Number),
        },
        timeoutMs: expect.any(Number),
      },
      {
        method: "agent.wait",
        params: {
          runId: "run-2",
          timeoutMs: expect.any(Number),
        },
        timeoutMs: expect.any(Number),
      },
    ]);
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
    expect(callGatewayMock.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({
        method: "agent.wait",
        params: expect.objectContaining({ runId: "run-1" }),
      }),
      expect.objectContaining({
        method: "agent.wait",
        params: expect.objectContaining({ runId: "run-2" }),
      }),
    ]);
  });
});
