import { describe, expect, it } from "vitest";
import { resolveGoogleChatDurableReplyOptions } from "./monitor-durable.js";

describe("resolveGoogleChatDurableReplyOptions", () => {
  it("enables durable final delivery when no typing preview is active", () => {
    expect(
      resolveGoogleChatDurableReplyOptions({
        payload: { text: "hello", replyToId: "thread-1" },
        infoKind: "final",
        spaceId: "spaces/AAA",
      }),
    ).toEqual({
      to: "spaces/AAA",
      replyToId: "thread-1",
      threadId: "thread-1",
    });
  });

  it("keeps typing preview delivery on the legacy edit path", () => {
    expect(
      resolveGoogleChatDurableReplyOptions({
        payload: { text: "hello" },
        infoKind: "final",
        spaceId: "spaces/AAA",
        typingMessageName: "spaces/AAA/messages/typing",
      }),
    ).toBe(false);
  });

  it("does not durable-deliver non-final chunks", () => {
    expect(
      resolveGoogleChatDurableReplyOptions({
        payload: { text: "hello" },
        infoKind: "block",
        spaceId: "spaces/AAA",
      }),
    ).toBe(false);
  });
});
