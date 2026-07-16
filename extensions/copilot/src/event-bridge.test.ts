import type { SessionEvent } from "@github/copilot-sdk";
// Copilot tests cover event bridge plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachEventBridge, type SessionLike } from "./event-bridge.js";

const MODEL_REF = {
  api: "openai-responses",
  id: "gpt-5",
  provider: "github-copilot",
} as const;
const REGISTERED_EVENT_TYPES = [
  "assistant.message_delta",
  "assistant.reasoning_delta",
  "assistant.message",
  "assistant.usage",
  "tool.execution_start",
  "tool.execution_complete",
  "session.plan_changed",
  "exit_plan_mode.requested",
  "exit_plan_mode.completed",
  "subagent.started",
  "subagent.completed",
  "subagent.failed",
  "session.compaction_start",
  "session.compaction_complete",
  "session.idle",
  "session.error",
  "abort",
] as const;

type FakeSession = SessionLike & {
  emit: (eventType: string, event: SessionEvent) => void;
  listenerCount: (eventType: string) => number;
};

function createDeferred<T>() {
  let rejectPromise: ((reason?: unknown) => void) | undefined;
  let resolvePromise: ((value: T | PromiseLike<T>) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    reject(reason?: unknown) {
      rejectPromise?.(reason);
    },
    resolve(value: T) {
      resolvePromise?.(value);
    },
  };
}

function flushAsync() {
  const tick = () => Promise.resolve();
  return tick().then(tick);
}

function makeEvent(type: string, data: Record<string, unknown>): SessionEvent {
  return {
    data,
    id: `${type}-id`,
    parentId: null,
    timestamp: "2024-01-01T00:00:00.000Z",
    type,
  } as SessionEvent;
}

function makeAssistantMessageEvent(
  content = "assistant text",
  overrides: Record<string, unknown> = {},
): SessionEvent {
  return makeEvent("assistant.message", {
    content,
    messageId: "msg-1",
    model: "gpt-5",
    ...overrides,
  });
}

