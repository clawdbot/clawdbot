import { PermissionFlagsBits } from "discord-api-types/v10";
import type { DiscordActionConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
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
const DISCORD_TEST_CFG = {} as OpenClawConfig;

function handleModerationAction(action: string, params: Record<string, unknown>) {
  return handleDiscordModerationAction(action, params, enableAllActions, DISCORD_TEST_CFG);
}

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
      handleModerationAction("ban", {
        guildId: "guild-1",
        userId: "user-1",
        senderUserId: "sender-1",
      }),
    ).rejects.toThrow("required permissions");

    expect(hasAnyGuildPermissionDiscord).toHaveBeenCalledWith(
      "guild-1",
      "sender-1",
      [PermissionFlagsBits.BanMembers],
      { cfg: DISCORD_TEST_CFG },
    );
    expect(banMemberDiscord).not.toHaveBeenCalled();
  });

  it("rejects kick when sender lacks KICK_MEMBERS", async () => {
    hasAnyGuildPermissionDiscord.mockResolvedValueOnce(false);

    await expect(
      handleModerationAction("kick", {
        guildId: "guild-1",
        userId: "user-1",
        senderUserId: "sender-1",
      }),
    ).rejects.toThrow("required permissions");

    expect(hasAnyGuildPermissionDiscord).toHaveBeenCalledWith(
      "guild-1",
      "sender-1",
      [PermissionFlagsBits.KickMembers],
      { cfg: DISCORD_TEST_CFG },
    );
    expect(kickMemberDiscord).not.toHaveBeenCalled();
  });

  it("rejects timeout when sender lacks MODERATE_MEMBERS", async () => {
    hasAnyGuildPermissionDiscord.mockResolvedValueOnce(false);

    await expect(
      handleModerationAction("timeout", {
        guildId: "guild-1",
        userId: "user-1",
        senderUserId: "sender-1",
        durationMinutes: 60,
      }),
    ).rejects.toThrow("required permissions");

    expect(hasAnyGuildPermissionDiscord).toHaveBeenCalledWith(
      "guild-1",
      "sender-1",
      [PermissionFlagsBits.ModerateMembers],
      { cfg: DISCORD_TEST_CFG },
    );
    expect(timeoutMemberDiscord).not.toHaveBeenCalled();
  });

  it("executes moderation action when sender has required permission", async () => {
    hasAnyGuildPermissionDiscord.mockResolvedValueOnce(true);
    kickMemberDiscord.mockResolvedValueOnce({ ok: true });

    await handleModerationAction("kick", {
      guildId: "guild-1",
      userId: "user-1",
      senderUserId: "sender-1",
      reason: "rule violation",
    });

    expect(hasAnyGuildPermissionDiscord).toHaveBeenCalledWith(
      "guild-1",
      "sender-1",
      [PermissionFlagsBits.KickMembers],
      { cfg: DISCORD_TEST_CFG },
    );
    expect(kickMemberDiscord).toHaveBeenCalledWith(
      {
        guildId: "guild-1",
        userId: "user-1",
        reason: "rule violation",
      },
      { cfg: DISCORD_TEST_CFG },
    );
  });

  it("forwards accountId into permission check and moderation execution", async () => {
    hasAnyGuildPermissionDiscord.mockResolvedValueOnce(true);
    timeoutMemberDiscord.mockResolvedValueOnce({ id: "user-1" });

    await handleModerationAction("timeout", {
      guildId: "guild-1",
      userId: "user-1",
      senderUserId: "sender-1",
      accountId: "ops",
      durationMinutes: 5,
    });

    expect(hasAnyGuildPermissionDiscord).toHaveBeenCalledWith(
      "guild-1",
      "sender-1",
      [PermissionFlagsBits.ModerateMembers],
      { cfg: DISCORD_TEST_CFG, accountId: "ops" },
    );
    expect(timeoutMemberDiscord).toHaveBeenCalledWith(
      {
        guildId: "guild-1",
        userId: "user-1",
        durationMinutes: 5,
        until: undefined,
        reason: undefined,
      },
      { cfg: DISCORD_TEST_CFG, accountId: "ops" },
    );
  });
});
