// Slack tests cover channel.actions plugin behavior.
import { describe, expect, it } from "vitest";
import { slackPlugin } from "./channel.js";
import { SLACK_CHANNEL } from "./setup-shared.js";

describe("slackPlugin.actions.requiresTrustedRequesterSender", () => {
  const requiresTrustedRequesterSender = slackPlugin.actions?.requiresTrustedRequesterSender;
  if (!requiresTrustedRequesterSender) {
    throw new Error("slack actions.requiresTrustedRequesterSender unavailable");
  }

  it.each(["channel-create", "channel-edit", "addParticipant", "kick", "channel-delete"])(
    "requires a trusted sender for Slack channel-management action %s",
    (action) => {
      expect(
        requiresTrustedRequesterSender({
          action: action as never,
          toolContext: { currentChannelProvider: SLACK_CHANNEL },
        }),
      ).toBe(true);
    },
  );

  it("does not require a trusted sender for non-management Slack actions", () => {
    expect(
      requiresTrustedRequesterSender({
        action: "read",
        toolContext: { currentChannelProvider: SLACK_CHANNEL },
      }),
    ).toBe(false);
  });

  it("does not require a trusted sender for management actions from other providers", () => {
    expect(
      requiresTrustedRequesterSender({
        action: "addParticipant",
        toolContext: { currentChannelProvider: "discord" },
      }),
    ).toBe(false);
  });
});