function createFakeSession(
  options: {
    onOff?: (eventType: string) => void;
    onReturnedUnsubscribe?: (eventType: string) => void;
    returnUnsubscribe?: boolean;
  } = {},
): FakeSession {
  const listeners = new Map<string, Array<(event: SessionEvent) => void>>();
  const returnUnsubscribe = options.returnUnsubscribe !== false;

  const off = vi.fn((eventType: string, handler: (event: SessionEvent) => void) => {
    options.onOff?.(eventType);
    listeners.set(
      eventType,
      (listeners.get(eventType) ?? []).filter((existing) => existing !== handler),
    );
  });

  const on = vi.fn((eventType: string, handler: (event: SessionEvent) => void) => {
    listeners.set(eventType, [...(listeners.get(eventType) ?? []), handler]);
    if (!returnUnsubscribe) {
      return undefined;
    }
    return () => {
      options.onReturnedUnsubscribe?.(eventType);
      off(eventType, handler);
    };
  });

  return {
    abort: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    emit(eventType: string, event: SessionEvent) {
      for (const handler of listeners.get(eventType) ?? []) {
        handler(event);
      }
    },
    id: "session-id",
    listenerCount(eventType: string) {
      return listeners.get(eventType)?.length ?? 0;
    },
    off,
    on,
    sendAndWait: vi.fn().mockResolvedValue(undefined),
    sessionId: "sdk-session-id",
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("attachEventBridge", () => {
  it("assistant.message_delta accumulates text per messageId in arrival order", () => {
    const session = createFakeSession();
    const bridge = attachEventBridge(session, {
      getSdkSessionId: () => "sdk-session-id",
      isAborted: () => false,
    });

    session.emit(
      "assistant.message_delta",
      makeEvent("assistant.message_delta", { deltaContent: "he", messageId: "msg-1" }),
    );
    session.emit(
      "assistant.message_delta",
      makeEvent("assistant.message_delta", { deltaContent: "llo", messageId: "msg-1" }),
    );

    expect(bridge.snapshot().assistantTexts).toEqual(["hello"]);
  });

  it("ignores child assistant and usage events but keeps child tool side effects", async () => {
    const session = createFakeSession();
    const onAssistantDelta = vi.fn();
    const bridge = attachEventBridge(session, {
      getSdkSessionId: () => "sdk-session-id",
      isAborted: () => false,
      onAssistantDelta,
    });

    session.emit("assistant.message_delta", {
      ...makeEvent("assistant.message_delta", { deltaContent: "child", messageId: "child-msg" }),
      agentId: "child-1",
    } as SessionEvent);
    session.emit(
      "assistant.message_delta",
      makeEvent("assistant.message_delta", { deltaContent: "root", messageId: "root-msg" }),
    );
    session.emit("tool.execution_start", {
      ...makeEvent("tool.execution_start", { toolCallId: "child-call", toolName: "write" }),
      agentId: "child-1",
    } as SessionEvent);
    session.emit("tool.execution_complete", {
      ...makeEvent("tool.execution_complete", {
        result: { content: "child write" },
        success: true,
        toolCallId: "child-call",
      }),
      agentId: "child-1",
    } as SessionEvent);
    session.emit("assistant.usage", {
      ...makeEvent("assistant.usage", { inputTokens: 99, outputTokens: 99 }),
      agentId: "child-1",
    } as SessionEvent);

    expect(bridge.snapshot().assistantTexts).toEqual(["root"]);
    expect(bridge.snapshot().startedCount).toBe(0);
    expect(bridge.snapshot().toolMetas).toEqual([{ meta: "child write", toolName: "write" }]);
    await bridge.awaitDeltaChain();
    expect(onAssistantDelta).toHaveBeenCalledTimes(1);
  });

  it("interleaved messageIds produce two ordered assistantTexts entries", () => {
    const session = createFakeSession();
    const bridge = attachEventBridge(session, {
      getSdkSessionId: () => "sdk-session-id",
      isAborted: () => false,
    });

    session.emit(
      "assistant.message_delta",
      makeEvent("assistant.message_delta", { deltaContent: "a", messageId: "msg-1" }),
    );
    session.emit(
      "assistant.message_delta",
      makeEvent("assistant.message_delta", { deltaContent: "x", messageId: "msg-2" }),
    );
    session.emit(
      "assistant.message_delta",
      makeEvent("assistant.message_delta", { deltaContent: "b", messageId: "msg-1" }),
    );

    expect(bridge.snapshot().assistantTexts).toEqual(["ab", "x"]);
  });

  it("onAssistantDelta receives appended text, live sessionId, and current usage", async () => {
    const session = createFakeSession();
    let sdkSessionId = "sdk-session-1";
    const onAssistantDelta = vi.fn().mockResolvedValue(undefined);
    const bridge = attachEventBridge(session, {
      getSdkSessionId: () => sdkSessionId,
      isAborted: () => false,
      onAssistantDelta,
    });

    session.emit(
      "assistant.usage",
      makeEvent("assistant.usage", {
        cacheReadTokens: 1,
        cacheWriteTokens: 2,
        inputTokens: 3,
        outputTokens: 4,
      }),
    );
    sdkSessionId = "sdk-session-2";
    session.emit(
      "assistant.message_delta",
      makeEvent("assistant.message_delta", { deltaContent: "hi", messageId: "msg-1" }),
    );

    await bridge.awaitDeltaChain();

    expect(onAssistantDelta).toHaveBeenCalledTimes(1);
    expect(onAssistantDelta).toHaveBeenCalledWith({
      delta: "hi",
      sessionId: "sdk-session-2",
      text: "hi",
      usage: {
        cacheRead: 1,
        cacheWrite: 2,
        input: 3,
        output: 4,
        total: 10,
      },
    });
  });

  it("onAssistantDelta callbacks are serialized and awaitDeltaChain resolves after both", async () => {
    const session = createFakeSession();
    const order: string[] = [];
    const releases: Array<() => void> = [];
    const bridge = attachEventBridge(session, {
      getSdkSessionId: () => "sdk-session-id",
      isAborted: () => false,
      onAssistantDelta: vi.fn(async (payload: { delta: string }) => {
        order.push(`start:${payload.delta}`);
        await new Promise<void>((resolve) => {
          releases.push(() => {
            order.push(`end:${payload.delta}`);
            resolve();
          });
        });
      }),
    });

    session.emit(
      "assistant.message_delta",
      makeEvent("assistant.message_delta", { deltaContent: "a", messageId: "msg-1" }),
    );
    session.emit(
      "assistant.message_delta",
      makeEvent("assistant.message_delta", { deltaContent: "b", messageId: "msg-1" }),
    );
    await flushAsync();

    expect(order).toEqual(["start:a"]);
    releases[0]?.();
    await flushAsync();
    expect(order).toEqual(["start:a", "end:a", "start:b"]);
    releases[1]?.();

    await expect(bridge.awaitDeltaChain()).resolves.toBeUndefined();
    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b"]);
  });

  it("onAssistantDelta rejection propagates through awaitDeltaChain while later deltas still serialize", async () => {
    const session = createFakeSession();
    const order: string[] = [];
    const firstError = new Error("delta failed");
    const secondDeferred = createDeferred<void>();
    const bridge = attachEventBridge(session, {
      getSdkSessionId: () => "sdk-session-id",
      isAborted: () => false,
      onAssistantDelta: vi.fn((payload: { delta: string }) => {
        order.push(`start:${payload.delta}`);
        if (payload.delta === "a") {
          return Promise.reject(firstError);
        }
        return secondDeferred.promise.then(() => {
          order.push(`end:${payload.delta}`);
        });
      }),
    });

    session.emit(
      "assistant.message_delta",
      makeEvent("assistant.message_delta", { deltaContent: "a", messageId: "msg-1" }),
    );
    session.emit(
      "assistant.message_delta",
      makeEvent("assistant.message_delta", { deltaContent: "b", messageId: "msg-1" }),
    );
    await flushAsync();
    await flushAsync();

    expect(order).toEqual(["start:a", "start:b"]);
    secondDeferred.resolve(undefined);

    await expect(bridge.awaitDeltaChain()).rejects.toBe(firstError);
    expect(order).toEqual(["start:a", "start:b", "end:b"]);
  });

  it("assistant.reasoning_delta accumulates reasoning in arrival order for buildAssistantMessage", () => {
    const session = createFakeSession();
    const bridge = attachEventBridge(session, {
      getSdkSessionId: () => "sdk-session-id",
      isAborted: () => false,
    });

    session.emit(
      "assistant.reasoning_delta",
      makeEvent("assistant.reasoning_delta", { deltaContent: "thin", reasoningId: "reason-1" }),
    );
    session.emit(
      "assistant.reasoning_delta",
      makeEvent("assistant.reasoning_delta", { deltaContent: "king", reasoningId: "reason-1" }),
    );
    bridge.recordSendResult(makeAssistantMessageEvent("done"));

    expect(bridge.buildAssistantMessage({ modelRef: MODEL_REF, now: () => 7 })?.content).toEqual([
      { thinking: "thinking", type: "thinking" },
      { text: "done", type: "text" },
    ]);
  });

  it("buildAssistantMessage prefers terminal reasoningText over reasoning deltas", () => {
    const session = createFakeSession();
    const bridge = attachEventBridge(session, {
      getSdkSessionId: () => "sdk-session-id",
      isAborted: () => false,
    });

    session.emit(
      "assistant.reasoning_delta",
      makeEvent("assistant.reasoning_delta", { deltaContent: "older", reasoningId: "reason-1" }),
    );
    bridge.recordSendResult(
      makeAssistantMessageEvent("done", {
        reasoningText: "terminal reasoning",
      }),
    );

    expect(bridge.buildAssistantMessage({ modelRef: MODEL_REF, now: () => 8 })?.content).toEqual([
      { thinking: "terminal reasoning", type: "thinking" },
      { text: "done", type: "text" },
    ]);
  });

  it("assistant.message only overwrites accumulated text when content is at least as long", () => {
    const shorterSession = createFakeSession();
    const shorterBridge = attachEventBridge(shorterSession, {
      getSdkSessionId: () => "sdk-session-id",
      isAborted: () => false,
    });
    shorterSession.emit(
      "assistant.message_delta",
      makeEvent("assistant.message_delta", { deltaContent: "longer", messageId: "msg-1" }),
    );
    shorterSession.emit(
      "assistant.message",
      makeAssistantMessageEvent("short", { messageId: "msg-1" }),
    );

    const longerSession = createFakeSession();
    const longerBridge = attachEventBridge(longerSession, {
      getSdkSessionId: () => "sdk-session-id",
      isAborted: () => false,
    });
    longerSession.emit(
      "assistant.message_delta",
      makeEvent("assistant.message_delta", { deltaContent: "tiny", messageId: "msg-1" }),
    );
    longerSession.emit(
      "assistant.message",
      makeAssistantMessageEvent("longer text", { messageId: "msg-1" }),
    );

    expect(shorterBridge.finalizeAssistantTexts()).toEqual(["longer"]);
    expect(longerBridge.finalizeAssistantTexts()).toEqual(["longer text"]);
  });

  it("assistant.message with toolRequests produces toolCall content and toolUse stopReason", () => {
    const session = createFakeSession();
    const bridge = attachEventBridge(session, {
      getSdkSessionId: () => "sdk-session-id",
      isAborted: () => false,
    });

    bridge.recordSendResult(
      makeAssistantMessageEvent("call tool", {
        outputTokens: 7,
        toolRequests: [
          {
            arguments: { path: "README.md" },
            name: "read_file",
            toolCallId: "call-1",
          },
        ],
      }),
    );

    expect(bridge.buildAssistantMessage({ modelRef: MODEL_REF, now: () => 9 })).toEqual({
      api: "openai-responses",
      content: [
        { text: "call tool", type: "text" },
        {
          arguments: { path: "README.md" },
          id: "call-1",
          name: "read_file",
          type: "toolCall",
        },
      ],
      model: "gpt-5",
      provider: "github-copilot",
      role: "assistant",
      stopReason: "toolUse",
      timestamp: 9,
      usage: {
        cacheRead: 0,
        cacheWrite: 0,
        cost: {
          cacheRead: 0,
          cacheWrite: 0,
          input: 0,
          output: 0,
          total: 0,
        },
        input: 0,
        output: 7,
        totalTokens: 7,
      },
    });
  });

  it("assistant.usage updates internal usage and the next onAssistantDelta payload reads it", async () => {
    const session = createFakeSession();
    const onAssistantDelta = vi.fn().mockResolvedValue(undefined);
    const bridge = attachEventBridge(session, {
      getSdkSessionId: () => "sdk-session-id",
      isAborted: () => false,
      onAssistantDelta,
    });

    session.emit(
      "assistant.usage",
      makeEvent("assistant.usage", {
        cacheReadTokens: -2,
        cacheWriteTokens: Number.NaN,
        inputTokens: 4.9,
        outputTokens: 5.1,
      }),
    );
    session.emit(
      "assistant.message_delta",
      makeEvent("assistant.message_delta", { deltaContent: "x", messageId: "msg-1" }),
    );

    await bridge.awaitDeltaChain();

    expect(onAssistantDelta).toHaveBeenCalledWith({
      delta: "x",
      sessionId: "sdk-session-id",
      text: "x",
      usage: {
        cacheRead: 0,
        cacheWrite: undefined,
        input: 4,
        output: 5,
        total: 9,
      },
    });
  });

  it("projects Copilot plan events through the generic plan stream", async () => {
    const session = createFakeSession();
    const onAgentEvent = vi.fn().mockResolvedValue(undefined);
    const bridge = attachEventBridge(session, {
      getSdkSessionId: () => "sdk-session-id",
      isAborted: () => false,
      onAgentEvent,
    });

    session.emit(
      "session.plan_changed",
      makeEvent("session.plan_changed", { operation: "update" }),
    );
    session.emit(
      "exit_plan_mode.requested",
      makeEvent("exit_plan_mode.requested", {
        actions: ["approve", "edit"],
        planContent: "# Plan\n- inspect\n- patch",
        recommendedAction: "approve",
        requestId: "request-1",
        summary: "Plan ready",
      }),
    );
    session.emit(
      "exit_plan_mode.completed",
      makeEvent("exit_plan_mode.completed", {
        approved: true,
        requestId: "request-1",
        selectedAction: "approve",
      }),
    );

    await bridge.awaitAgentEventChain();

    expect(onAgentEvent).toHaveBeenCalledTimes(3);
    expect(onAgentEvent).toHaveBeenNthCalledWith(1, {
      stream: "plan",
      data: {
        phase: "update",
        title: "Plan updated",
        source: "copilot-sdk",
        operation: "update",
      },
    });
    expect(onAgentEvent).toHaveBeenNthCalledWith(2, {
      stream: "plan",
      data: {
        phase: "update",
        title: "Plan updated",
        source: "copilot-sdk",
        explanation: "Plan ready",
        steps: ["# Plan", "inspect", "patch"],
        actions: ["approve", "edit"],
        requestId: "request-1",
        recommendedAction: "approve",
      },
    });
    expect(onAgentEvent).toHaveBeenNthCalledWith(3, {
      stream: "plan",
      data: {
        phase: "update",
        title: "Plan decision",
        source: "copilot-sdk",
        requestId: "request-1",
        approved: true,
        selectedAction: "approve",
      },
    });
  });

  it("forwards native Copilot subagent lifecycle events to the adapter", () => {
    const session = createFakeSession();
    const onNativeSubagentEvent = vi.fn();
    const bridge = attachEventBridge(session, {
      getSdkSessionId: () => "sdk-session-id",
      isAborted: () => false,
      onNativeSubagentEvent,
    });
    const event = makeEvent("subagent.started", {
      agentDescription: "inspect the repository",
      agentDisplayName: "Researcher",
      agentName: "researcher",
      toolCallId: "call-1",
    });

    session.emit("subagent.started", event);

    expect(onNativeSubagentEvent).toHaveBeenCalledWith(event);
    bridge.detach();
  });

  it("preserves all-zero usage snapshot after an invalid assistant.usage event", () => {
    const session = createFakeSession();
    const bridge = attachEventBridge(session, {
      getSdkSessionId: () => "sdk-session-id",
      isAborted: () => false,
    });

    bridge.recordSendResult(makeAssistantMessageEvent("done", { outputTokens: 7 }));
    session.emit(
      "assistant.usage",
      makeEvent("assistant.usage", {
        cacheReadTokens: "bad",
        cacheWriteTokens: Number.POSITIVE_INFINITY,
        inputTokens: undefined,
        outputTokens: Number.NaN,
      }),
    );

    expect(bridge.snapshot().usage).toEqual({
      cacheRead: undefined,
      cacheWrite: undefined,
      input: undefined,
      output: undefined,
      total: 0,
    });
    expect(bridge.buildAssistantMessage({ modelRef: MODEL_REF, now: () => 9.5 })?.usage).toEqual({
      cacheRead: 0,
      cacheWrite: 0,
      cost: {
        cacheRead: 0,
        cacheWrite: 0,
        input: 0,
        output: 0,
        total: 0,
      },
      input: 0,
      output: 0,
      totalTokens: 0,
    });
  });

  it("overwrites prior usage with an all-zero snapshot when a later invalid usage event arrives", () => {
    const session = createFakeSession();
    const bridge = attachEventBridge(session, {
      getSdkSessionId: () => "sdk-session-id",
      isAborted: () => false,
    });

    session.emit(
      "assistant.usage",
      makeEvent("assistant.usage", {
        inputTokens: 5,
      }),
    );
    session.emit(
      "assistant.usage",
      makeEvent("assistant.usage", {
        inputTokens: "bad",
      }),
    );

    expect(bridge.snapshot().usage).toEqual({
      cacheRead: undefined,
      cacheWrite: undefined,
      input: undefined,
      output: undefined,
      total: 0,
    });
  });

  it("tool.execution_start increments startedCount and pushes toolMetas without meta", () => {
    const session = createFakeSession();
    const bridge = attachEventBridge(session, {
      getSdkSessionId: () => "sdk-session-id",
      isAborted: () => false,
    });

    session.emit(
      "tool.execution_start",
      makeEvent("tool.execution_start", { toolCallId: "call-1", toolName: "bash" }),
    );

    expect(bridge.snapshot()).toEqual({
      assistantTexts: [],
      completedCount: 0,
      lastAssistantEvent: undefined,
      startedCount: 1,
      streamError: undefined,
      toolMetas: [{ toolName: "bash" }],
      usage: undefined,
    });
  });

  it("tool.execution_complete updates one tool meta per call and marks failures", () => {
    const session = createFakeSession();
    const bridge = attachEventBridge(session, {
      getSdkSessionId: () => "sdk-session-id",
      isAborted: () => false,
    });

    session.emit(
      "tool.execution_start",
      makeEvent("tool.execution_start", { toolCallId: "call-1", toolName: "bash" }),
    );
    session.emit(
      "tool.execution_complete",
      makeEvent("tool.execution_complete", {
        result: { content: "content", detailedContent: "details" },
        success: true,
        toolCallId: "call-1",
      }),
    );
    session.emit(
      "tool.execution_start",
      makeEvent("tool.execution_start", { toolCallId: "call-2", toolName: "read" }),
    );
    session.emit(
      "tool.execution_complete",
      makeEvent("tool.execution_complete", {
        error: { message: "failed" },
        success: false,
        toolCallId: "call-2",
      }),
    );

    expect(bridge.snapshot().toolMetas).toEqual([
      { meta: "details", toolName: "bash" },
      { meta: "failed", toolName: "read", isError: true },
    ]);
  });

  it("tool.execution_complete without a matching start increments completedCount without pushing meta", () => {
    const session = createFakeSession();
    const bridge = attachEventBridge(session, {
      getSdkSessionId: () => "sdk-session-id",
      isAborted: () => false,
    });

    session.emit(
      "tool.execution_complete",
      makeEvent("tool.execution_complete", {
        result: { content: "done" },
        success: true,
        toolCallId: "missing",
      }),
    );

    expect(bridge.snapshot().completedCount).toBe(1);
    expect(bridge.snapshot().toolMetas).toEqual([]);
  });

  it("serializes compaction callbacks and clears active compaction state on completion", async () => {
    const session = createFakeSession();
    const calls: string[] = [];
    const bridge = attachEventBridge(session, {
      getSdkSessionId: () => "sdk-session-id",
      isAborted: () => false,
      onCompactionStart: () => {
        calls.push("start");
      },
      onCompactionComplete: ({ success }) => {
        calls.push(`complete:${success}`);
      },
    });

    session.emit("session.compaction_start", makeEvent("session.compaction_start", {}));
    session.emit(
      "session.compaction_complete",
      makeEvent("session.compaction_complete", { success: false }),
    );
    session.emit("session.compaction_start", makeEvent("session.compaction_start", {}));
    session.emit(
      "session.compaction_complete",
      makeEvent("session.compaction_complete", { success: true }),
    );
    await bridge.awaitCompactionChain();

    expect(calls).toEqual(["start", "complete:false", "start", "complete:true"]);
    expect(bridge.isCompacting()).toBe(false);
  });

  it("invalidates shared tool context synchronously after every successful compaction", () => {
    const session = createFakeSession();
    const onContextCompacted = vi.fn();
    attachEventBridge(session, {
      getSdkSessionId: () => "sdk-session-id",
      isAborted: () => false,
      onContextCompacted,
    });

    session.emit(
      "session.compaction_complete",
      makeEvent("session.compaction_complete", { success: false }),
    );
    expect(onContextCompacted).not.toHaveBeenCalled();

    session.emit(
      "session.compaction_complete",
      makeEvent("session.compaction_complete", { success: true }),
    );
    expect(onContextCompacted).toHaveBeenCalledTimes(1);

    session.emit("session.compaction_complete", {
      ...makeEvent("session.compaction_complete", { success: true }),
      agentId: "subagent-1",
    });
    expect(onContextCompacted).toHaveBeenCalledTimes(2);
  });

  it("waits for an active compaction and its completion callback", async () => {
    const session = createFakeSession();
    const complete = vi.fn();
    const bridge = attachEventBridge(session, {
      getSdkSessionId: () => "sdk-session-id",
      isAborted: () => false,
      onCompactionComplete: complete,
    });

    session.emit("session.compaction_start", makeEvent("session.compaction_start", {}));
    const completion = bridge.awaitCompactionCompletion();
    await flushAsync();

    expect(bridge.hasObservedCompaction()).toBe(true);
    expect(complete).not.toHaveBeenCalled();
    session.emit(
      "session.compaction_complete",
      makeEvent("session.compaction_complete", { messagesRemoved: 3, success: true }),
    );
    await completion;

    expect(complete).toHaveBeenCalledWith({ messagesRemoved: 3, success: true });
    expect(bridge.isCompacting()).toBe(false);
  });

  it("waits for the SDK terminal idle event", async () => {
    const session = createFakeSession();
    const bridge = attachEventBridge(session, {
      getSdkSessionId: () => "sdk-session-id",
      isAborted: () => false,
    });

    const idle = bridge.awaitSessionIdle();
    await flushAsync();
    session.emit("session.idle", makeEvent("session.idle", {}));
    await idle;

    expect(bridge.hasObservedSessionIdle()).toBe(true);
  });

  it("ignores subagent idle events while waiting for the root session", async () => {
    const session = createFakeSession();
    const bridge = attachEventBridge(session, {
      getSdkSessionId: () => "sdk-session-id",
      isAborted: () => false,
    });

    const idle = bridge.awaitSessionIdle();
    session.emit("session.idle", {
      ...makeEvent("session.idle", {}),
      agentId: "subagent-1",
    });
    await flushAsync();
    expect(bridge.hasObservedSessionIdle()).toBe(false);

    session.emit("session.idle", makeEvent("session.idle", {}));
    await idle;
    expect(bridge.hasObservedSessionIdle()).toBe(true);
  });

  it("keeps compaction pending after an abort until the SDK reports completion", async () => {
    const session = createFakeSession();
    const bridge = attachEventBridge(session, {
      getSdkSessionId: () => "sdk-session-id",
      isAborted: () => false,
    });

    session.emit("session.compaction_start", makeEvent("session.compaction_start", {}));
    const completion = bridge.awaitCompactionCompletion();
    session.emit("abort", makeEvent("abort", { reason: "tool yield" }));
    await flushAsync();

    expect(bridge.isCompacting()).toBe(true);
    session.emit(
      "session.compaction_complete",
      makeEvent("session.compaction_complete", { success: false }),
    );
    await completion;

    expect(bridge.isCompacting()).toBe(false);
  });

  it("settles an active compaction wait before terminal teardown", async () => {
    const session = createFakeSession();
    const bridge = attachEventBridge(session, {
      getSdkSessionId: () => "sdk-session-id",
      isAborted: () => false,
    });

    session.emit("session.compaction_start", makeEvent("session.compaction_start", {}));
    const completion = bridge.awaitCompactionCompletion();
    bridge.settleCompactionWait();

    await completion;
    expect(bridge.isCompacting()).toBe(false);
  });

  it("ignores subagent compaction events when tracking the root session", async () => {
    const session = createFakeSession();
    const onCompactionStart = vi.fn();
    const onCompactionComplete = vi.fn();
    const bridge = attachEventBridge(session, {
      getSdkSessionId: () => "sdk-session-id",
      isAborted: () => false,
      onCompactionStart,
      onCompactionComplete,
    });

    session.emit("session.compaction_start", {
      ...makeEvent("session.compaction_start", {}),
      agentId: "subagent-1",
    });
    session.emit("session.compaction_complete", {
      ...makeEvent("session.compaction_complete", { success: true }),
      agentId: "subagent-1",
    });
    await bridge.awaitCompactionCompletion();

    expect(bridge.hasObservedCompaction()).toBe(false);
    expect(bridge.isCompacting()).toBe(false);
    expect(onCompactionStart).not.toHaveBeenCalled();
    expect(onCompactionComplete).not.toHaveBeenCalled();
  });

  it("session.error populates streamError with errorCode or errorType only when not aborted", () => {
    const activeSession = createFakeSession();
    const activeBridge = attachEventBridge(activeSession, {
      getSdkSessionId: () => "sdk-session-id",
      isAborted: () => false,
    });
    activeSession.emit(
      "session.error",
      makeEvent("session.error", {
        errorCode: "boom_code",
        errorType: "boom_type",
        message: "boom",
      }),
    );

    const abortedSession = createFakeSession();
    const abortedBridge = attachEventBridge(abortedSession, {
      getSdkSessionId: () => "sdk-session-id",
      isAborted: () => true,
    });
    abortedSession.emit(
      "session.error",
      makeEvent("session.error", {
        errorType: "ignored",
        message: "ignored",
      }),
    );

    expect((activeBridge.snapshot().streamError as Error & { code?: string })?.code).toBe(
      "boom_code",
    );
    expect(activeBridge.snapshot().streamError?.message).toBe("boom");
    expect(abortedBridge.snapshot().streamError).toBeUndefined();
  });

  it("abort populates streamError with session_aborted only when not aborted", () => {
    const activeSession = createFakeSession();
    const activeBridge = attachEventBridge(activeSession, {
      getSdkSessionId: () => "sdk-session-id",
      isAborted: () => false,
    });
    activeSession.emit("abort", makeEvent("abort", { reason: "because" }));

    const abortedSession = createFakeSession();
    const abortedBridge = attachEventBridge(abortedSession, {
      getSdkSessionId: () => "sdk-session-id",
      isAborted: () => true,
    });
    abortedSession.emit("abort", makeEvent("abort", { reason: "ignored" }));

    expect((activeBridge.snapshot().streamError as Error & { code?: string })?.code).toBe(
      "session_aborted",
    );
    expect(activeBridge.snapshot().streamError?.message).toBe(
      "[copilot-attempt] session aborted: because",
    );
    expect(abortedBridge.snapshot().streamError).toBeUndefined();
  });

  it("recordSendResult returns false for undefined and true for assistant.message while updating lastAssistantEvent", () => {
    const session = createFakeSession();
    const bridge = attachEventBridge(session, {
      getSdkSessionId: () => "sdk-session-id",
      isAborted: () => false,
    });

    expect(bridge.recordSendResult(undefined)).toBe(false);
    const event = makeAssistantMessageEvent("done", { outputTokens: 2 });
    expect(bridge.recordSendResult(event)).toBe(true);
    expect(bridge.snapshot().lastAssistantEvent).toEqual(event);
    expect(bridge.buildAssistantMessage({ modelRef: MODEL_REF, now: () => 11 })?.content).toEqual([
      { text: "done", type: "text" },
    ]);
  });

  it("recordSendResult falls back to terminal content when no deltas arrived", () => {
    const session = createFakeSession();
    const bridge = attachEventBridge(session, {
      getSdkSessionId: () => "sdk-session-id",
      isAborted: () => false,
    });

    bridge.recordSendResult(makeAssistantMessageEvent("done"));

    expect(bridge.finalizeAssistantTexts()).toEqual(["done"]);
  });

  it("ignores empty assistant and reasoning deltas", () => {
    const onAssistantDelta = vi.fn();
    const session = createFakeSession();
    const bridge = attachEventBridge(session, {
      getSdkSessionId: () => "sdk-session-id",
      isAborted: () => false,
      onAssistantDelta,
    });

    session.emit(
      "assistant.message_delta",
      makeEvent("assistant.message_delta", { deltaContent: "", messageId: "msg-1" }),
    );
    session.emit(
      "assistant.reasoning_delta",
      makeEvent("assistant.reasoning_delta", { deltaContent: "", reasoningId: "reason-1" }),
    );
    session.emit("assistant.message", makeAssistantMessageEvent("", { messageId: "msg-1" }));

    expect(onAssistantDelta).not.toHaveBeenCalled();
    expect(bridge.finalizeAssistantTexts()).toEqual([]);
    expect(bridge.buildAssistantMessage({ modelRef: MODEL_REF, now: () => 13 })).toBeUndefined();
  });

  it("detach is idempotent after the first unsubscribe pass", () => {
    const order: string[] = [];
    const session = createFakeSession({
      onReturnedUnsubscribe: (eventType) => {
        order.push(eventType);
      },
    });
    const bridge = attachEventBridge(session, {
      getSdkSessionId: () => "sdk-session-id",
      isAborted: () => false,
    });

    bridge.detach();
    bridge.detach();

    expect(order).toEqual([...REGISTERED_EVENT_TYPES].toReversed());
    expect(session.off).toHaveBeenCalledTimes(REGISTERED_EVENT_TYPES.length);
  });

  it("detach unsubscribes in reverse order when session.on returns unsubscribe functions", () => {
    const order: string[] = [];
    const session = createFakeSession({
      onReturnedUnsubscribe: (eventType) => {
        order.push(eventType);
      },
    });
    const bridge = attachEventBridge(session, {
      getSdkSessionId: () => "sdk-session-id",
      isAborted: () => false,
    });

    bridge.detach();
    session.emit(
      "assistant.message_delta",
      makeEvent("assistant.message_delta", { deltaContent: "ignored", messageId: "msg-1" }),
    );

    expect(order).toEqual([...REGISTERED_EVENT_TYPES].toReversed());
    expect(session.listenerCount("assistant.message_delta")).toBe(0);
  });

  it("detach unsubscribes in reverse order via off() fallback", () => {
    const order: string[] = [];
    const session = createFakeSession({
      onOff: (eventType) => {
        order.push(eventType);
      },
      returnUnsubscribe: false,
    });
    const bridge = attachEventBridge(session, {
      getSdkSessionId: () => "sdk-session-id",
      isAborted: () => false,
    });

    bridge.detach();
    session.emit(
      "assistant.message_delta",
      makeEvent("assistant.message_delta", { deltaContent: "ignored", messageId: "msg-1" }),
    );

    expect(order).toEqual([...REGISTERED_EVENT_TYPES].toReversed());
    expect(session.listenerCount("assistant.message_delta")).toBe(0);
  });

  it("buildAssistantMessage returns undefined with no event, text, reasoning, or toolRequests", () => {
    const session = createFakeSession();
    const bridge = attachEventBridge(session, {
      getSdkSessionId: () => "sdk-session-id",
      isAborted: () => false,
    });

    expect(bridge.buildAssistantMessage({ modelRef: MODEL_REF, now: () => 12 })).toBeUndefined();
  });

  it("snapshot returns defensive copies for arrays and usage objects", () => {
    const session = createFakeSession();
    const bridge = attachEventBridge(session, {
      getSdkSessionId: () => "sdk-session-id",
      isAborted: () => false,
    });

    session.emit(
      "assistant.message_delta",
      makeEvent("assistant.message_delta", { deltaContent: "hello", messageId: "msg-1" }),
    );
    session.emit(
      "assistant.usage",
      makeEvent("assistant.usage", { inputTokens: 1, outputTokens: 2 }),
    );
    session.emit(
      "tool.execution_start",
      makeEvent("tool.execution_start", { toolCallId: "call-1", toolName: "bash" }),
    );

    const first = bridge.snapshot();
    (first.assistantTexts as string[]).push("mutated");
    expectDefined(
      (first.toolMetas as Array<{ meta?: string; toolName: string }>)[0],
      "Copilot tool metadata",
    ).toolName = "mutated";
    (first.usage as { input?: number }).input = 999;

    const second = bridge.snapshot();
    expect(second.assistantTexts).toEqual(["hello"]);
    expect(second.toolMetas).toEqual([{ toolName: "bash" }]);
    expect(second.usage).toEqual({
      cacheRead: undefined,
      cacheWrite: undefined,
      input: 1,
      output: 2,
      total: 3,
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
