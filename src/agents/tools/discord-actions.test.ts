import { describe, expect, it, vi } from "vitest";

import type { DiscordActionConfig } from "../../config/config.js";
import { handleDiscordGuildAction } from "./discord-actions-guild.js";
import { handleDiscordMessagingAction } from "./discord-actions-messaging.js";

const createChannelDiscord = vi.fn(async () => ({
  id: "new-channel",
  name: "test",
  type: 0,
}));
const createThreadDiscord = vi.fn(async () => ({}));
const deleteChannelDiscord = vi.fn(async () => ({ ok: true, channelId: "C1" }));
const deleteMessageDiscord = vi.fn(async () => ({}));
const editChannelDiscord = vi.fn(async () => ({
  id: "C1",
  name: "edited",
}));
const editMessageDiscord = vi.fn(async () => ({}));
const fetchChannelPermissionsDiscord = vi.fn(async () => ({}));
const fetchReactionsDiscord = vi.fn(async () => ({}));
const listPinsDiscord = vi.fn(async () => ({}));
const listThreadsDiscord = vi.fn(async () => ({}));
const moveChannelDiscord = vi.fn(async () => ({ ok: true }));
const pinMessageDiscord = vi.fn(async () => ({}));
const reactMessageDiscord = vi.fn(async () => ({}));
const readMessagesDiscord = vi.fn(async () => []);
const removeChannelPermissionDiscord = vi.fn(async () => ({ ok: true }));
const removeOwnReactionsDiscord = vi.fn(async () => ({ removed: ["👍"] }));
const removeReactionDiscord = vi.fn(async () => ({}));
const searchMessagesDiscord = vi.fn(async () => ({}));
const sendMessageDiscord = vi.fn(async () => ({}));
const sendPollDiscord = vi.fn(async () => ({}));
const sendStickerDiscord = vi.fn(async () => ({}));
const setChannelPermissionDiscord = vi.fn(async () => ({ ok: true }));
const unpinMessageDiscord = vi.fn(async () => ({}));

vi.mock("../../discord/send.js", () => ({
  createChannelDiscord: (...args: unknown[]) => createChannelDiscord(...args),
  createThreadDiscord: (...args: unknown[]) => createThreadDiscord(...args),
  deleteChannelDiscord: (...args: unknown[]) => deleteChannelDiscord(...args),
  deleteMessageDiscord: (...args: unknown[]) => deleteMessageDiscord(...args),
  editChannelDiscord: (...args: unknown[]) => editChannelDiscord(...args),
  editMessageDiscord: (...args: unknown[]) => editMessageDiscord(...args),
  fetchChannelPermissionsDiscord: (...args: unknown[]) =>
    fetchChannelPermissionsDiscord(...args),
  fetchReactionsDiscord: (...args: unknown[]) => fetchReactionsDiscord(...args),
  listPinsDiscord: (...args: unknown[]) => listPinsDiscord(...args),
  listThreadsDiscord: (...args: unknown[]) => listThreadsDiscord(...args),
  moveChannelDiscord: (...args: unknown[]) => moveChannelDiscord(...args),
  pinMessageDiscord: (...args: unknown[]) => pinMessageDiscord(...args),
  reactMessageDiscord: (...args: unknown[]) => reactMessageDiscord(...args),
  readMessagesDiscord: (...args: unknown[]) => readMessagesDiscord(...args),
  removeChannelPermissionDiscord: (...args: unknown[]) =>
    removeChannelPermissionDiscord(...args),
  removeOwnReactionsDiscord: (...args: unknown[]) =>
    removeOwnReactionsDiscord(...args),
  removeReactionDiscord: (...args: unknown[]) => removeReactionDiscord(...args),
  searchMessagesDiscord: (...args: unknown[]) => searchMessagesDiscord(...args),
  sendMessageDiscord: (...args: unknown[]) => sendMessageDiscord(...args),
  sendPollDiscord: (...args: unknown[]) => sendPollDiscord(...args),
  sendStickerDiscord: (...args: unknown[]) => sendStickerDiscord(...args),
  setChannelPermissionDiscord: (...args: unknown[]) =>
    setChannelPermissionDiscord(...args),
  unpinMessageDiscord: (...args: unknown[]) => unpinMessageDiscord(...args),
}));

