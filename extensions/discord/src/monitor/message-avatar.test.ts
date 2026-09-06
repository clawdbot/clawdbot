import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Client, User } from "../internal/discord.js";

const mocks = vi.hoisted(() => ({
  saveRemoteMedia: vi.fn(),
  logDebug: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  saveRemoteMedia: mocks.saveRemoteMedia,
}));

vi.mock("openclaw/plugin-sdk/logging-core", () => ({
  logDebug: mocks.logDebug,
}));

const { createDiscordAvatarResolver } = await import("./message-avatar.js");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function discordUser(id: string, avatar: string | null): User {
  return { id, avatar } as User;
}

const emptyClient = { fetchGuild: vi.fn() } as unknown as Client;

beforeEach(() => {
  mocks.saveRemoteMedia.mockReset();
  mocks.logDebug.mockReset();
});

describe("createDiscordAvatarResolver", () => {
  it("downloads a DM avatar in the background and reuses it until the hash changes", async () => {
    const firstDownload = deferred<{ path: string }>();
    mocks.saveRemoteMedia.mockReturnValueOnce(firstDownload.promise);
    const resolver = createDiscordAvatarResolver();
    const firstAuthor = discordUser("user-1", "hash-1");

    expect(
      resolver.resolve({ client: emptyClient, conversationId: "dm-1", author: firstAuthor }),
    ).toBeUndefined();
    expect(
      resolver.resolve({ client: emptyClient, conversationId: "dm-1", author: firstAuthor }),
    ).toBeUndefined();
    expect(mocks.saveRemoteMedia).toHaveBeenCalledTimes(1);
    expect(mocks.saveRemoteMedia).toHaveBeenCalledWith({
      url: "https://cdn.discordapp.com/avatars/user-1/hash-1.png?size=128",
      filePathHint: "conversation-avatar.png",
      maxBytes: 256 * 1024,
      ssrfPolicy: expect.objectContaining({
        hostnameAllowlist: expect.arrayContaining(["cdn.discordapp.com"]),
      }),
    });

    firstDownload.resolve({ path: "/media/inbound/dm-avatar.png" });
    await vi.waitFor(() =>
      expect(
        resolver.resolve({ client: emptyClient, conversationId: "dm-1", author: firstAuthor }),
      ).toBe("/media/inbound/dm-avatar.png"),
    );

    mocks.saveRemoteMedia.mockResolvedValueOnce({ path: "/media/inbound/dm-avatar-new.png" });
    expect(
      resolver.resolve({
        client: emptyClient,
        conversationId: "dm-1",
        author: discordUser("user-1", "hash-2"),
      }),
    ).toBeUndefined();
    expect(mocks.saveRemoteMedia).toHaveBeenCalledTimes(2);
  });

  it("uses a lazily fetched guild icon instead of the sender avatar", async () => {
    const guildLookup = deferred<{ icon: string }>();
    const guildDownload = deferred<{ path: string }>();
    const fetchGuild = vi.fn(() => guildLookup.promise);
    const client = {
      fetchGuild,
    } as unknown as Client;
    mocks.saveRemoteMedia.mockReturnValueOnce(guildDownload.promise);
    const resolver = createDiscordAvatarResolver();
    const author = discordUser("user-1", "sender-hash");

    expect(
      resolver.resolve({
        client,
        conversationId: "channel-1",
        author,
        guildId: "guild-1",
      }),
    ).toBeUndefined();
    expect(fetchGuild).toHaveBeenCalledTimes(1);
    expect(mocks.saveRemoteMedia).not.toHaveBeenCalled();

    guildLookup.resolve({ icon: "guild-hash" });
    await vi.waitFor(() => expect(mocks.saveRemoteMedia).toHaveBeenCalledTimes(1));
    expect(mocks.saveRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://cdn.discordapp.com/icons/guild-1/guild-hash.png?size=128",
      }),
    );

    guildDownload.resolve({ path: "/media/inbound/guild-icon.png" });
    await vi.waitFor(() =>
      expect(
        resolver.resolve({
          client,
          conversationId: "channel-1",
          author,
          guildId: "guild-1",
        }),
      ).toBe("/media/inbound/guild-icon.png"),
    );
    expect(fetchGuild).toHaveBeenCalledTimes(1);
  });

  it("swallows download failures and retries on the next message", async () => {
    mocks.saveRemoteMedia
      .mockRejectedValueOnce(new Error("download failed"))
      .mockResolvedValueOnce({ path: "/media/inbound/retried.png" });
    const resolver = createDiscordAvatarResolver();
    const params = {
      client: emptyClient,
      conversationId: "dm-1",
      author: discordUser("user-1", "hash-1"),
    };

    expect(resolver.resolve(params)).toBeUndefined();
    await vi.waitFor(() =>
      expect(mocks.logDebug).toHaveBeenCalledWith(expect.stringContaining("download failed")),
    );
    expect(resolver.resolve(params)).toBeUndefined();
    await vi.waitFor(() => expect(mocks.saveRemoteMedia).toHaveBeenCalledTimes(2));
  });
});
