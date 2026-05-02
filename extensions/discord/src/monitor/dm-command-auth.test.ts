import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveDiscordDmCommandAccess } from "./dm-command-auth.js";

const canViewDiscordGuildChannelMock = vi.hoisted(() => vi.fn());

vi.mock("../send.permissions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../send.permissions.js")>();
  return {
    ...actual,
    canViewDiscordGuildChannel: canViewDiscordGuildChannelMock,
  };
});

describe("resolveDiscordDmCommandAccess", () => {
  const sender = {
    id: "123",
    name: "alice",
    tag: "alice#0001",
  };

  beforeEach(() => {
    canViewDiscordGuildChannelMock.mockReset();
  });

  async function resolveOpenDmAccess(configuredAllowFrom: string[]) {
    return await resolveDiscordDmCommandAccess({
      accountId: "default",
      dmPolicy: "open",
      configuredAllowFrom,
      sender,
      allowNameMatching: false,
      useAccessGroups: true,
      readStoreAllowFrom: async () => [],
    });
  }

  it("blocks open DMs without allowlist wildcard entries", async () => {
    const result = await resolveOpenDmAccess([]);

    expect(result.decision).toBe("block");
    expect(result.commandAuthorized).toBe(false);
  });

  it("marks command auth true when sender is allowlisted", async () => {
    const result = await resolveOpenDmAccess(["discord:123"]);

    expect(result.decision).toBe("allow");
    expect(result.commandAuthorized).toBe(true);
  });

  it("blocks open DMs when configured allowlist does not match", async () => {
    const result = await resolveDiscordDmCommandAccess({
      accountId: "default",
      dmPolicy: "open",
      configuredAllowFrom: ["discord:999"],
      sender,
      allowNameMatching: false,
      useAccessGroups: true,
      readStoreAllowFrom: async () => [],
    });

    expect(result.decision).toBe("block");
    expect(result.allowMatch.allowed).toBe(false);
    expect(result.commandAuthorized).toBe(false);
  });

  it("returns pairing decision and unauthorized command auth for unknown senders", async () => {
    const result = await resolveDiscordDmCommandAccess({
      accountId: "default",
      dmPolicy: "pairing",
      configuredAllowFrom: ["discord:456"],
      sender,
      allowNameMatching: false,
      useAccessGroups: true,
      readStoreAllowFrom: async () => [],
    });

    expect(result.decision).toBe("pairing");
    expect(result.commandAuthorized).toBe(false);
  });

  it("authorizes sender from pairing-store allowlist entries", async () => {
    const result = await resolveDiscordDmCommandAccess({
      accountId: "default",
      dmPolicy: "pairing",
      configuredAllowFrom: [],
      sender,
      allowNameMatching: false,
      useAccessGroups: true,
      readStoreAllowFrom: async () => ["discord:123"],
    });

    expect(result.decision).toBe("allow");
    expect(result.commandAuthorized).toBe(true);
  });

  it("authorizes allowlist DMs from a Discord channel audience access group", async () => {
    canViewDiscordGuildChannelMock.mockResolvedValueOnce(true);

    const result = await resolveDiscordDmCommandAccess({
      accountId: "default",
      dmPolicy: "allowlist",
      configuredAllowFrom: ["accessGroup:maintainers"],
      sender,
      allowNameMatching: false,
      useAccessGroups: true,
      cfg: {
        accessGroups: {
          maintainers: {
            type: "discord.channelAudience",
            guildId: "guild-1",
            channelId: "channel-1",
          },
        },
      },
      token: "token",
      readStoreAllowFrom: async () => [],
    });

    expect(canViewDiscordGuildChannelMock).toHaveBeenCalledWith(
      "guild-1",
      "channel-1",
      "123",
      expect.objectContaining({ accountId: "default", token: "token" }),
    );
    expect(result.decision).toBe("allow");
    expect(result.commandAuthorized).toBe(true);
  });

  it("authorizes allowlist DMs from a generic message sender access group", async () => {
    const result = await resolveDiscordDmCommandAccess({
      accountId: "default",
      dmPolicy: "allowlist",
      configuredAllowFrom: ["accessGroup:owners"],
      sender,
      allowNameMatching: false,
      useAccessGroups: true,
      cfg: {
        accessGroups: {
          owners: {
            type: "message.senders",
            members: {
              discord: ["discord:123"],
              telegram: ["987"],
            },
          },
        },
      },
      readStoreAllowFrom: async () => [],
    });

    expect(canViewDiscordGuildChannelMock).not.toHaveBeenCalled();
    expect(result.decision).toBe("allow");
    expect(result.commandAuthorized).toBe(true);
  });

  it("fails closed when a Discord channel audience access group lookup rejects", async () => {
    canViewDiscordGuildChannelMock.mockRejectedValueOnce(new Error("missing intent"));

    const result = await resolveDiscordDmCommandAccess({
      accountId: "default",
      dmPolicy: "allowlist",
      configuredAllowFrom: ["accessGroup:maintainers"],
      sender,
      allowNameMatching: false,
      useAccessGroups: true,
      cfg: {
        accessGroups: {
          maintainers: {
            type: "discord.channelAudience",
            guildId: "guild-1",
            channelId: "channel-1",
          },
        },
      },
      readStoreAllowFrom: async () => [],
    });

    expect(result.decision).toBe("block");
    expect(result.commandAuthorized).toBe(false);
  });

  it("keeps open DM blocked without wildcard even when access groups are disabled", async () => {
    const result = await resolveDiscordDmCommandAccess({
      accountId: "default",
      dmPolicy: "open",
      configuredAllowFrom: [],
      sender,
      allowNameMatching: false,
      useAccessGroups: false,
      readStoreAllowFrom: async () => [],
    });

    expect(result.decision).toBe("block");
    expect(result.commandAuthorized).toBe(false);
  });
});
