import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPendingToolResultsAfterIdle } from "./pi-embedded-runner/wait-for-idle-before-flush.js";
import { guardSessionManager } from "./session-tool-result-guard-wrapper.js";

function assistantToolCall(id: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name: "exec", arguments: {} }],
    stopReason: "toolUse",
  } as AgentMessage;
}

function toolResult(id: string, text: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    content: [{ type: "text", text }],
    isError: false,
  } as AgentMessage;
}

function deferred<T>() {
  let resolve: ((value: T | PromiseLike<T>) => void) | undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  if (!resolve) {
    throw new Error("Expected wait-for-idle deferred resolver to be initialized");
  }
  return { promise, resolve };
}

function getMessages(sm: ReturnType<typeof guardSessionManager>): AgentMessage[] {
  return sm
    .getEntries()
    .filter((e) => e.type === "message")
    .map((e) => (e as { message: AgentMessage }).message);
}

describe("flushPendingToolResultsAfterIdle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for idle so real tool results can land before flush", async () => {
    const sm = guardSessionManager(SessionManager.inMemory());
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;
    const idle = deferred<void>();
    const agent = { waitForIdle: () => idle.promise };

    appendMessage(assistantToolCall("call_retry_1"));
    const flushPromise = flushPendingToolResultsAfterIdle({
      agent,
      sessionManager: sm,
      timeoutMs: 1_000,
    });

    // Flush is waiting for idle; synthetic result must not appear yet.
    await Promise.resolve();
    expect(getMessages(sm).map((m) => m.role)).toEqual(["assistant"]);

    // Tool completes before idle wait finishes.
    appendMessage(toolResult("call_retry_1", "command output here"));
    idle.resolve();
    await flushPromise;

    const messages = getMessages(sm);
    expect(messages.map((m) => m.role)).toEqual(["assistant", "toolResult"]);
    expect((messages[1] as { isError?: boolean }).isError).not.toBe(true);
    expect((messages[1] as { content?: Array<{ text?: string }> }).content?.[0]?.text).toBe(
      "command output here",
    );
  });

  it("flushes pending tool call after timeout when idle never resolves", async () => {
    const sm = guardSessionManager(SessionManager.inMemory());
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;
    vi.useFakeTimers();
    const agent = { waitForIdle: () => new Promise<void>(() => {}) };

    appendMessage(assistantToolCall("call_orphan_1"));

    const flushPromise = flushPendingToolResultsAfterIdle({
      agent,
      sessionManager: sm,
      timeoutMs: 30,
    });
    await vi.advanceTimersByTimeAsync(30);
    await flushPromise;

    const entries = getMessages(sm);

    expect(entries.length).toBe(2);
    expect(entries[1].role).toBe("toolResult");
    expect((entries[1] as { isError?: boolean }).isError).toBe(true);
    expect((entries[1] as { content?: Array<{ text?: string }> }).content?.[0]?.text).toContain(
      "missing tool result",
    );
  });

  it("flushes pending on cleanup timeout instead of leaving orphaned tool calls", async () => {
    const sm = guardSessionManager(SessionManager.inMemory());
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;
    vi.useFakeTimers();
    const agent = { waitForIdle: () => new Promise<void>(() => {}) };

    appendMessage(assistantToolCall("call_orphan_2"));

    const flushPromise = flushPendingToolResultsAfterIdle({
      agent,
      sessionManager: sm,
      timeoutMs: 30,
    });
    await vi.advanceTimersByTimeAsync(30);
    await flushPromise;

    const messages = getMessages(sm);
    expect(messages.map((m) => m.role)).toEqual(["assistant", "toolResult"]);
    expect((messages[1] as { toolCallId?: string }).toolCallId).toBe("call_orphan_2");
    expect((messages[1] as { isError?: boolean }).isError).toBe(true);

    appendMessage({
      role: "user",
      content: "still there?",
      timestamp: Date.now(),
    } as AgentMessage);
    expect(getMessages(sm).map((m) => m.role)).toEqual(["assistant", "toolResult", "user"]);
  });

  it("clears timeout handle when waitForIdle resolves first", async () => {
    const sm = guardSessionManager(SessionManager.inMemory());
    vi.useFakeTimers();
    const agent = {
      waitForIdle: async () => {},
    };

    await flushPendingToolResultsAfterIdle({
      agent,
      sessionManager: sm,
      timeoutMs: 30_000,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("immediately flushes pending tool results without waiting when timeoutMs is 0 or less", async () => {
    const sm = guardSessionManager(SessionManager.inMemory());
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;

    // Agent that never resolves idle
    const idle = deferred<void>();
    const waitForIdleSpy = vi.fn(() => idle.promise);
    const agent = { waitForIdle: waitForIdleSpy };

    appendMessage(assistantToolCall("call_orphan_immediate"));

    // Should resolve immediately without advancing timers
    await flushPendingToolResultsAfterIdle({
      agent,
      sessionManager: sm,
      timeoutMs: 0,
    });

    // Verify waitForIdle was completely bypassed
    expect(waitForIdleSpy).not.toHaveBeenCalled();

    // The pending tool result should be flushed immediately.
    expect(getMessages(sm).map((m) => m.role)).toEqual(["assistant", "toolResult"]);

    // Test negative timeout as well
    appendMessage(assistantToolCall("call_orphan_negative"));
    await flushPendingToolResultsAfterIdle({
      agent,
      sessionManager: sm,
      timeoutMs: -100,
    });

    // Verify waitForIdle was still bypassed
    expect(waitForIdleSpy).not.toHaveBeenCalled();
    expect(getMessages(sm).map((m) => m.role)).toEqual([
      "assistant",
      "toolResult",
      "assistant",
      "toolResult",
    ]);
  });
});
