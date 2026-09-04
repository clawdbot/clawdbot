import { describe, expect, it } from "vitest";
import { qaChannelPlugin } from "../api.js";

describe("qa-channel thread delivery contracts", () => {
  it.each([
    {
      name: "channel thread with shared-room ChatType",
      To: "thread:qa-room/thread-1",
      NativeChannelId: "qa-room",
      ChatType: "group",
      root: "channel:qa-room",
    },
    {
      name: "direct thread with a distinct native root",
      To: "thread:/v1/dm/qa-peer/thread-1",
      NativeChannelId: "native-peer",
      ChatType: "direct",
      root: "dm:native-peer",
    },
    {
      name: "group thread without native metadata",
      To: "thread:/v1/group/qa-room/thread-1",
      ChatType: "group",
      root: "group:qa-room",
    },
  ] as const)("keeps the typed root separate from $name", (testCase) => {
    const hasRepliedRef = { value: false };
    const context = qaChannelPlugin.threading?.buildToolContext?.({
      cfg: {},
      context: testCase,
      hasRepliedRef,
    });

    expect(context).toEqual({
      currentChannelId: testCase.root,
      currentChatType: testCase.ChatType,
      currentMessagingTarget: testCase.To,
      currentThreadTs: "thread-1",
      replyToMode: "all",
      hasRepliedRef,
    });
    expect(
      qaChannelPlugin.threading?.matchesToolContextTarget?.({
        target: testCase.root,
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

  it("retains native-only context and explicit thread metadata when To is absent", () => {
    expect(
      qaChannelPlugin.threading?.buildToolContext?.({
        cfg: {},
        context: { NativeChannelId: "qa-peer", ChatType: "direct", MessageThreadId: "thread-1" },
      }),
    ).toMatchObject({
      currentChannelId: "qa-peer",
      currentChatType: "direct",
      currentMessagingTarget: undefined,
      currentThreadTs: "thread-1",
      replyToMode: "all",
    });
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
