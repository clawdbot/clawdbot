import { afterEach, describe, expect, it, vi } from "vitest";
import { emitSessionTranscriptUpdate, onSessionTranscriptUpdate } from "./transcript-events.js";

const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length > 0) {
    cleanup.pop()?.();
  }
});

describe("transcript events", () => {
  it("emits trimmed session file updates", () => {
    const listener = vi.fn();
    cleanup.push(onSessionTranscriptUpdate(listener));

    emitSessionTranscriptUpdate("  /tmp/session.jsonl  ");

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ sessionFile: "/tmp/session.jsonl" });
  });

  it("includes optional session metadata when provided", () => {
    const listener = vi.fn();
    cleanup.push(onSessionTranscriptUpdate(listener));

    emitSessionTranscriptUpdate({
      sessionFile: "  /tmp/session.jsonl  ",
      sessionKey: "  agent:main:main  ",
      message: { role: "assistant", content: "hi" },
      messageId: "  msg-1  ",
      messageSeq: 2,
    });

    expect(listener).toHaveBeenCalledWith({
      sessionFile: "/tmp/session.jsonl",
      sessionKey: "agent:main:main",
      message: { role: "assistant", content: "hi" },
      messageId: "msg-1",
      messageSeq: 2,
    });
  });

  it("drops invalid message sequence values", () => {
    const listener = vi.fn();
    cleanup.push(onSessionTranscriptUpdate(listener));

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
    cleanup.push(onSessionTranscriptUpdate(first));
    cleanup.push(onSessionTranscriptUpdate(second));

    expect(emitSessionTranscriptUpdate("/tmp/session.jsonl")).toBeUndefined();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});
