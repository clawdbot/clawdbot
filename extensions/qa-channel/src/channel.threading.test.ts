import { describe, expect, it } from "vitest";
import { qaChannelPlugin } from "../api.js";

describe("qa-channel thread delivery contracts", () => {
  it.each<{
    name: string;
    currentMessageId?: string;
    replyToId?: string | null;
    explicit?: boolean;
    mode?: "off" | "first" | "all" | "batched";
    expected: { replyToId: string } | null;
  }>([
    {
      name: "implicit current inbound",
      currentMessageId: "queued-inbound",
      expected: { replyToId: "queued-inbound" },
    },
    {
      name: "all mode",
      currentMessageId: "queued-inbound",
      mode: "all",
      expected: { replyToId: "queued-inbound" },
    },
    { name: "off mode", currentMessageId: "queued-inbound", mode: "off", expected: null },
    { name: "first mode", currentMessageId: "queued-inbound", mode: "first", expected: null },
    { name: "batched mode", currentMessageId: "queued-inbound", mode: "batched", expected: null },
    {
      name: "explicit null opt-out",
      currentMessageId: "queued-inbound",
      replyToId: null,
      expected: null,
    },
    {
      name: "explicit target",
      currentMessageId: "queued-inbound",
      replyToId: "explicit-target",
      expected: null,
    },
    {
      name: "explicit empty target",
      currentMessageId: "queued-inbound",
      replyToId: "",
      explicit: true,
      expected: null,
    },
    {
      name: "explicit intent without target",
      currentMessageId: "queued-inbound",
      explicit: true,
      expected: null,
    },
    { name: "missing inbound", expected: null },
  ])("preserves $name during queued reply resolution", (testCase) => {
    expect(
      qaChannelPlugin.threading?.resolveReplyTransport?.({
        cfg: {},
        currentMessageId: testCase.currentMessageId,
        replyToId: testCase.replyToId,
        replyToIsExplicit: testCase.explicit,
        ...(testCase.mode ? { replyDelivery: { replyToMode: testCase.mode } } : {}),
      }),
    ).toEqual(testCase.expected);
  });

  it.each([
    {
      name: "channel thread with shared-room ChatType",
      To: "thread:qa-room/thread-1",
      NativeChannelId: "qa-room",
      ChatType: "group",
      root: "channel:qa-room",
      bareTarget: "qa-room",
      bareMatches: true,
    },
    {
      name: "direct thread with a distinct native root",
      To: "thread:/v1/dm/qa-peer/thread-1",
      NativeChannelId: "native-peer",
      ChatType: "direct",
      root: "dm:native-peer",
      bareTarget: "native-peer",
      bareMatches: false,
    },
    {
      name: "group thread without native metadata",
      To: "thread:/v1/group/qa-room/thread-1",
      ChatType: "group",
      root: "group:qa-room",
      bareTarget: "qa-room",
      bareMatches: false,
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
        target: testCase.bareTarget,
        toolContext: context!,
      }),
    ).toBe(testCase.bareMatches);
    expect(
      qaChannelPlugin.threading?.matchesToolContextTarget?.({
        target: "other-room",
        toolContext: context!,
      }),
    ).toBe(false);
    expect(
      qaChannelPlugin.threading?.resolveAutoThreadId?.({
        cfg: {},
        to: testCase.root,
        toolContext: context,
      }),
    ).toBe("thread-1");
  });

  it("keeps native source authority ahead of a divergent messaging target", () => {
    const toolContext = qaChannelPlugin.threading?.buildToolContext?.({
      cfg: {},
      context: {
        To: "thread:/v1/dm/other-peer/stale-thread",
        NativeChannelId: "native-peer",
        ChatType: "direct",
        MessageThreadId: "source-thread",
      },
    });
    for (const [target, matches, inherited] of [
      ["dm:native-peer", true, "source-thread"],
      ["thread:/v1/dm/native-peer/source-thread", true, undefined],
      ["thread:/v1/dm/native-peer/other-thread", false, undefined],
      ["dm:other-peer", false, undefined],
      ["thread:/v1/dm/other-peer/stale-thread", false, undefined],
      ["group:native-peer", false, undefined],
    ] as const) {
      expect
        .soft(
          qaChannelPlugin.threading?.matchesToolContextTarget?.({
            target,
            toolContext: toolContext!,
          }),
          target,
        )
        .toBe(matches);
      expect
        .soft(
          qaChannelPlugin.threading?.resolveAutoThreadId?.({ cfg: {}, to: target, toolContext }),
          target,
        )
        .toBe(inherited);
    }
  });

  it("inherits only with a current source and separate thread metadata", () => {
    for (const [toolContext, expected] of [
      [undefined, undefined],
      [{ currentThreadTs: "topic" }, undefined],
      [{ currentChannelId: "dm:peer" }, undefined],
      [
        { currentChannelId: "dm:peer", currentThreadTs: "topic", currentChannelProvider: "slack" },
        undefined,
      ],
      [
        {
          currentChannelId: "dm:peer",
          currentThreadTs: "topic",
          currentChannelProvider: "qa-channel",
        },
        "topic",
      ],
      [{ currentMessagingTarget: "thread:/v1/dm/peer/topic", currentThreadTs: "topic" }, "topic"],
      [{ currentChannelId: "peer", currentChatType: "direct", currentThreadTs: "topic" }, "topic"],
    ] as const) {
      expect
        .soft(
          qaChannelPlugin.threading?.resolveAutoThreadId?.({ cfg: {}, to: "dm:peer", toolContext }),
        )
        .toBe(expected);
    }
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
