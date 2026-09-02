import { describe, expect, it } from "vitest";
import { applySharedChannelFieldHelp } from "./schema.channel-field-help.js";

describe("applySharedChannelFieldHelp", () => {
  it("fills help on channel and per-account leaves", () => {
    const next = applySharedChannelFieldHelp({
      "channels.whatsapp.enabled": { advanced: false },
      "channels.whatsapp.accounts.*.allowFrom": { advanced: false },
      "channels.defaults.groupPolicy": { advanced: true },
    });

    expect(next["channels.whatsapp.enabled"]?.help).toContain("Turn this channel on or off");
    expect(next["channels.whatsapp.accounts.*.allowFrom"]?.help).toContain("Sender ids allowed");
    expect(next["channels.defaults.groupPolicy"]?.help).toContain("groups");
  });

  it("keeps the tier and any other hint fields the path already carries", () => {
    const next = applySharedChannelFieldHelp({
      "channels.whatsapp.allowFrom": { advanced: false, presentation: "phone-number" },
    });

    expect(next["channels.whatsapp.allowFrom"]).toMatchObject({
      advanced: false,
      presentation: "phone-number",
    });
  });

  it("never overrides help a channel declared for itself", () => {
    const declared = 'Direct message access control ("pairing" recommended).';
    const next = applySharedChannelFieldHelp({
      "channels.whatsapp.dmPolicy": { advanced: false, help: declared },
    });

    expect(next["channels.whatsapp.dmPolicy"]?.help).toBe(declared);
  });

  it("keeps shared help neutral when channel enum contracts differ", () => {
    const next = applySharedChannelFieldHelp({
      "channels.telegram.reactionNotifications": { advanced: true },
      "channels.whatsapp.replyToMode": { advanced: true },
    });

    expect(next["channels.telegram.reactionNotifications"]?.help).toBe(
      "Which inbound reactions reach the agent.",
    );
    expect(next["channels.whatsapp.replyToMode"]?.help).toBe(
      "When to attach a native reply to the message that triggered the run.",
    );
  });

  it("treats empty help as a deliberate suppression, not a missing value", () => {
    const next = applySharedChannelFieldHelp({
      "channels.irc.enabled": { advanced: false, help: "" },
    });

    expect(next["channels.irc.enabled"]?.help).toBe("");
  });

  it("leaves deeper channel paths and non-channel paths alone", () => {
    const hints = {
      // A guild channel's `enabled` is narrower than the channel's own.
      "channels.discord.guilds.*.channels.*.enabled": { advanced: true },
      "channels.slack.dm.enabled": { advanced: true },
      "gateway.enabled": { advanced: true },
      channels: { advanced: true },
    };

    expect(applySharedChannelFieldHelp(hints)).toEqual(hints);
  });
});
