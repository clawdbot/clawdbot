import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelType, type Client, type Message } from "../internal/discord.js";
import { clearDiscordChannelInfoCacheForTest } from "./message-channel-info.test-support.js";

let resolveDiscordChannelInfo: typeof import("./message-utils.js").resolveDiscordChannelInfo;
let resolveDiscordMessageChannelId: typeof import("./message-utils.js").resolveDiscordMessageChannelId;

beforeAll(async () => {
  ({ resolveDiscordChannelInfo, resolveDiscordMessageChannelId } =
    await import("./message-utils.js"));
});

function asMessage(payload: Record<string, unknown>): Message {
  return payload as unknown as Message;
}

describe("resolveDiscordMessageChannelId", () => {
  it.each([
    {
      name: "uses message.channelId when present",
      params: { message: asMessage({ channelId: " 123 " }) },
      expected: "123",
    },
    {
      name: "falls back to message.channel_id",
      params: { message: asMessage({ channel_id: " 234 " }) },
      expected: "234",
    },
    {
      name: "falls back to message.rawData.channel_id",
      params: { message: asMessage({ rawData: { channel_id: "456" } }) },
      expected: "456",
    },
    {
      name: "falls back to eventChannelId and coerces numeric values",
      params: { message: asMessage({}), eventChannelId: 789 },
      expected: "789",
    },
  ] as const)("$name", ({ params, expected }) => {
    expect(resolveDiscordMessageChannelId(params)).toBe(expected);
  });
});

describe("resolveDiscordChannelInfo", () => {
  beforeEach(() => {
    clearDiscordChannelInfoCacheForTest();
  });

  it("caches channel lookups between calls", async () => {
    const fetchChannel = vi.fn().mockResolvedValue({ type: ChannelType.DM, name: "dm" });
    const client = { fetchChannel } as unknown as Client;

    const first = await resolveDiscordChannelInfo(client, "cache-channel-1");
    const second = await resolveDiscordChannelInfo(client, "cache-channel-1");

    expect(first).toEqual({
      type: ChannelType.DM,
      name: "dm",
      topic: undefined,
      parentId: undefined,
      ownerId: undefined,
    });
    expect(second).toEqual(first);
    expect(fetchChannel).toHaveBeenCalledTimes(1);
  });

  it("caps cached channel info entries", async () => {
    const cacheEntryLimit = 1000;
    const fetchChannel = vi.fn(async (channelId: string) => ({
      type: ChannelType.GuildText,
      name: `name-${channelId}`,
    }));
    const client = { fetchChannel } as unknown as Client;

    for (let index = 0; index <= cacheEntryLimit; index += 1) {
      await resolveDiscordChannelInfo(client, `channel-${index}`);
    }
    await resolveDiscordChannelInfo(client, "channel-0");
    await resolveDiscordChannelInfo(client, `channel-${cacheEntryLimit}`);

    expect(fetchChannel).toHaveBeenCalledTimes(cacheEntryLimit + 2);
    expect(fetchChannel).toHaveBeenNthCalledWith(cacheEntryLimit + 2, "channel-0");
  });

  it("negative-caches missing channels", async () => {
    const fetchChannel = vi.fn().mockResolvedValue(null);
    const client = { fetchChannel } as unknown as Client;

    const first = await resolveDiscordChannelInfo(client, "missing-channel");
    const second = await resolveDiscordChannelInfo(client, "missing-channel");

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(fetchChannel).toHaveBeenCalledTimes(1);
  });

  it("does not reuse cached channel info while the process clock is invalid", async () => {
    const fetchChannel = vi
      .fn()
      .mockResolvedValueOnce({ type: ChannelType.GuildText, name: "old" })
      .mockResolvedValueOnce({ type: ChannelType.GuildText, name: "fresh" });
    const client = { fetchChannel } as unknown as Client;

    const first = await resolveDiscordChannelInfo(client, "invalid-clock-channel");
    expect(first?.name).toBe("old");

    vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_001);
    const second = await resolveDiscordChannelInfo(client, "invalid-clock-channel");

    expect(second?.name).toBe("fresh");
    expect(fetchChannel).toHaveBeenCalledTimes(2);
  });

  it("does not cache channel info when the cache expiry would exceed the Date range", async () => {
    vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_000);
    const fetchChannel = vi
      .fn()
      .mockResolvedValueOnce({ type: ChannelType.GuildText, name: "first" })
      .mockResolvedValueOnce({ type: ChannelType.GuildText, name: "second" });
    const client = { fetchChannel } as unknown as Client;

    const first = await resolveDiscordChannelInfo(client, "overflow-cache-channel");
    const second = await resolveDiscordChannelInfo(client, "overflow-cache-channel");

    expect(first?.name).toBe("first");
    expect(second?.name).toBe("second");
    expect(fetchChannel).toHaveBeenCalledTimes(2);
  });
});
