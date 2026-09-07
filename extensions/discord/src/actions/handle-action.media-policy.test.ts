// Discord tests cover sender-scoped media policy propagation for guild media actions.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleDiscordMessageAction } from "./handle-action.js";
import { discordGuildActionRuntime } from "./runtime-deps.js";

const originalGuildActionRuntime = { ...discordGuildActionRuntime };

const senderRoots = ["/srv/openclaw/workspace-sender"] as const;
const mediaReadFile = async () => Buffer.from("png");
const mediaAccess = { localRoots: senderRoots, readFile: mediaReadFile };

function guildActionConfig(actions: Record<string, boolean>): OpenClawConfig {
  return { channels: { discord: { token: "tok", actions } } } as OpenClawConfig;
}

function senderScopedContext() {
  return {
    cfg: guildActionConfig({ emojiUploads: true, stickerUploads: true, events: true }),
    requesterSenderId: "sender-1",
    senderIsOwner: false,
    toolContext: { currentChannelProvider: "discord", currentChannelId: "channel:1" },
    mediaAccess,
    mediaLocalRoots: senderRoots,
    mediaReadFile,
  } as const;
}

function expectSenderMediaPolicy(opts: unknown) {
  expect(opts).toMatchObject({
    mediaAccess,
    mediaLocalRoots: senderRoots,
    mediaReadFile,
  });
}

describe("Discord guild media actions forward the sender-scoped media policy", () => {
  beforeEach(() => {
    Object.assign(discordGuildActionRuntime, originalGuildActionRuntime, {
      hasAnyChannelPermissionDiscord: vi.fn(async () => true),
      hasAnyGuildPermissionDiscord: vi.fn(async () => true),
      uploadEmojiDiscord: vi.fn(async () => ({ id: "emoji-1" })),
      uploadStickerDiscord: vi.fn(async () => ({ id: "sticker-1" })),
      resolveEventCoverImage: vi.fn(async () => "data:image/png;base64,aW1n"),
      createScheduledEventDiscord: vi.fn(async () => ({ id: "event-1" })),
    });
  });

  afterEach(() => {
    Object.assign(discordGuildActionRuntime, originalGuildActionRuntime);
  });

  it("passes the policy to the emoji upload loader options", async () => {
    const ctx = senderScopedContext();
    await handleDiscordMessageAction({
      ...ctx,
      action: "emoji-upload",
      params: { guildId: "guild-1", emojiName: "blob", media: "/srv/openclaw/workspace/other.png" },
    });

    const call = vi.mocked(discordGuildActionRuntime.uploadEmojiDiscord).mock.calls[0];
    expect(call?.[0]).toMatchObject({ mediaUrl: "/srv/openclaw/workspace/other.png" });
    expectSenderMediaPolicy(call?.[1]);
  });

  it("passes the policy to the sticker upload loader options", async () => {
    const ctx = senderScopedContext();
    await handleDiscordMessageAction({
      ...ctx,
      action: "sticker-upload",
      params: {
        guildId: "guild-1",
        stickerName: "blob",
        stickerDesc: "blob",
        stickerTags: "blob",
        media: "/srv/openclaw/workspace/other.png",
      },
    });

    const call = vi.mocked(discordGuildActionRuntime.uploadStickerDiscord).mock.calls[0];
    expect(call?.[0]).toMatchObject({ mediaUrl: "/srv/openclaw/workspace/other.png" });
    expectSenderMediaPolicy(call?.[1]);
  });

  it("passes the whole policy to the event cover loader options", async () => {
    const ctx = senderScopedContext();
    await handleDiscordMessageAction({
      ...ctx,
      action: "event-create",
      params: {
        guildId: "guild-1",
        eventName: "launch",
        startTime: "2026-01-01T00:00:00.000Z",
        location: "online",
        eventType: "external",
        image: "/srv/openclaw/workspace/other.png",
      },
    });

    const call = vi.mocked(discordGuildActionRuntime.resolveEventCoverImage).mock.calls[0];
    expect(call?.[0]).toBe("/srv/openclaw/workspace/other.png");
    expectSenderMediaPolicy(call?.[1]);
  });
});
