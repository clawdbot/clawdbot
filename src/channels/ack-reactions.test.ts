import { describe, expect, it, vi } from "vitest";

import {
  removeAckReactionAfterReply,
  shouldAckReaction,
  shouldAckReactionForWhatsApp,
} from "./ack-reactions.js";

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

  it("skips when scope is off or none", () => {
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

    expect(
      shouldAckReaction({
        scope: "none",
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
    expect(
      shouldAckReaction({
        scope: "group-mentions",
        isDirect: false,
        isGroup: true,
        isMentionableGroup: true,
        requireMention: false,
        canDetectMention: true,
        effectiveWasMentioned: true,
      }),
    ).toBe(false);

    expect(
      shouldAckReaction({
        scope: "group-mentions",
        isDirect: false,
        isGroup: true,
        isMentionableGroup: true,
        requireMention: true,
        canDetectMention: false,
        effectiveWasMentioned: true,
      }),
    ).toBe(false);

    expect(
      shouldAckReaction({
        scope: "group-mentions",
        isDirect: false,
        isGroup: true,
        isMentionableGroup: false,
        requireMention: true,
        canDetectMention: true,
        effectiveWasMentioned: true,
      }),
    ).toBe(false);

    expect(
      shouldAckReaction({
        scope: "group-mentions",
        isDirect: false,
        isGroup: true,
        isMentionableGroup: true,
        requireMention: true,
        canDetectMention: true,
        effectiveWasMentioned: true,
      }),
    ).toBe(true);

    expect(
      shouldAckReaction({
        scope: "group-mentions",
        isDirect: false,
        isGroup: true,
        isMentionableGroup: true,
        requireMention: true,
        canDetectMention: true,
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
        directEnabled: true,
        groupMode: "mentions",
        wasMentioned: false,
        groupActivated: false,
      }),
    ).toBe(true);

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
        wasMentioned: true,
        groupActivated: false,
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
  it("honors session overrides", () => {
    // Session: NEVER overrides Global: ALWAYS
    expect(
      shouldAckReactionForWhatsApp({
        emoji: "👀",
        isDirect: false,
        isGroup: true,
        directEnabled: true,
        groupMode: "always",
        wasMentioned: false,
        groupActivated: false,
        sessionMode: "never",
      }),
    ).toBe(false);

    // Session: ALWAYS overrides Global: NEVER
    expect(
      shouldAckReactionForWhatsApp({
        emoji: "👀",
        isDirect: false,
        isGroup: true,
        directEnabled: true,
        groupMode: "never",
        wasMentioned: false,
        groupActivated: false,
        sessionMode: "always",
      }),
    ).toBe(true);

    // Session: MENTIONS in DM (effectively OFF unless mentioned, which is false)
    expect(
      shouldAckReactionForWhatsApp({
        emoji: "👀",
        isDirect: true,
        isGroup: false,
        directEnabled: true, // Globally enabled
        groupMode: "mentions",
        wasMentioned: false,
        groupActivated: false,
        sessionMode: "mentions", // Override to strict mentions
      }),
    ).toBe(false);

    // Session: MENTIONS in Group (works if mentioned)
    expect(
      shouldAckReactionForWhatsApp({
        emoji: "👀",
        isDirect: false,
        isGroup: true,
        directEnabled: true,
        groupMode: "never", // Global OFF
        wasMentioned: true, // But mentioned
        groupActivated: false,
        sessionMode: "mentions", // Session override ON (if mentioned)
      }),
    ).toBe(true);

    // Session: MENTIONS is strict - does NOT bypass via groupActivated
    expect(
      shouldAckReactionForWhatsApp({
        emoji: "👀",
        isDirect: false,
        isGroup: true,
        directEnabled: true,
        groupMode: "always",
        wasMentioned: false, // Not mentioned
        groupActivated: true, // But group is activated
        sessionMode: "mentions", // Explicit mentions = strict, no bypass
      }),
    ).toBe(false);
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
    await new Promise((resolve) => setTimeout(resolve, 0));
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
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(remove).not.toHaveBeenCalled();
  });

  it("skips when not configured", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    removeAckReactionAfterReply({
      removeAfterReply: false,
      ackReactionPromise: Promise.resolve(true),
      ackReactionValue: "👀",
      remove,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(remove).not.toHaveBeenCalled();
  });
});