const enableAllActions = () => true;

const disabledActions = (key: keyof DiscordActionConfig) => key !== "reactions";

describe("handleDiscordMessagingAction", () => {
  it("adds reactions", async () => {
    await handleDiscordMessagingAction(
      "react",
      {
        channelId: "C1",
        messageId: "M1",
        emoji: "✅",
      },
      enableAllActions,
    );
    expect(reactMessageDiscord).toHaveBeenCalledWith("C1", "M1", "✅");
  });

  it("removes reactions on empty emoji", async () => {
    await handleDiscordMessagingAction(
      "react",
      {
        channelId: "C1",
        messageId: "M1",
        emoji: "",
      },
      enableAllActions,
    );
    expect(removeOwnReactionsDiscord).toHaveBeenCalledWith("C1", "M1");
  });

  it("removes reactions when remove flag set", async () => {
    await handleDiscordMessagingAction(
      "react",
      {
        channelId: "C1",
        messageId: "M1",
        emoji: "✅",
        remove: true,
      },
      enableAllActions,
    );
    expect(removeReactionDiscord).toHaveBeenCalledWith("C1", "M1", "✅");
  });

  it("rejects removes without emoji", async () => {
    await expect(
      handleDiscordMessagingAction(
        "react",
        {
          channelId: "C1",
          messageId: "M1",
          emoji: "",
          remove: true,
        },
        enableAllActions,
      ),
    ).rejects.toThrow(/Emoji is required/);
  });

  it("respects reaction gating", async () => {
    await expect(
      handleDiscordMessagingAction(
        "react",
        {
          channelId: "C1",
          messageId: "M1",
          emoji: "✅",
        },
        disabledActions,
      ),
    ).rejects.toThrow(/Discord reactions are disabled/);
  });
});

const channelsEnabled = (key: keyof DiscordActionConfig) => key === "channels";
const channelsDisabled = () => false;

