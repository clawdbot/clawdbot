import { describe, expect, it, vi } from "vitest";
import {
  createAckReactionHandle,
  removeAckReactionHandleAfterReply,
  removeAckReactionAfterReply,
  shouldAckReaction,
  shouldAckReactionForWhatsApp,
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
        requireMention: false,
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
        requireMention: false,
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
        requireMention: true,
        canDetectMention: true,
        effectiveWasMentioned: true,
      }),
    ).toBe(false);
  });

  it("defaults to group-mentions gating", () => {
    expect(
      shouldAckReaction({
        scope: undefined,
        isDirect: false,
        isGroup: true,
        isMentionableGroup: true,
        requireMention: true,
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
      requireMention: true,
      canDetectMention: true,
      effectiveWasMentioned: true,
    };

    expect(
      shouldAckReaction({
        ...groupMentionsScope,
        requireMention: false,
      }),
    ).toBe(false);

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
        shouldBypassMention: true,
      }),
    ).toBe(true);
  });
});

describe("shouldAckReactionForWhatsApp", () => {
  it("respects direct and group modes", () => {
    expect(
      shouldAckReactionForWhatsApp({
        emoji: "👀",
        isDirect: true,
        isGroup: false,
        directEnabled: false,
        groupMode: "mentions",
        wasMentioned: false,
        groupActivated: false,
      }),
    ).toBe(false);

    expect(
      shouldAckReactionForWhatsApp({
        emoji: "👀",
        isDirect: false,
        isGroup: true,
        directEnabled: true,
        groupMode: "always",
        wasMentioned: false,
        groupActivated: false,
      }),
    ).toBe(true);

    expect(
      shouldAckReactionForWhatsApp({
        emoji: "👀",
        isDirect: false,
        isGroup: true,
        directEnabled: true,
        groupMode: "never",
        wasMentioned: true,
        groupActivated: true,
      }),
    ).toBe(false);
  });

  it("honors mentions or activation for group-mentions", () => {
    expect(
      shouldAckReactionForWhatsApp({
        emoji: "👀",
        isDirect: false,
        isGroup: true,
        directEnabled: true,
        groupMode: "mentions",
        wasMentioned: false,
        groupActivated: true,
      }),
    ).toBe(true);

    expect(
      shouldAckReactionForWhatsApp({
        emoji: "👀",
        isDirect: false,
        isGroup: true,
        directEnabled: true,
        groupMode: "mentions",
        wasMentioned: false,
        groupActivated: false,
      }),
    ).toBe(false);
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
