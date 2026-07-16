import { describe, expect, it } from "vitest";
import { findPreferredDmConversationByUserId } from "./conversation-store-helpers.js";
import type { MSTeamsConversationStoreEntry } from "./conversation-store.js";

function entry(params: {
  conversationId: string;
  userId?: string;
  aadObjectId?: string;
  conversationType?: string;
  lastSeenAt?: string;
}): MSTeamsConversationStoreEntry {
  return {
    conversationId: params.conversationId,
    reference: {
      user: {
        id: params.userId ?? "user-1",
        aadObjectId: params.aadObjectId ?? "aad-1",
      },
      conversation: {
        id: params.conversationId,
        conversationType: params.conversationType,
      },
      lastSeenAt: params.lastSeenAt,
    },
  };
}

describe("findPreferredDmConversationByUserId", () => {
  it("returns null for empty id", () => {
    expect(findPreferredDmConversationByUserId([], "  ")).toBeNull();
  });

  it("returns null when no entries match", () => {
    const entries = [entry({ conversationId: "conv-1", aadObjectId: "other-user" })];
    expect(findPreferredDmConversationByUserId(entries, "aad-1")).toBeNull();
  });

  it("returns a personal DM conversation by aadObjectId", () => {
    const entries = [
      entry({
        conversationId: "dm-conv",
        aadObjectId: "aad-target",
        conversationType: "personal",
      }),
    ];
    const result = findPreferredDmConversationByUserId(entries, "aad-target");
    expect(result?.conversationId).toBe("dm-conv");
  });

  it("returns a personal DM conversation by user.id", () => {
    const entries = [
      entry({
        conversationId: "dm-conv",
        userId: "user-target",
        aadObjectId: "other",
        conversationType: "personal",
      }),
    ];
    const result = findPreferredDmConversationByUserId(entries, "user-target");
    expect(result?.conversationId).toBe("dm-conv");
  });

  it("does NOT return a channel conversation for a user lookup (#54520)", () => {
    // This is the core bug: user sends messages in both a DM and a channel.
    // The channel conversation also carries the user's aadObjectId.
    // findPreferredDmByUserId must NOT return the channel conversation.
    const entries = [
      entry({
        conversationId: "19:channel@thread.tacv2",
        aadObjectId: "aad-target",
        conversationType: "channel",
        lastSeenAt: "2026-03-25T21:00:00.000Z",
      }),
    ];
    const result = findPreferredDmConversationByUserId(entries, "aad-target");
    expect(result).toBeNull();
  });

  it("does NOT return a groupChat conversation for a user lookup (#54520)", () => {
    const entries = [
      entry({
        conversationId: "19:group@thread.tacv2",
        aadObjectId: "aad-target",
        conversationType: "groupChat",
        lastSeenAt: "2026-03-25T21:00:00.000Z",
      }),
    ];
    const result = findPreferredDmConversationByUserId(entries, "aad-target");
    expect(result).toBeNull();
  });

  it("prefers personal DM over channel even when channel is more recent (#54520)", () => {
    // Reproduces the exact race: channel message arrives after DM, but the
    // DM conversation should still be returned.
    const entries = [
      entry({
        conversationId: "dm-conv",
        aadObjectId: "aad-target",
        conversationType: "personal",
        lastSeenAt: "2026-03-25T20:00:00.000Z",
      }),
      entry({
        conversationId: "19:channel@thread.tacv2",
        aadObjectId: "aad-target",
        conversationType: "channel",
        lastSeenAt: "2026-03-25T21:00:00.000Z",
      }),
    ];
    const result = findPreferredDmConversationByUserId(entries, "aad-target");
    expect(result?.conversationId).toBe("dm-conv");
  });

  it("prefers personal DM over groupChat even when groupChat is more recent", () => {
    const entries = [
      entry({
        conversationId: "dm-conv",
        aadObjectId: "aad-target",
        conversationType: "personal",
        lastSeenAt: "2026-03-25T20:00:00.000Z",
      }),
      entry({
        conversationId: "19:group@thread.tacv2",
        aadObjectId: "aad-target",
        conversationType: "groupChat",
        lastSeenAt: "2026-03-25T21:00:00.000Z",
      }),
    ];
    const result = findPreferredDmConversationByUserId(entries, "aad-target");
    expect(result?.conversationId).toBe("dm-conv");
  });

  it("prefers the freshest personal DM when multiple exist", () => {
    const entries = [
      entry({
        conversationId: "dm-old",
        aadObjectId: "aad-target",
        conversationType: "personal",
        lastSeenAt: "2026-03-25T20:00:00.000Z",
      }),
      entry({
        conversationId: "dm-new",
        aadObjectId: "aad-target",
        conversationType: "personal",
        lastSeenAt: "2026-03-25T21:00:00.000Z",
      }),
    ];
    const result = findPreferredDmConversationByUserId(entries, "aad-target");
    expect(result?.conversationId).toBe("dm-new");
  });

  it("falls back to unknown-type entries when no personal conversations exist", () => {
    // Legacy entries without conversationType should still be usable as a
    // fallback to avoid breaking existing deployments.
    const entries = [
      entry({
        conversationId: "legacy-conv",
        aadObjectId: "aad-target",
        // No conversationType set (legacy entry)
      }),
    ];
    const result = findPreferredDmConversationByUserId(entries, "aad-target");
    expect(result?.conversationId).toBe("legacy-conv");
  });

  it("prefers personal over unknown-type entries", () => {
    const entries = [
      entry({
        conversationId: "legacy-conv",
        aadObjectId: "aad-target",
        lastSeenAt: "2026-03-25T21:00:00.000Z",
        // No conversationType
      }),
      entry({
        conversationId: "dm-conv",
        aadObjectId: "aad-target",
        conversationType: "personal",
        lastSeenAt: "2026-03-25T20:00:00.000Z",
      }),
    ];
    const result = findPreferredDmConversationByUserId(entries, "aad-target");
    expect(result?.conversationId).toBe("dm-conv");
  });

  it("does NOT fall back to channel/group when no personal or unknown entries exist", () => {
    const entries = [
      entry({
        conversationId: "19:channel@thread.tacv2",
        aadObjectId: "aad-target",
        conversationType: "channel",
        lastSeenAt: "2026-03-25T21:00:00.000Z",
      }),
      entry({
        conversationId: "19:group@thread.tacv2",
        aadObjectId: "aad-target",
        conversationType: "groupChat",
        lastSeenAt: "2026-03-25T20:00:00.000Z",
      }),
    ];
    const result = findPreferredDmConversationByUserId(entries, "aad-target");
    expect(result).toBeNull();
  });
});
