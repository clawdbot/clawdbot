import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCliDispatchTranscriptRecorder } from "./cli-backend-dispatch-transcript.js";

const appendTranscriptMessage = vi.hoisted(() => vi.fn());

vi.mock("../../config/sessions/session-accessor.js", () => ({
  appendTranscriptMessage,
}));

type AppendedRecord = {
  scope: Record<string, unknown>;
  message: Record<string, unknown>;
};

function appendedRecords(): AppendedRecord[] {
  return appendTranscriptMessage.mock.calls.map((call) => ({
    scope: call[0] as Record<string, unknown>,
    message: (call[1] as { message: Record<string, unknown> }).message,
  }));
}

function recorderParams() {
  return {
    sessionId: "recall-session",
    sessionKey: "agent:main:recall",
    agentId: "main",
    sessionFile: "sqlite://agents/main/recall-session",
    runId: "run-transcript-test",
    prompt: "recall prompt",
    provider: "claude-cli",
    model: "claude-opus-4-8",
  };
}

beforeEach(() => {
  appendTranscriptMessage.mockReset();
  appendTranscriptMessage.mockResolvedValue({ appended: true, message: {}, messageId: "m" });
});

describe("createCliDispatchTranscriptRecorder", () => {
  it("appends the user turn to the run's session identity", async () => {
    const recorder = createCliDispatchTranscriptRecorder(recorderParams());
    await recorder.finalize();

    const records = appendedRecords();
    expect(records[0]?.scope).toMatchObject({
      sessionId: "recall-session",
      sessionKey: "agent:main:recall",
      agentId: "main",
      sessionFile: "sqlite://agents/main/recall-session",
    });
    expect(records[0]?.message).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "recall prompt" }],
    });
  });

  it("mirrors tool calls and results in the shapes the recall parsers accept", async () => {
    const recorder = createCliDispatchTranscriptRecorder(recorderParams());
    recorder.noteToolEvent({
      phase: "start",
      toolName: "memory_search",
      toolCallId: "call-1",
      args: { query: "wings" },
    });
    recorder.noteToolEvent({
      phase: "result",
      toolName: "memory_search",
      toolCallId: "call-1",
      result: {
        content: [{ type: "text", text: '{"results":[{"id":"m1"}]}' }],
        details: { results: [{ id: "m1" }], debug: { backend: "builtin", hits: 1 } },
      },
      isError: false,
    });
    await recorder.finalize("Lemon pepper.");

    const messages = appendedRecords().map((record) => record.message);
    expect(messages[1]).toMatchObject({
      role: "assistant",
      content: [
        { type: "toolCall", id: "call-1", name: "memory_search", arguments: { query: "wings" } },
      ],
      stopReason: "toolUse",
    });
    // The toolResult shape is what active-memory's transcript readers parse:
    // role/toolName gate the record; details/content decide usable-vs-unavailable.
    expect(messages[2]).toMatchObject({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "memory_search",
      content: [{ type: "text", text: '{"results":[{"id":"m1"}]}' }],
      details: { results: [{ id: "m1" }], debug: { backend: "builtin", hits: 1 } },
      isError: false,
    });
    expect(messages[3]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Lemon pepper." }],
      stopReason: "stop",
    });
  });

  it("keeps bare-array tool_result content as claude stream-json echoes it", async () => {
    // Live claude -p runs deliver MCP tool results as `block.content` — a bare
    // content-block array with no {content} wrapper. Dropping it made every
    // successful recall classify as no_relevant_memory.
    const recorder = createCliDispatchTranscriptRecorder(recorderParams());
    recorder.noteToolEvent({
      phase: "start",
      toolName: "memory_search",
      toolCallId: "call-1",
      args: { query: "copperfin" },
    });
    recorder.noteToolEvent({
      phase: "result",
      toolName: "memory_search",
      toolCallId: "call-1",
      result: [{ type: "text", text: '{"results":[{"path":"MEMORY.md"}]}' }],
      isError: false,
    });
    await recorder.finalize("Port 4173.");

    const messages = appendedRecords().map((record) => record.message);
    expect(messages[2]).toMatchObject({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "memory_search",
      content: [{ type: "text", text: '{"results":[{"path":"MEMORY.md"}]}' }],
      isError: false,
    });
  });

  it("appends tool records incrementally for the live terminal-search watcher", async () => {
    const recorder = createCliDispatchTranscriptRecorder(recorderParams());
    recorder.noteToolEvent({
      phase: "result",
      toolName: "memory_search",
      result: { content: [], details: { status: "unavailable", error: "backend offline" } },
      isError: true,
    });
    // No finalize yet: the record must be written mid-run.
    await vi.waitFor(() => {
      expect(appendedRecords().some((record) => record.message.role === "toolResult")).toBe(true);
    });
    const toolResult = appendedRecords().find(
      (record) => record.message.role === "toolResult",
    )?.message;
    expect(toolResult).toMatchObject({
      toolName: "memory_search",
      details: { status: "unavailable", error: "backend offline" },
      isError: true,
    });
    await recorder.finalize();
  });

  it("flushes the last streamed assistant snapshot when no final text exists", async () => {
    const recorder = createCliDispatchTranscriptRecorder(recorderParams());
    recorder.noteAssistantText("partial an");
    recorder.noteAssistantText("partial answer before timeout");
    await recorder.finalize(undefined);

    const assistant = appendedRecords().find(
      (record) => record.message.role === "assistant",
    )?.message;
    expect(assistant).toMatchObject({
      content: [{ type: "text", text: "partial answer before timeout" }],
    });
  });

  it("flushes the latest snapshot on abort and does not duplicate it at finalize", async () => {
    const recorder = createCliDispatchTranscriptRecorder(recorderParams());
    recorder.noteAssistantText("partial before kill");
    recorder.flushAssistantSnapshot();
    await vi.waitFor(() => {
      expect(
        appendedRecords().filter((record) => record.message.role === "assistant"),
      ).toHaveLength(1);
    });
    // The killed child settles later; finalize with the same text must not
    // append a duplicate record.
    await recorder.finalize(undefined);
    const assistants = appendedRecords().filter((record) => record.message.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0]?.message).toMatchObject({
      content: [{ type: "text", text: "partial before kill" }],
      stopReason: "aborted",
    });
  });

  it("writes a newer final text after an abort flush", async () => {
    const recorder = createCliDispatchTranscriptRecorder(recorderParams());
    recorder.noteAssistantText("partial");
    recorder.flushAssistantSnapshot();
    await recorder.finalize("full final answer");
    const assistants = appendedRecords().filter((record) => record.message.role === "assistant");
    expect(assistants).toHaveLength(2);
    expect(assistants[1]?.message).toMatchObject({
      content: [{ type: "text", text: "full final answer" }],
      stopReason: "stop",
    });
  });

  it("survives append failures without failing the run or later appends", async () => {
    appendTranscriptMessage.mockRejectedValueOnce(new Error("store unavailable"));
    const recorder = createCliDispatchTranscriptRecorder(recorderParams());
    recorder.noteToolEvent({ phase: "result", toolName: "memory_search", isError: false });
    await expect(recorder.finalize("text")).resolves.toBeUndefined();
    // The user-turn append failed; the tool and assistant records still land.
    expect(appendedRecords().some((record) => record.message.role === "toolResult")).toBe(true);
    expect(appendedRecords().some((record) => record.message.role === "assistant")).toBe(true);
  });
});
