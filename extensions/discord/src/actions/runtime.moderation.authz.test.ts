import { PermissionFlagsBits } from "discord-api-types/v10";
import type { DiscordActionConfig } from "openclaw/plugin-sdk/config-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  discordModerationActionRuntime,
  handleDiscordModerationAction,
} from "./runtime.moderation.js";

const originalDiscordModerationActionRuntime = { ...discordModerationActionRuntime };
const banMemberDiscord = vi.fn(async () => ({ ok: true }));
const kickMemberDiscord = vi.fn(async () => ({ ok: true }));
const timeoutMemberDiscord = vi.fn(async () => ({ id: "user-1" }));
const hasAnyGuildPermissionDiscord = vi.fn(async () => false);

const enableAllActions = (_key: keyof DiscordActionConfig, _defaultValue = true) => true;

describe("discord moderation sender authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(discordModerationActionRuntime, originalDiscordModerationActionRuntime, {
      banMemberDiscord,
      kickMemberDiscord,
      timeoutMemberDiscord,
      hasAnyGuildPermissionDiscord,
    });
  });

  it("rejects ban when sender lacks BAN_MEMBERS", async () => {
    hasAnyGuildPermissionDiscord.mockResolvedValueOnce(false);

    await expect(
      handleDiscordModerationAction(
        "ban",
        {
          guildId: "guild-1",
          userId: "user-1",
          senderUserId: "sender-1",
        },
        enableAllActions,
      ),
    ).rejects.toThrow("required permissions");

    expect(hasAnyGuildPermissionDiscord).toHaveBeenCalledWith(
      "guild-1",
      "sender-1",
      [PermissionFlagsBits.BanMembers],
      undefined,
    );
    expect(banMemberDiscord).not.toHaveBeenCalled();
  });

  it("rejects kick when sender lacks KICK_MEMBERS", async () => {
    hasAnyGuildPermissionDiscord.mockResolvedValueOnce(false);

    await expect(
      handleDiscordModerationAction(
        "kick",
        {
          guildId: "guild-1",
          userId: "user-1",
          senderUserId: "sender-1",
        },
        enableAllActions,
      ),
    ).rejects.toThrow("required permissions");

    expect(hasAnyGuildPermissionDiscord).toHaveBeenCalledWith(
      "guild-1",
      "sender-1",
      [PermissionFlagsBits.KickMembers],
      undefined,
    );
    expect(kickMemberDiscord).not.toHaveBeenCalled();
  });

  it("rejects timeout when sender lacks MODERATE_MEMBERS", async () => {
    hasAnyGuildPermissionDiscord.mockResolvedValueOnce(false);

    await expect(
      handleDiscordModerationAction(
        "timeout",
        {
          guildId: "guild-1",
          userId: "user-1",
          senderUserId: "sender-1",
          durationMinutes: 60,
        },
        enableAllActions,
      ),
    ).rejects.toThrow("required permissions");

    expect(hasAnyGuildPermissionDiscord).toHaveBeenCalledWith(
      "guild-1",
      "sender-1",
      [PermissionFlagsBits.ModerateMembers],
      undefined,
    );
    expect(timeoutMemberDiscord).not.toHaveBeenCalled();
  });

  it("executes moderation action when sender has required permission", async () => {
    hasAnyGuildPermissionDiscord.mockResolvedValueOnce(true);
    kickMemberDiscord.mockResolvedValueOnce({ ok: true });

    await handleDiscordModerationAction(
      "kick",
      {
        guildId: "guild-1",
        userId: "user-1",
        senderUserId: "sender-1",
        reason: "rule violation",
      },
      enableAllActions,
    );

    expect(hasAnyGuildPermissionDiscord).toHaveBeenCalledWith(
      "guild-1",
      "sender-1",
      [PermissionFlagsBits.KickMembers],
      undefined,
    );
    expect(kickMemberDiscord).toHaveBeenCalledWith({
      guildId: "guild-1",
      userId: "user-1",
      reason: "rule violation",
    });
  });

  it("forwards accountId into permission check and moderation execution", async () => {
    hasAnyGuildPermissionDiscord.mockResolvedValueOnce(true);
    timeoutMemberDiscord.mockResolvedValueOnce({ id: "user-1" });

    await handleDiscordModerationAction(
      "timeout",
      {
        guildId: "guild-1",
        userId: "user-1",
        senderUserId: "sender-1",
        accountId: "ops",
        durationMinutes: 5,
      },
      enableAllActions,
    );

    expect(hasAnyGuildPermissionDiscord).toHaveBeenCalledWith(
      "guild-1",
      "sender-1",
      [PermissionFlagsBits.ModerateMembers],
      { accountId: "ops" },
    );
    expect(timeoutMemberDiscord).toHaveBeenCalledWith(
      {
        guildId: "guild-1",
        userId: "user-1",
        durationMinutes: 5,
        until: undefined,
        reason: undefined,
      },
      { accountId: "ops" },
    );
  });
});
