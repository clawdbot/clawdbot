// Transcript event tests cover transcript event parsing and compaction.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emitSessionTranscriptUpdate,
  onInternalSessionTranscriptUpdate,
  onSessionTranscriptUpdate,
} from "./transcript-events.js";

const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length > 0) {
    cleanup.pop()?.();
  }
});

describe("transcript events", () => {
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
});
