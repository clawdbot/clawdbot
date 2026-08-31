import { describe, expect, it } from "vitest";
import { qaChannelPlugin } from "../api.js";

describe("qa-channel thread delivery contracts", () => {
  it("publishes the current QA thread to message-tool delivery proof", () => {
    const hasRepliedRef = { value: false };
    const context = qaChannelPlugin.threading?.buildToolContext?.({
      cfg: {},
      context: {
        To: "thread:qa-room/thread-1",
        NativeChannelId: "qa-room",
        ChatType: "channel",
        MessageThreadId: "thread-1",
      },
      hasRepliedRef,
    });

    expect(context).toEqual({
      currentChannelId: "qa-room",
      currentChatType: "channel",
      currentMessagingTarget: "thread:qa-room/thread-1",
      currentThreadTs: "thread-1",
      replyToMode: "all",
      hasRepliedRef,
    });
    expect(
      qaChannelPlugin.threading?.matchesToolContextTarget?.({
        target: "qa-room",
        toolContext: context!,
      }),
    ).toBe(true);
    expect(
      qaChannelPlugin.threading?.matchesToolContextTarget?.({
        target: "other-room",
        toolContext: context!,
      }),
    ).toBe(false);
  });

  it("extracts thread replies as canonical QA thread targets", () => {
    expect(
      qaChannelPlugin.actions?.extractToolSend?.({
        args: {
          action: "thread-reply",
          channelId: "qa-room",
          threadId: "thread-1",
          message: "hello thread",
        },
      }),
    ).toEqual({ to: "thread:qa-room/thread-1" });
  });
});
