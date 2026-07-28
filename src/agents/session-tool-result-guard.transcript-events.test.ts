// Verifies guarded session managers emit transcript update events with stable sequence ids.
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  onInternalSessionTranscriptUpdate,
  type InternalSessionTranscriptUpdate,
} from "../sessions/transcript-events.js";
import { attachRuntimeUserTurnTranscriptContext } from "../sessions/user-turn-transcript-runtime-context.js";
import type { UserTurnTranscriptRecorder } from "../sessions/user-turn-transcript.js";
import { guardSessionManager } from "./session-tool-result-guard-wrapper.js";

const listeners: Array<() => void> = [];

afterEach(() => {
  // Remove all transcript listeners between tests to avoid duplicate broadcasts.
  while (listeners.length > 0) {
    listeners.pop()?.();
  }
});

describe("guardSessionManager transcript updates", () => {
  it("persists and broadcasts memory-maintenance messages as hidden", () => {
    const updates: InternalSessionTranscriptUpdate[] = [];
    listeners.push(onInternalSessionTranscriptUpdate((update) => updates.push(update)));

    const sm = SessionManager.inMemory();
    const sessionFile = "/tmp/openclaw-session-memory-events.jsonl";
    Object.assign(sm, {
      getSessionFile: () => sessionFile,
    });

    const guarded = guardSessionManager(sm, {
      agentId: "main",
      sessionKey: "agent:main:memory",
      trigger: "memory",
    });
    const appendMessage = guarded.appendMessage.bind(guarded) as unknown as (
      message: AgentMessage,
    ) => void;

    appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "NO_REPLY" }],
      timestamp: Date.now(),
    } as AgentMessage);

    const persisted = sm.getEntries().find((entry) => entry.type === "message") as
      | { message?: AgentMessage }
      | undefined;
    expect(persisted?.message).toMatchObject({ display: false, role: "assistant" });
    expect(updates[0]?.message).toMatchObject({ display: false, role: "assistant" });
  });

  it("keeps the user-turn recorder attached when hiding memory maintenance", () => {
    const sm = SessionManager.inMemory();
    const markRuntimePersisted = vi.fn();
    const recorder = {
      markBlocked: vi.fn(),
      markRuntimePersisted,
    } as unknown as UserTurnTranscriptRecorder;
    const runtimeMessage = attachRuntimeUserTurnTranscriptContext(
      {
        role: "user",
        content: "Pre-compaction memory flush",
        timestamp: Date.now(),
      },
      {
        message: {
          role: "user",
          content: "Pre-compaction memory flush",
          timestamp: Date.now(),
        },
        recorder,
      },
    );
    const guarded = guardSessionManager(sm, {
      agentId: "main",
      sessionKey: "agent:main:memory",
      trigger: "memory",
    });

    guarded.appendMessage(runtimeMessage as Parameters<typeof guarded.appendMessage>[0]);

    expect(markRuntimePersisted).toHaveBeenCalledWith(
      expect.objectContaining({ display: false, role: "user" }),
    );
  });

  it("does not hide ordinary messages that mention memory flushes", () => {
    const sm = SessionManager.inMemory();
    const guarded = guardSessionManager(sm, {
      agentId: "main",
      sessionKey: "agent:main:user",
      trigger: "user",
    });
    const appendMessage = guarded.appendMessage.bind(guarded) as unknown as (
      message: AgentMessage,
    ) => void;

    appendMessage({
      role: "user",
      content: "Why did the memory flush leak?",
      timestamp: Date.now(),
    } as AgentMessage);

    const persisted = sm.getEntries().find((entry) => entry.type === "message") as
      | { message?: AgentMessage }
      | undefined;
    expect(persisted?.message).not.toHaveProperty("display", false);
  });

  it("includes the session key when broadcasting appended non-tool-result messages", () => {
    const updates: InternalSessionTranscriptUpdate[] = [];
    listeners.push(onInternalSessionTranscriptUpdate((update) => updates.push(update)));

    const sm = SessionManager.inMemory();
    const sessionFile = "/tmp/openclaw-session-message-events.jsonl";
    Object.assign(sm, {
      getSessionFile: () => sessionFile,
    });

    const guarded = guardSessionManager(sm, {
      agentId: "main",
      sessionKey: "agent:main:worker",
    });
    const appendMessage = guarded.appendMessage.bind(guarded) as unknown as (
      message: AgentMessage,
    ) => void;

    const timestamp = Date.now();
    appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "hello from subagent" }],
      timestamp,
    } as AgentMessage);

    expect(updates).toStrictEqual([
      {
        agentId: "main",
        message: {
          content: [{ text: "hello from subagent", type: "text" }],
          role: "assistant",
          timestamp,
        },
        messageId: expect.any(String),
        messageSeq: 1,
        sessionFile,
        sessionKey: "agent:main:worker",
      },
    ]);
    expect(updates[0]?.messageId).not.toBe("");
  });

  it("does not resolve transcript sequence when no session file is available", () => {
    const sm = SessionManager.inMemory();
    Object.assign(sm, {
      getSessionFile: () => undefined,
    });
    const getBranchSpy = vi.spyOn(sm, "getBranch");

    const guarded = guardSessionManager(sm, {
      agentId: "main",
      sessionKey: "agent:main:worker",
    });
    const appendMessage = guarded.appendMessage.bind(guarded) as unknown as (
      message: AgentMessage,
    ) => void;

    appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      timestamp: Date.now(),
    } as AgentMessage);

    expect(getBranchSpy).not.toHaveBeenCalled();
    getBranchSpy.mockRestore();
  });

  it("reuses cached transcript sequence for consecutive appended messages", () => {
    const updates: InternalSessionTranscriptUpdate[] = [];
    listeners.push(onInternalSessionTranscriptUpdate((update) => updates.push(update)));

    const sm = SessionManager.inMemory();
    sm.appendMessage({
      role: "user",
      content: "existing prompt",
      timestamp: Date.now(),
    } as Parameters<typeof sm.appendMessage>[0]);
    const getBranchSpy = vi.spyOn(sm, "getBranch");
    const sessionFile = "/tmp/openclaw-session-message-events.jsonl";
    Object.assign(sm, {
      getSessionFile: () => sessionFile,
    });

    const guarded = guardSessionManager(sm, {
      agentId: "main",
      sessionKey: "agent:main:worker",
    });
    const appendMessage = guarded.appendMessage.bind(guarded) as unknown as (
      message: AgentMessage,
    ) => void;

    appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "first" }],
      timestamp: Date.now(),
    } as AgentMessage);
    appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "second" }],
      timestamp: Date.now(),
    } as AgentMessage);

    expect(getBranchSpy).toHaveBeenCalledTimes(1);
    expect(updates.map((update) => update.messageSeq)).toEqual([2, 3]);
    getBranchSpy.mockRestore();
  });

  it("caches real tool result sequence before final assistant messages", () => {
    // Tool results are persisted but not broadcast, so later visible messages must skip their seq.
    const updates: InternalSessionTranscriptUpdate[] = [];
    listeners.push(onInternalSessionTranscriptUpdate((update) => updates.push(update)));

    const sm = SessionManager.inMemory();
    sm.appendMessage({
      role: "user",
      content: "existing prompt",
      timestamp: Date.now(),
    } as Parameters<typeof sm.appendMessage>[0]);
    const getBranchSpy = vi.spyOn(sm, "getBranch");
    const sessionFile = "/tmp/openclaw-session-message-events.jsonl";
    Object.assign(sm, {
      getSessionFile: () => sessionFile,
    });

    const guarded = guardSessionManager(sm, {
      agentId: "main",
      sessionKey: "agent:main:worker",
    });
    const appendMessage = guarded.appendMessage.bind(guarded) as unknown as (
      message: AgentMessage,
    ) => void;

    appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
      timestamp: Date.now(),
    } as AgentMessage);
    appendMessage({
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read",
      content: [{ type: "text", text: "tool output" }],
      isError: false,
      timestamp: Date.now(),
    } as AgentMessage);
    appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "final answer" }],
      timestamp: Date.now(),
    } as AgentMessage);

    expect(getBranchSpy).toHaveBeenCalledTimes(1);
    expect(updates.map((update) => update.messageSeq)).toEqual([2, 4]);
    getBranchSpy.mockRestore();
  });
});
