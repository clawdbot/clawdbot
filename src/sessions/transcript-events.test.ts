// Transcript event tests cover transcript event parsing and compaction.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachSessionTranscriptRunId,
  emitSessionTranscriptUpdate,
  onInternalSessionTranscriptUpdate,
  onSessionTranscriptUpdate,
  readSessionTranscriptRunId,
  resolveTerminalAssistantTranscriptRunId,
} from "./transcript-events.js";

const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length > 0) {
    cleanup.pop()?.();
  }
});

describe("transcript events", () => {
  it.each(["assistant", "toolResult"])("persists normalized run ownership on %s rows", (role) => {
    const message = { role, content: [], __openclaw: { seq: 2 } };

    expect(attachSessionTranscriptRunId(message, "  run-owned  ")).toEqual({
      ...message,
      __openclaw: { seq: 2, runId: "run-owned" },
    });
    expect(attachSessionTranscriptRunId(message, "  ")).toBe(message);
  });

  it("does not assign output run ownership to user rows", () => {
    const message = { role: "user", content: "prompt" };

    expect(attachSessionTranscriptRunId(message, "run-owned")).toBe(message);
  });

  it.each([
    [
      "attached assistant row",
      { role: "assistant", __openclaw: { runId: "run-owned" } },
      "run-owned",
    ],
    ["blank attached run id", { role: "assistant", __openclaw: { runId: "  " } }, undefined],
    ["row without the marker", { role: "assistant", content: [] }, undefined],
  ])("reads back stored run ownership from %s", (_name, message, expected) => {
    expect(readSessionTranscriptRunId(message)).toBe(expected);
  });

  it("emits trimmed archive file updates only to internal listeners", () => {
    const listener = vi.fn();
    cleanup.push(onInternalSessionTranscriptUpdate(listener));

    emitSessionTranscriptUpdate({ sessionFile: "  /tmp/session.jsonl  " });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ sessionFile: "/tmp/session.jsonl" });
  });

  it("does not expose file-only archive updates to public listeners", () => {
    const publicListener = vi.fn();
    const internalListener = vi.fn();
    cleanup.push(onSessionTranscriptUpdate(publicListener));
    cleanup.push(onInternalSessionTranscriptUpdate(internalListener));

    emitSessionTranscriptUpdate({
      sessionFile: "  /tmp/session.jsonl  ",
      sessionKey: "  agent:main:main  ",
      agentId: "  main  ",
      sessionId: "  sess-1  ",
      message: { role: "assistant", content: "hi" },
      messageId: "  msg-1  ",
      messageSeq: 2,
      runId: "  run-1  ",
    });

    expect(publicListener).toHaveBeenCalledWith({
      target: {
        agentId: "main",
        sessionId: "sess-1",
        sessionKey: "agent:main:main",
      },
      sessionKey: "agent:main:main",
      agentId: "main",
      sessionId: "sess-1",
      message: { role: "assistant", content: "hi" },
      messageId: "msg-1",
      messageSeq: 2,
      runId: "run-1",
    });
    expect(internalListener).toHaveBeenCalledWith({
      sessionFile: "/tmp/session.jsonl",
      target: {
        agentId: "main",
        sessionId: "sess-1",
        sessionKey: "agent:main:main",
      },
      sessionKey: "agent:main:main",
      agentId: "main",
      sessionId: "sess-1",
      message: { role: "assistant", content: "hi" },
      messageId: "msg-1",
      messageSeq: 2,
      runId: "run-1",
    });
  });

  it("exposes identity-only updates to public listeners", () => {
    const listener = vi.fn();
    cleanup.push(onSessionTranscriptUpdate(listener));

    emitSessionTranscriptUpdate({
      target: {
        agentId: " main ",
        sessionId: " sess-1 ",
        sessionKey: " agent:main:main ",
      },
      messageId: " msg-1 ",
    });

    expect(listener).toHaveBeenCalledWith({
      target: {
        agentId: "main",
        sessionId: "sess-1",
        sessionKey: "agent:main:main",
      },
      agentId: "main",
      sessionId: "sess-1",
      sessionKey: "agent:main:main",
      messageId: "msg-1",
    });
  });

  it("emits storage-neutral identity updates to internal listeners", () => {
    const listener = vi.fn();
    cleanup.push(onInternalSessionTranscriptUpdate(listener));

    emitSessionTranscriptUpdate({
      target: {
        agentId: " main ",
        sessionId: " sess-1 ",
        sessionKey: " agent:main:main ",
      },
      messageId: " msg-1 ",
    });

    expect(listener).toHaveBeenCalledWith({
      target: {
        agentId: "main",
        sessionId: "sess-1",
        sessionKey: "agent:main:main",
      },
      agentId: "main",
      sessionId: "sess-1",
      sessionKey: "agent:main:main",
      messageId: "msg-1",
    });
  });

  it("keeps normalized committed lifecycle and store ownership on internal events only", () => {
    const publicListener = vi.fn();
    const internalListener = vi.fn();
    cleanup.push(onSessionTranscriptUpdate(publicListener));
    cleanup.push(onInternalSessionTranscriptUpdate(internalListener));

    emitSessionTranscriptUpdate({
      target: {
        agentId: "main",
        sessionId: "sess-1",
        sessionKey: "agent:main:main",
        storePath: "  /tmp/custom-sessions.json  ",
      },
      lifecycleRevision: "  committed-revision  ",
      messageId: "msg-1",
    });

    expect(internalListener).toHaveBeenCalledWith({
      target: {
        agentId: "main",
        sessionId: "sess-1",
        sessionKey: "agent:main:main",
        storePath: "/tmp/custom-sessions.json",
      },
      agentId: "main",
      sessionId: "sess-1",
      sessionKey: "agent:main:main",
      lifecycleRevision: "committed-revision",
      messageId: "msg-1",
    });
    expect(publicListener).toHaveBeenCalledWith({
      target: {
        agentId: "main",
        sessionId: "sess-1",
        sessionKey: "agent:main:main",
      },
      agentId: "main",
      sessionId: "sess-1",
      sessionKey: "agent:main:main",
      messageId: "msg-1",
    });
  });

  it("omits provider replay only from the shallow public message projection", () => {
    const publicListener = vi.fn();
    const internalListener = vi.fn();
    cleanup.push(onSessionTranscriptUpdate(publicListener));
    cleanup.push(onInternalSessionTranscriptUpdate(internalListener));
    const content = [{ type: "text", text: "visible" }];
    const metadata = { nested: true };
    const providerReplay = { type: "opaque", data: "private" };
    const message = {
      role: "assistant",
      content,
      metadata,
      providerReplay,
    };

    emitSessionTranscriptUpdate({
      target: {
        agentId: "main",
        sessionId: "sess-1",
        sessionKey: "agent:main:main",
      },
      message,
      messageId: "msg-1",
    });

    const publicUpdate = publicListener.mock.calls[0]?.[0];
    const internalUpdate = internalListener.mock.calls[0]?.[0];
    expect(publicUpdate?.message).toEqual({ role: "assistant", content, metadata });
    expect(publicUpdate?.message).not.toBe(message);
    expect(publicUpdate?.message.content).toBe(content);
    expect(publicUpdate?.message.metadata).toBe(metadata);
    expect(internalUpdate?.message).toBe(message);
    expect(internalUpdate?.message.providerReplay).toBe(providerReplay);
    expect(message.providerReplay).toBe(providerReplay);
  });

  it("discards blank lifecycle ownership without changing legacy events", () => {
    const listener = vi.fn();
    cleanup.push(onInternalSessionTranscriptUpdate(listener));

    emitSessionTranscriptUpdate({
      sessionFile: "/tmp/session.jsonl",
      lifecycleRevision: "  ",
    });

    expect(listener).toHaveBeenCalledWith({ sessionFile: "/tmp/session.jsonl" });
  });

  it("derives public target identity from legacy-shaped internal updates", () => {
    const listener = vi.fn();
    cleanup.push(onSessionTranscriptUpdate(listener));

    emitSessionTranscriptUpdate({
      sessionFile: "/tmp/session.jsonl",
      sessionKey: "agent:main:main",
      sessionId: "sess-1",
    });

    expect(listener).toHaveBeenCalledWith({
      target: {
        agentId: "main",
        sessionId: "sess-1",
        sessionKey: "agent:main:main",
      },
      agentId: "main",
      sessionId: "sess-1",
      sessionKey: "agent:main:main",
    });
  });

  it("drops public global file updates without target identity", () => {
    const publicListener = vi.fn();
    const internalListener = vi.fn();
    cleanup.push(onSessionTranscriptUpdate(publicListener));
    cleanup.push(onInternalSessionTranscriptUpdate(internalListener));

    emitSessionTranscriptUpdate({
      sessionFile: "/tmp/session.jsonl",
      sessionKey: "global",
    });

    expect(publicListener).not.toHaveBeenCalled();
    expect(internalListener).toHaveBeenCalledWith({
      sessionFile: "/tmp/session.jsonl",
      sessionKey: "global",
    });
  });

  it("drops invalid message sequence values on internal file updates", () => {
    const listener = vi.fn();
    cleanup.push(onInternalSessionTranscriptUpdate(listener));

    emitSessionTranscriptUpdate({
      sessionFile: "/tmp/session.jsonl",
      messageSeq: 0,
    });
    emitSessionTranscriptUpdate({
      sessionFile: "/tmp/session.jsonl",
      messageSeq: 1.5,
    });
    emitSessionTranscriptUpdate({
      sessionFile: "/tmp/session.jsonl",
      messageSeq: Number.POSITIVE_INFINITY,
    });

    expect(listener).toHaveBeenCalledTimes(3);
    expect(listener).toHaveBeenNthCalledWith(1, { sessionFile: "/tmp/session.jsonl" });
    expect(listener).toHaveBeenNthCalledWith(2, { sessionFile: "/tmp/session.jsonl" });
    expect(listener).toHaveBeenNthCalledWith(3, { sessionFile: "/tmp/session.jsonl" });
  });

  it("continues notifying other listeners when one throws", () => {
    const first = vi.fn(() => {
      throw new Error("boom");
    });
    const second = vi.fn();
    cleanup.push(onInternalSessionTranscriptUpdate(first));
    cleanup.push(onInternalSessionTranscriptUpdate(second));

    expect(emitSessionTranscriptUpdate({ sessionFile: "/tmp/session.jsonl" })).toBeUndefined();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "user", message: { role: "user", content: "prompt" }, expected: undefined },
    {
      name: "tool result",
      message: { role: "toolResult", content: [{ type: "text", text: "result" }] },
      expected: undefined,
    },
    {
      name: "intermediate tool turn without a call block",
      message: { role: "assistant", content: [], stopReason: "toolUse" },
      expected: undefined,
    },
    ...["toolCall", "toolUse", "functionCall"].map((type) => ({
      name: `incomplete ${type} block`,
      message: { role: "assistant", content: [{ type }], stopReason: "error" },
      expected: undefined,
    })),
    ...["stop", "length", "error", "aborted"].map((stopReason) => ({
      name: `${stopReason} terminal assistant`,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "answer" }],
        stopReason,
      },
      expected: "run-owned",
    })),
  ])("attributes run ownership only to terminal assistants: $name", ({ message, expected }) => {
    expect(resolveTerminalAssistantTranscriptRunId(message, "  run-owned  ")).toBe(expected);
    expect(resolveTerminalAssistantTranscriptRunId(message, "  ")).toBeUndefined();
  });
});
