import { describe, expect, it } from "vitest";
import { resolveSlackThreadContext, resolveSlackThreadTargets } from "./threading.js";

describe("resolveSlackThreadTargets", () => {
  function expectAutoCreatedTopLevelThreadTsBehavior(replyToMode: "off" | "first" | "batched") {
    const { replyThreadTs, statusThreadTs, isThreadReply } = resolveSlackThreadTargets({
      replyToMode,
      message: {
        type: "message",
        channel: "C1",
        ts: "123",
        thread_ts: "123",
      },
    });

    expect(isThreadReply).toBe(false);
    expect(replyThreadTs).toBeUndefined();
    expect(statusThreadTs).toBeUndefined();
  }

  it("threads replies when message is already threaded", () => {
    const { replyThreadTs, statusThreadTs } = resolveSlackThreadTargets({
      replyToMode: "off",
      message: {
        type: "message",
        channel: "C1",
        ts: "123",
        thread_ts: "456",
      },
    });

    expect(replyThreadTs).toBe("456");
    expect(statusThreadTs).toBe("456");
  });

  it("threads top-level replies when mode is all", () => {
    const { replyThreadTs, statusThreadTs } = resolveSlackThreadTargets({
      replyToMode: "all",
      message: {
        type: "message",
        channel: "C1",
        ts: "123",
      },
    });

    expect(replyThreadTs).toBe("123");
    expect(statusThreadTs).toBe("123");
  });

  it("does not thread status indicator when reply threading is off", () => {
    const { replyThreadTs, statusThreadTs } = resolveSlackThreadTargets({
      replyToMode: "off",
      message: {
        type: "message",
        channel: "C1",
        ts: "123",
      },
    });

    expect(replyThreadTs).toBeUndefined();
    expect(statusThreadTs).toBeUndefined();
  });

  it("does not treat auto-created top-level thread_ts as a real thread when mode is off", () => {
    expectAutoCreatedTopLevelThreadTsBehavior("off");
  });

  it("keeps first-mode behavior for auto-created top-level thread_ts", () => {
    expectAutoCreatedTopLevelThreadTsBehavior("first");
  });

  it("keeps batched-mode behavior for auto-created top-level thread_ts", () => {
    expectAutoCreatedTopLevelThreadTsBehavior("batched");
  });

  it("sets messageThreadId for top-level messages when replyToMode is all", () => {
    const context = resolveSlackThreadContext({
      replyToMode: "all",
      message: {
        type: "message",
        channel: "C1",
        ts: "123",
      },
    });

    expect(context.isThreadReply).toBe(false);
    expect(context.messageThreadId).toBe("123");
    expect(context.replyToId).toBe("123");
  });

  it("prefers thread_ts as messageThreadId for replies", () => {
    const context = resolveSlackThreadContext({
      replyToMode: "off",
      message: {
        type: "message",
        channel: "C1",
        ts: "123",
        thread_ts: "456",
      },
    });

    expect(context.isThreadReply).toBe(true);
    expect(context.messageThreadId).toBe("456");
    expect(context.replyToId).toBe("456");
  });
});
