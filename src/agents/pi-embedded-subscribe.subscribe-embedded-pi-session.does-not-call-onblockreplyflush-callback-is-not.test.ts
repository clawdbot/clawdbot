import { describe, expect, it, vi } from "vitest";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

type StubSession = {
  subscribe: (fn: (evt: unknown) => void) => () => void;
};

type SessionEventHandler = (evt: unknown) => void;

describe("subscribeEmbeddedPiSession", () => {
  it("does not call onBlockReplyFlush when callback is not provided", () => {
    let handler: SessionEventHandler | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const onBlockReply = vi.fn();

    // No onBlockReplyFlush provided
    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run-no-flush",
      onBlockReply,
      blockReplyBreak: "text_end",
    });

    // Missing onBlockReplyFlush should still accept streaming events.
    expect(
      handler?.({
        type: "tool_execution_start",
        toolName: "bash",
        toolCallId: "tool-no-flush",
        args: { command: "echo test" },
      }),
    ).toBeUndefined();
  });
});
