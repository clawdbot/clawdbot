import { describe, expect, it, vi } from "vitest";
import {
  evaluateMattermostMentionGate,
  mapMattermostChannelTypeToChatType,
} from "./monitor-gating.js";

describe("mattermost monitor gating", () => {
  it("maps mattermost channel types to chat types", () => {
    expect(mapMattermostChannelTypeToChatType("D")).toBe("direct");
    expect(mapMattermostChannelTypeToChatType("G")).toBe("group");
    expect(mapMattermostChannelTypeToChatType("P")).toBe("group");
    expect(mapMattermostChannelTypeToChatType("O")).toBe("channel");
    expect(mapMattermostChannelTypeToChatType(undefined)).toBe("channel");
  });

  it("drops non-mentioned traffic when onchar is enabled but not triggered", () => {
    const resolveRequireMention = vi.fn(() => true);

    expect(
      evaluateMattermostMentionGate({
        kind: "channel",
        cfg: {} as never,
        accountId: "default",
        channelId: "chan-1",
        resolveRequireMention,
        wasMentioned: false,
        isControlCommand: false,
        commandAuthorized: false,
        oncharEnabled: true,
        oncharTriggered: false,
        canDetectMention: true,
      }),
    ).toEqual({
      shouldRequireMention: true,
      shouldBypassMention: false,
      effectiveWasMentioned: false,
      dropReason: "onchar-not-triggered",
    });
  });

  it("bypasses mention for authorized control commands and allows direct chats", () => {
    const resolveRequireMention = vi.fn(() => true);

    expect(
      evaluateMattermostMentionGate({
        kind: "channel",
        cfg: {} as never,
        accountId: "default",
        channelId: "chan-1",
        resolveRequireMention,
        wasMentioned: false,
        isControlCommand: true,
        commandAuthorized: true,
        oncharEnabled: false,
        oncharTriggered: false,
        canDetectMention: true,
      }),
    ).toEqual({
      shouldRequireMention: true,
      shouldBypassMention: true,
      effectiveWasMentioned: true,
      dropReason: null,
    });

    expect(
      evaluateMattermostMentionGate({
        kind: "direct",
        cfg: {} as never,
        accountId: "default",
        channelId: "chan-1",
        resolveRequireMention,
        wasMentioned: false,
        isControlCommand: false,
        commandAuthorized: false,
        oncharEnabled: false,
        oncharTriggered: false,
        canDetectMention: true,
      }),
    ).toMatchObject({
      shouldRequireMention: false,
      dropReason: null,
    });
  });
});
