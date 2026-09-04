// Discord tests cover dm command auth plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveDiscordDmCommandAccess,
  resolveDiscordTextCommandAccess,
} from "./dm-command-auth.js";

const participantResolutions = vi.hoisted(
  () =>
    [] as Array<
      ReturnType<
        NonNullable<
          import("openclaw/plugin-sdk/channel-ingress-runtime").ChannelIngressIdentityDescriptor["resolveParticipant"]
        >
      >
    >,
);
vi.mock("openclaw/plugin-sdk/channel-ingress-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/channel-ingress-runtime")>();
  return {
    ...actual,
    defineStableChannelIngressIdentity: (
      params: Parameters<typeof actual.defineStableChannelIngressIdentity>[0],
    ) => {
      const identity = actual.defineStableChannelIngressIdentity(params);
      return {
        ...identity,
        resolveParticipant: (subject) => {
          const participant = identity.resolveParticipant?.(subject);
          participantResolutions.push(participant);
          return participant;
        },
      } satisfies typeof identity;
    },
  };
});

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
    expect(result.commandAccess.authorized).toBe(true);
    expect(result.commandAccess.shouldBlockControlCommand).toBe(false);
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
    expect(result.commandAccess.authorized).toBe(true);
    expect(result.commandAccess.shouldBlockControlCommand).toBe(false);
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
    expect(result.commandAccess.authorized).toBe(false);
    expect(result.commandAccess.shouldBlockControlCommand).toBe(true);
  });

  it("applies the PluralKit provenance downgrade to strict group commands", async () => {
    const ordinary = await resolveDiscordTextCommandAccess({
      accountId: "default",
      sender,
      ownerAllowFrom: ["discord:123"],
      memberAccessConfigured: false,
      memberAllowed: false,
      allowNameMatching: false,
      allowTextCommands: true,
      hasControlCommand: true,
      minIdentifierAuthentication: "verified",
    });
    const pluralKit = await resolveDiscordTextCommandAccess({
      accountId: "default",
      sender: { id: "pk-member-1", name: "Echo", isPluralKit: true },
      ownerAllowFrom: ["pk:pk-member-1"],
      memberAccessConfigured: false,
      memberAllowed: false,
      allowNameMatching: false,
      allowTextCommands: true,
      hasControlCommand: true,
      minIdentifierAuthentication: "verified",
    });

    expect(ordinary.commandAccess.authorized).toBe(true);
    expect(pluralKit.commandAccess.authorized).toBe(false);
    expect(pluralKit.commandAccess.shouldBlockControlCommand).toBe(true);
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

  it("authorizes a matching Discord tag when name matching is enabled", async () => {
    const result = await resolveDiscordDmCommandAccess({
      accountId: "default",
      dmPolicy: "allowlist",
      configuredAllowFrom: ["alice#0001"],
      sender: { id: "999", name: "alice", tag: "alice#0001" },
      allowNameMatching: true,
      readStoreAllowFrom: async () => [],
    });

    expect(result.senderAccess.allowed).toBe(true);
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

  it("authorizes PluralKit senders from prefixed pairing-store allowlist entries", async () => {
    const result = await resolveDiscordDmCommandAccess({
      accountId: "default",
      dmPolicy: "pairing",
      configuredAllowFrom: [],
      sender: {
        id: "pk-member-1",
        name: "Echo",
        tag: "Echo",
        isPluralKit: true,
      },
      allowNameMatching: false,
      readStoreAllowFrom: async () => ["pk:pk-member-1"],
    });

    expect(result.senderAccess.decision).toBe("allow");
    expect(dmCommandAuthorized(result)).toBe(true);
  });

  it("distinguishes Gateway-bound Discord ids from asserted PluralKit member ids", async () => {
    const ordinary = await resolveDiscordDmCommandAccess({
      accountId: "default",
      dmPolicy: "allowlist",
      configuredAllowFrom: ["discord:123"],
      sender,
      allowNameMatching: false,
      minIdentifierAuthentication: "verified",
      readStoreAllowFrom: async () => [],
    });
    const pluralKit = await resolveDiscordDmCommandAccess({
      accountId: "default",
      dmPolicy: "allowlist",
      configuredAllowFrom: ["pk:pk-member-1"],
      sender: { id: "pk-member-1", name: "Echo", isPluralKit: true },
      allowNameMatching: false,
      minIdentifierAuthentication: "verified",
      readStoreAllowFrom: async () => [],
    });
    const compatiblePluralKitDefault = await resolveDiscordDmCommandAccess({
      accountId: "default",
      dmPolicy: "allowlist",
      configuredAllowFrom: ["pk:pk-member-1"],
      sender: { id: "pk-member-1", name: "Echo", isPluralKit: true },
      allowNameMatching: false,
      readStoreAllowFrom: async () => [],
    });

    expect(ordinary.senderAccess.decision).toBe("allow");
    expect(pluralKit.senderAccess.decision).toBe("block");
    expect(compatiblePluralKitDefault.senderAccess.decision).toBe("allow");
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
      cfg: {},
      readStoreAllowFrom: async () => [],
    });

    expect(result.senderAccess.decision).toBe("block");
    expect(dmCommandAuthorized(result)).toBe(false);
  });
});

it.each(["user", "bot", "pluralkit-member", undefined] as const)(
  "keeps Discord participant kind %s separate without guessing",
  async (participantKind) => {
    participantResolutions.length = 0;
    await resolveDiscordDmCommandAccess({
      accountId: "default",
      dmPolicy: "open",
      configuredAllowFrom: ["*"],
      sender: {
        id: "123",
        ...(participantKind === "pluralkit-member"
          ? { isPluralKit: true }
          : { authorKind: participantKind }),
      },
      allowNameMatching: false,
      readStoreAllowFrom: async () => [],
    });
    expect(participantResolutions).toEqual([
      participantKind
        ? {
            domain: participantKind === "pluralkit-member" ? "pluralkit" : "discord",
            idKind: participantKind,
            id: "123",
          }
        : undefined,
    ]);
  },
);
