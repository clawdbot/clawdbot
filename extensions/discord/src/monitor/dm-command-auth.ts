import {
  type AccessGroupMembershipFact,
  type ChannelIngressEventInput,
  type ChannelIngressIdentifierKind,
  createChannelIngressResolver,
  defineStableChannelIngressIdentity,
  type ChannelIngressIdentitySubjectInput,
  type ResolveChannelMessageIngressParams,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { RequestClient } from "../internal/discord.js";
import { canViewDiscordGuildChannel } from "../send.permissions.js";
import { normalizeDiscordAllowList } from "./allow-list.js";

const DISCORD_ALLOW_LIST_PREFIXES = ["discord:", "user:", "pk:"];
const DISCORD_CHANNEL_ID = "discord";
const DISCORD_USER_ID_KIND = "stable-id" satisfies ChannelIngressIdentifierKind;
const DISCORD_USER_NAME_KIND = "username" satisfies ChannelIngressIdentifierKind;

export type DiscordDmPolicy = "open" | "pairing" | "allowlist" | "disabled";

function normalizeDiscordIdEntry(entry: string): string | null {
  const text = entry.trim();
  if (!text) {
    return null;
  }
  const maybeId = text.replace(/^<@!?/, "").replace(/>$/, "");
  if (/^\d+$/.test(maybeId)) {
    return maybeId;
  }
  const prefix = DISCORD_ALLOW_LIST_PREFIXES.find((entryPrefix) => text.startsWith(entryPrefix));
  if (prefix) {
    const candidate = text.slice(prefix.length).trim();
    return candidate || null;
  }
  return null;
}

function normalizeDiscordNameEntry(entry: string): string | null {
  const text = entry.trim();
  if (!text || text === "*" || normalizeDiscordIdEntry(text)) {
    return null;
  }
  const nameSlug = normalizeDiscordAllowList([text], DISCORD_ALLOW_LIST_PREFIXES)
    ?.names.values()
    .next().value;
  return typeof nameSlug === "string" && nameSlug ? nameSlug : null;
}

function normalizeDiscordNameSubject(value: string): string | null {
  const nameSlug = normalizeDiscordAllowList([value], DISCORD_ALLOW_LIST_PREFIXES)
    ?.names.values()
    .next().value;
  return typeof nameSlug === "string" && nameSlug ? nameSlug : null;
}

const discordIngressIdentity = defineStableChannelIngressIdentity({
  key: "discordUserId",
  kind: DISCORD_USER_ID_KIND,
  normalizeEntry: normalizeDiscordIdEntry,
  normalizeSubject: (value) => value.trim() || null,
  sensitivity: "pii",
  aliases: (
    [
      ["discordUserName", normalizeDiscordNameEntry],
      ["discordUserTag", () => null],
    ] as const
  ).map(([key, normalizeEntry]) => ({
    key,
    kind: DISCORD_USER_NAME_KIND,
    normalizeEntry,
    normalizeSubject: normalizeDiscordNameSubject,
    dangerous: true,
    sensitivity: "pii",
  })),
});

function createDiscordDmIngressSubject(sender: {
  id: string;
  name?: string;
  tag?: string;
}): ChannelIngressIdentitySubjectInput {
  return {
    stableId: sender.id,
    aliases: {
      discordUserName: sender.name,
      discordUserTag: sender.tag,
    },
  };
}

function createDiscordDynamicAccessGroupResolver(params: {
  cfg?: OpenClawConfig;
  token?: string;
  rest?: RequestClient;
}): ResolveChannelMessageIngressParams["resolveAccessGroupMembership"] {
  if (!params.cfg) {
    return undefined;
  }
  const cfg = params.cfg;
  return async ({ name, group, accountId, subject }) => {
    if (group.type !== "discord.channelAudience") {
      return false;
    }
    const senderId = String(subject.stableId ?? "").trim();
    if (!senderId) {
      return false;
    }
    const membership = group.membership ?? "canViewChannel";
    if (membership !== "canViewChannel") {
      return false;
    }
    try {
      return await canViewDiscordGuildChannel(group.guildId, group.channelId, senderId, {
        cfg,
        accountId,
        token: params.token,
        rest: params.rest,
      });
    } catch (err) {
      logVerbose(`discord: accessGroup:${name} lookup failed for user ${senderId}: ${String(err)}`);
      throw err;
    }
  };
}

function createDiscordIngressResolver(params: {
  accountId: string;
  cfg?: OpenClawConfig;
  token?: string;
  rest?: RequestClient;
  readStoreAllowFrom?: ResolveChannelMessageIngressParams["readStoreAllowFrom"];
  useDefaultPairingStore?: boolean;
}) {
  return createChannelIngressResolver({
    channelId: DISCORD_CHANNEL_ID,
    accountId: params.accountId,
    identity: discordIngressIdentity,
    cfg: params.cfg,
    resolveAccessGroupMembership: createDiscordDynamicAccessGroupResolver({
      cfg: params.cfg,
      token: params.token,
      rest: params.rest,
    }),
    ...(params.readStoreAllowFrom ? { readStoreAllowFrom: params.readStoreAllowFrom } : {}),
    ...(params.useDefaultPairingStore !== undefined
      ? { useDefaultPairingStore: params.useDefaultPairingStore }
      : {}),
  });
}

function syntheticAccessGroupMembership(
  groupName: string,
  allowed: boolean,
): AccessGroupMembershipFact {
  return allowed
    ? {
        kind: "matched",
        groupName,
        source: "dynamic",
        matchedEntryIds: [groupName],
      }
    : {
        kind: "not-matched",
        groupName,
        source: "dynamic",
      };
}

export async function resolveDiscordDmCommandAccess(params: {
  accountId: string;
  dmPolicy: DiscordDmPolicy;
  configuredAllowFrom: string[];
  sender: { id: string; name?: string; tag?: string };
  allowNameMatching: boolean;
  cfg?: OpenClawConfig;
  token?: string;
  rest?: RequestClient;
  readStoreAllowFrom?: ResolveChannelMessageIngressParams["readStoreAllowFrom"];
  eventKind?: ChannelIngressEventInput["kind"];
}) {
  return await createDiscordIngressResolver({
    accountId: params.accountId,
    cfg: params.cfg,
    token: params.token,
    rest: params.rest,
    readStoreAllowFrom: params.readStoreAllowFrom,
    useDefaultPairingStore: params.readStoreAllowFrom == null,
  }).message({
    subject: createDiscordDmIngressSubject(params.sender),
    conversation: {
      kind: "direct",
      id: params.sender.id,
    },
    event: {
      kind: params.eventKind ?? "native-command",
      authMode: "inbound",
      mayPair: true,
    },
    dmPolicy: params.dmPolicy,
    groupPolicy: "disabled",
    policy: {
      mutableIdentifierMatching: params.allowNameMatching ? "enabled" : "disabled",
    },
    allowFrom: params.configuredAllowFrom,
    command: {
      hasControlCommand: false,
      modeWhenAccessGroupsOff: "configured",
    },
  });
}

export async function resolveDiscordTextCommandAccess(params: {
  accountId: string;
  sender: { id: string; name?: string; tag?: string };
  ownerAllowFrom?: string[];
  memberAccessConfigured: boolean;
  memberAllowed: boolean;
  allowNameMatching: boolean;
  allowTextCommands: boolean;
  hasControlCommand: boolean;
  cfg?: OpenClawConfig;
  token?: string;
  rest?: RequestClient;
}) {
  const ownerAllowFrom = (params.ownerAllowFrom ?? []).filter((entry) => entry.trim() !== "*");
  const memberAccessGroup = "discord-member-access";
  const commandGroup = params.memberAccessConfigured ? [`accessGroup:${memberAccessGroup}`] : [];
  const accessGroupMembership = params.memberAccessConfigured
    ? [syntheticAccessGroupMembership(memberAccessGroup, params.memberAllowed)]
    : [];
  const result = await createDiscordIngressResolver({
    accountId: params.accountId,
    cfg: params.cfg,
    token: params.token,
    rest: params.rest,
  }).command({
    subject: createDiscordDmIngressSubject(params.sender),
    conversation: {
      kind: "group",
      id: "discord-command",
    },
    accessGroupMembership,
    dmPolicy: "allowlist",
    groupPolicy: "allowlist",
    policy: {
      mutableIdentifierMatching: params.allowNameMatching ? "enabled" : "disabled",
    },
    allowFrom: ownerAllowFrom,
    groupAllowFrom: commandGroup,
    command: {
      allowTextCommands: params.allowTextCommands,
      hasControlCommand: params.hasControlCommand,
      modeWhenAccessGroupsOff: "configured",
    },
  });
  return result.commandAccess;
}
