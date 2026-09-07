// Ack reaction tests cover acknowledgement reaction behavior for inbound channel events.
import { describe, expect, it, vi } from "vitest";
import {
  createAckReactionHandle,
  removeAckReactionHandleAfterReply,
  removeAckReactionAfterReply,
  shouldAckReaction,
} from "./ack-reactions.js";

const flushMicrotasks = async () => {
  await Promise.resolve();
};

describe("shouldAckReaction", () => {
  it("honors direct and group-all scopes", () => {
    expect(
      shouldAckReaction({
        scope: "direct",
        isDirect: true,
        isGroup: false,
        isMentionableGroup: false,
        canDetectMention: false,
        effectiveWasMentioned: false,
      }),
    ).toBe(true);

    expect(
      shouldAckReaction({
        scope: "group-all",
        isDirect: false,
        isGroup: true,
        isMentionableGroup: true,
        canDetectMention: false,
        effectiveWasMentioned: false,
      }),
    ).toBe(true);
  });

  it("skips when scope is off", () => {
    expect(
      shouldAckReaction({
        scope: "off",
        isDirect: true,
        isGroup: true,
        isMentionableGroup: true,
        canDetectMention: true,
        effectiveWasMentioned: true,
      }),
    ).toBe(false);
  });

  it.each([
    ["all", true],
    ["direct", false],
    ["group-all", false],
    ["group-mentions", false],
    ["off", false],
  ] as const)("applies %s scope to ambient room events", (scope, expected) => {
    expect(
      shouldAckReaction({
        scope,
        inboundEventKind: "room_event",
        isDirect: false,
        isGroup: true,
        isMentionableGroup: true,
        canDetectMention: true,
        effectiveWasMentioned: false,
      }),
    ).toBe(expected);
  });

  it("defaults to group-mentions gating", () => {
    expect(
      shouldAckReaction({
        scope: undefined,
        isDirect: false,
        isGroup: true,
        isMentionableGroup: true,
        canDetectMention: true,
        effectiveWasMentioned: true,
      }),
    ).toBe(true);
  });

  it("requires mention gating for group-mentions", () => {
    const groupMentionsScope = {
      scope: "group-mentions" as const,
      isDirect: false,
      isGroup: true,
      isMentionableGroup: true,
      canDetectMention: true,
      effectiveWasMentioned: true,
    };

    // A group that answers every message still acks the ones addressing the
    // agent: whether the group requires a mention is a separate policy.
    expect(shouldAckReaction(groupMentionsScope)).toBe(true);

    expect(
      shouldAckReaction({
        ...groupMentionsScope,
        canDetectMention: false,
      }),
    ).toBe(false);

    expect(
      shouldAckReaction({
        ...groupMentionsScope,
        isMentionableGroup: false,
      }),
    ).toBe(false);

    expect(
      shouldAckReaction({
        ...groupMentionsScope,
      }),
    ).toBe(true);

    expect(
      shouldAckReaction({
        ...groupMentionsScope,
        effectiveWasMentioned: false,
      }),
    ).toBe(false);

    expect(
      shouldAckReaction({
        ...groupMentionsScope,
        effectiveWasMentioned: false,
        shouldBypassMention: true,
      }),
    ).toBe(true);
  });
});

describe("createAckReactionHandle", () => {
  it("tracks a successful ack send", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const remove = vi.fn().mockResolvedValue(undefined);

    const handle = createAckReactionHandle({
      ackReactionValue: " 👀 ",
      send,
      remove,
    });

    expect(handle).toEqual({
      ackReactionPromise: handle?.ackReactionPromise,
      ackReactionValue: "👀",
      remove,
    });
    expect(send).toHaveBeenCalledTimes(1);
    await expect(handle?.ackReactionPromise).resolves.toBe(true);
  });

  it("tracks a failed ack send without throwing", async () => {
    const error = new Error("nope");
    const onSendError = vi.fn();

    const handle = createAckReactionHandle({
      ackReactionValue: "👀",
      send: vi.fn().mockRejectedValue(error),
      remove: vi.fn().mockResolvedValue(undefined),
      onSendError,
    });

    await expect(handle?.ackReactionPromise).resolves.toBe(false);
    expect(onSendError).toHaveBeenCalledWith(error);
  });

  it("skips empty ack values", () => {
    const handle = createAckReactionHandle({
      ackReactionValue: " ",
      send: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    });

    expect(handle).toBeNull();
  });
});

describe("removeAckReactionAfterReply", () => {
  it("removes only when ack succeeded", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();
    removeAckReactionAfterReply({
      removeAfterReply: true,
      ackReactionPromise: Promise.resolve(true),
      ackReactionValue: "👀",
      remove,
      onError,
    });
    await flushMicrotasks();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("skips removal when ack did not happen", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    removeAckReactionAfterReply({
      removeAfterReply: true,
      ackReactionPromise: Promise.resolve(false),
      ackReactionValue: "👀",
      remove,
    });
    await flushMicrotasks();
    expect(remove).not.toHaveBeenCalled();
  });
});

describe("removeAckReactionHandleAfterReply", () => {
  it("removes through an ack handle", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    removeAckReactionHandleAfterReply({
      removeAfterReply: true,
      ackReaction: {
        ackReactionPromise: Promise.resolve(true),
        ackReactionValue: "👀",
        remove,
      },
    });

    await flushMicrotasks();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