describe("handleDiscordGuildAction - channel management", () => {
  it("creates a channel", async () => {
    const result = await handleDiscordGuildAction(
      "channelCreate",
      {
        guildId: "G1",
        name: "test-channel",
        type: 0,
        topic: "Test topic",
      },
      channelsEnabled,
    );
    expect(createChannelDiscord).toHaveBeenCalledWith({
      guildId: "G1",
      name: "test-channel",
      type: 0,
      parentId: undefined,
      topic: "Test topic",
      position: undefined,
      nsfw: undefined,
    });
    expect(result.details).toMatchObject({ ok: true });
  });

  it("respects channel gating for channelCreate", async () => {
    await expect(
      handleDiscordGuildAction(
        "channelCreate",
        { guildId: "G1", name: "test" },
        channelsDisabled,
      ),
    ).rejects.toThrow(/Discord channel management is disabled/);
  });

  it("edits a channel", async () => {
    await handleDiscordGuildAction(
      "channelEdit",
      {
        channelId: "C1",
        name: "new-name",
        topic: "new topic",
      },
      channelsEnabled,
    );
    expect(editChannelDiscord).toHaveBeenCalledWith({
      channelId: "C1",
      name: "new-name",
      topic: "new topic",
      position: undefined,
      parentId: undefined,
      nsfw: undefined,
      rateLimitPerUser: undefined,
    });
  });

  it("clears the channel parent when parentId is null", async () => {
    await handleDiscordGuildAction(
      "channelEdit",
      {
        channelId: "C1",
        parentId: null,
      },
      channelsEnabled,
    );
    expect(editChannelDiscord).toHaveBeenCalledWith({
      channelId: "C1",
      name: undefined,
      topic: undefined,
      position: undefined,
      parentId: null,
      nsfw: undefined,
      rateLimitPerUser: undefined,
    });
  });

  it("clears the channel parent when clearParent is true", async () => {
    await handleDiscordGuildAction(
      "channelEdit",
      {
        channelId: "C1",
        clearParent: true,
      },
      channelsEnabled,
    );
    expect(editChannelDiscord).toHaveBeenCalledWith({
      channelId: "C1",
      name: undefined,
      topic: undefined,
      position: undefined,
      parentId: null,
      nsfw: undefined,
      rateLimitPerUser: undefined,
    });
  });

  it("deletes a channel", async () => {
    await handleDiscordGuildAction(
      "channelDelete",
      { channelId: "C1" },
      channelsEnabled,
    );
    expect(deleteChannelDiscord).toHaveBeenCalledWith("C1");
  });

  it("moves a channel", async () => {
    await handleDiscordGuildAction(
      "channelMove",
      {
        guildId: "G1",
        channelId: "C1",
        parentId: "P1",
        position: 5,
      },
      channelsEnabled,
    );
    expect(moveChannelDiscord).toHaveBeenCalledWith({
      guildId: "G1",
      channelId: "C1",
      parentId: "P1",
      position: 5,
    });
  });

  it("clears the channel parent on move when parentId is null", async () => {
    await handleDiscordGuildAction(
      "channelMove",
      {
        guildId: "G1",
        channelId: "C1",
        parentId: null,
      },
      channelsEnabled,
    );
    expect(moveChannelDiscord).toHaveBeenCalledWith({
      guildId: "G1",
      channelId: "C1",
      parentId: null,
      position: undefined,
    });
  });

  it("clears the channel parent on move when clearParent is true", async () => {
    await handleDiscordGuildAction(
      "channelMove",
      {
        guildId: "G1",
        channelId: "C1",
        clearParent: true,
      },
      channelsEnabled,
    );
    expect(moveChannelDiscord).toHaveBeenCalledWith({
      guildId: "G1",
      channelId: "C1",
      parentId: null,
      position: undefined,
    });
  });

  it("creates a category with type=4", async () => {
    await handleDiscordGuildAction(
      "categoryCreate",
      { guildId: "G1", name: "My Category" },
      channelsEnabled,
    );
    expect(createChannelDiscord).toHaveBeenCalledWith({
      guildId: "G1",
      name: "My Category",
      type: 4,
      position: undefined,
    });
  });

  it("edits a category", async () => {
    await handleDiscordGuildAction(
      "categoryEdit",
      { categoryId: "CAT1", name: "Renamed Category" },
      channelsEnabled,
    );
    expect(editChannelDiscord).toHaveBeenCalledWith({
      channelId: "CAT1",
      name: "Renamed Category",
      position: undefined,
    });
  });

  it("deletes a category", async () => {
    await handleDiscordGuildAction(
      "categoryDelete",
      { categoryId: "CAT1" },
      channelsEnabled,
    );
    expect(deleteChannelDiscord).toHaveBeenCalledWith("CAT1");
  });

  it("sets channel permissions for role", async () => {
    await handleDiscordGuildAction(
      "channelPermissionSet",
      {
        channelId: "C1",
        targetId: "R1",
        targetType: "role",
        allow: "1024",
        deny: "2048",
      },
      channelsEnabled,
    );
    expect(setChannelPermissionDiscord).toHaveBeenCalledWith({
      channelId: "C1",
      targetId: "R1",
      targetType: 0,
      allow: "1024",
      deny: "2048",
    });
  });

  it("sets channel permissions for member", async () => {
    await handleDiscordGuildAction(
      "channelPermissionSet",
      {
        channelId: "C1",
        targetId: "U1",
        targetType: "member",
        allow: "1024",
      },
      channelsEnabled,
    );
    expect(setChannelPermissionDiscord).toHaveBeenCalledWith({
      channelId: "C1",
      targetId: "U1",
      targetType: 1,
      allow: "1024",
      deny: undefined,
    });
  });

  it("removes channel permissions", async () => {
    await handleDiscordGuildAction(
      "channelPermissionRemove",
      { channelId: "C1", targetId: "R1" },
      channelsEnabled,
    );
    expect(removeChannelPermissionDiscord).toHaveBeenCalledWith("C1", "R1");
  });
});
