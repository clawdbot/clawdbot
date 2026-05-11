import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveDiscordDmCommandAccess,
  resolveDiscordTextCommandAccess,
} from "./dm-command-auth.js";

const canViewDiscordGuildChannelMock = vi.hoisted(() => vi.fn());
type DiscordDmIngressAccess = Awaited<ReturnType<typeof resolveDiscordDmCommandAccess>>;

vi.mock("../send.permissions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../send.permissions.js")>();
  return {
    ...actual,
    canViewDiscordGuildChannel: canViewDiscordGuildChannelMock,
  };
});

function dmCommandAuthorized(result: DiscordDmIngressAccess): boolean {
  return result.senderAccess.allowed ? result.commandAccess.authorized : false;
}

describe("resolveDiscordTextCommandAccess", () => {
  const sender = {
    id: "123",
    name: "alice",
    tag: "alice#0001",
  };

  it("authorizes guild text commands from owner allowlists", async () => {
    const result = await resolveDiscordTextCommandAccess({
      accountId: "default",
      sender,
      ownerAllowFrom: ["discord:123"],
      memberAccessConfigured: false,
      memberAllowed: false,
      allowNameMatching: false,
      allowTextCommands: true,
      hasControlCommand: true,
    });
    expect(result.authorized).toBe(true);
    expect(result.shouldBlockControlCommand).toBe(false);
  });

  it("authorizes guild text commands from member access facts", async () => {
    const result = await resolveDiscordTextCommandAccess({
      accountId: "default",
      sender,
      ownerAllowFrom: [],
      memberAccessConfigured: true,
      memberAllowed: true,
      allowNameMatching: false,
      allowTextCommands: true,
      hasControlCommand: true,
    });
    expect(result.authorized).toBe(true);
    expect(result.shouldBlockControlCommand).toBe(false);
  });

  it("blocks unauthorized guild text control commands", async () => {
    const result = await resolveDiscordTextCommandAccess({
      accountId: "default",
      sender,
      ownerAllowFrom: ["discord:999"],
      memberAccessConfigured: true,
      memberAllowed: false,
      allowNameMatching: false,
      allowTextCommands: true,
      hasControlCommand: true,
    });
    expect(result.authorized).toBe(false);
    expect(result.shouldBlockControlCommand).toBe(true);
  });

  it("preserves configured mode when access groups are disabled", async () => {
    const result = await resolveDiscordTextCommandAccess({
      accountId: "default",
      sender,
      ownerAllowFrom: [],
      memberAccessConfigured: false,
      memberAllowed: false,
      allowNameMatching: false,
      cfg: { commands: { useAccessGroups: false } },
      allowTextCommands: true,
      hasControlCommand: true,
    });
    expect(result.authorized).toBe(true);
    expect(result.shouldBlockControlCommand).toBe(false);
  });
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
      readStoreAllowFrom: async () => [],
    });
  }

  it("blocks open DMs without allowlist wildcard entries", async () => {
    const result = await resolveOpenDmAccess([]);

    expect(result.senderAccess.decision).toBe("block");
    expect(dmCommandAuthorized(result)).toBe(false);
  });

  it("marks command auth true when sender is allowlisted", async () => {
    const result = await resolveOpenDmAccess(["discord:123"]);

    expect(result.senderAccess.decision).toBe("allow");
    expect(dmCommandAuthorized(result)).toBe(true);
  });

  it("blocks open DMs when configured allowlist does not match", async () => {
    const result = await resolveDiscordDmCommandAccess({
      accountId: "default",
      dmPolicy: "open",
      configuredAllowFrom: ["discord:999"],
      sender,
      allowNameMatching: false,
      readStoreAllowFrom: async () => [],
    });

    expect(result.senderAccess.decision).toBe("block");
    expect(result.senderAccess.reasonCode).toBe("dm_policy_not_allowlisted");
    expect(dmCommandAuthorized(result)).toBe(false);
  });

  it("returns pairing decision and unauthorized command auth for unknown senders", async () => {
    const result = await resolveDiscordDmCommandAccess({
      accountId: "default",
      dmPolicy: "pairing",
      configuredAllowFrom: ["discord:456"],
      sender,
      allowNameMatching: false,
      readStoreAllowFrom: async () => [],
    });

    expect(result.senderAccess.decision).toBe("pairing");
    expect(dmCommandAuthorized(result)).toBe(false);
  });

  it("authorizes sender from pairing-store allowlist entries", async () => {
    const result = await resolveDiscordDmCommandAccess({
      accountId: "default",
      dmPolicy: "pairing",
      configuredAllowFrom: [],
      sender,
      allowNameMatching: false,
      readStoreAllowFrom: async () => ["discord:123"],
    });

    expect(result.senderAccess.decision).toBe("allow");
    expect(dmCommandAuthorized(result)).toBe(true);
  });

  it("authorizes allowlist DMs from a Discord channel audience access group", async () => {
    canViewDiscordGuildChannelMock.mockResolvedValueOnce(true);

    const result = await resolveDiscordDmCommandAccess({
      accountId: "default",
      dmPolicy: "allowlist",
      configuredAllowFrom: ["accessGroup:maintainers"],
      sender,
      allowNameMatching: false,
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

    expect(canViewDiscordGuildChannelMock).toHaveBeenCalledWith("guild-1", "channel-1", "123", {
      accountId: "default",
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
    });
    expect(result.senderAccess.decision).toBe("allow");
    expect(dmCommandAuthorized(result)).toBe(true);
  });

  it("authorizes allowlist DMs from a generic message sender access group", async () => {
    const result = await resolveDiscordDmCommandAccess({
      accountId: "default",
      dmPolicy: "allowlist",
      configuredAllowFrom: ["accessGroup:owners"],
      sender,
      allowNameMatching: false,
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
    expect(result.senderAccess.decision).toBe("allow");
    expect(dmCommandAuthorized(result)).toBe(true);
  });

  it("fails closed when a Discord channel audience access group lookup rejects", async () => {
    canViewDiscordGuildChannelMock.mockRejectedValueOnce(new Error("missing intent"));

    const result = await resolveDiscordDmCommandAccess({
      accountId: "default",
      dmPolicy: "allowlist",
      configuredAllowFrom: ["accessGroup:maintainers"],
      sender,
      allowNameMatching: false,
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

    expect(result.senderAccess.decision).toBe("block");
    expect(dmCommandAuthorized(result)).toBe(false);
  });

  it("keeps open DM blocked without wildcard even when access groups are disabled", async () => {
    const result = await resolveDiscordDmCommandAccess({
      accountId: "default",
      dmPolicy: "open",
      configuredAllowFrom: [],
      sender,
      allowNameMatching: false,
      cfg: { commands: { useAccessGroups: false } },
      readStoreAllowFrom: async () => [],
    });

    expect(result.senderAccess.decision).toBe("block");
    expect(dmCommandAuthorized(result)).toBe(false);
  });
});
