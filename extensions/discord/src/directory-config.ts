import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import {
  createResolvedDirectoryEntriesLister,
  type DirectoryConfigParams,
} from "openclaw/plugin-sdk/directory-config-runtime";
import { mergeDiscordAccountConfig, resolveDefaultDiscordAccountId } from "./accounts.js";

function resolveDiscordDirectoryConfigAccount(
  cfg: DirectoryConfigParams["cfg"],
  accountId?: string | null,
) {
  const resolvedAccountId = normalizeAccountId(accountId ?? resolveDefaultDiscordAccountId(cfg));
  const config = mergeDiscordAccountConfig(cfg, resolvedAccountId);
  return {
    accountId: resolvedAccountId,
    config,
    dm: config.dm,
  };
}

export const listDiscordDirectoryPeersFromConfig = createResolvedDirectoryEntriesLister<
  ReturnType<typeof resolveDiscordDirectoryConfigAccount>
>({
  kind: "user",
  resolveAccount: (cfg, accountId) => resolveDiscordDirectoryConfigAccount(cfg, accountId),
  resolveSources: (account) => {
    const allowFrom = account.config.allowFrom ?? account.config.dm?.allowFrom ?? [];
    const guildUsers = Object.values(account.config.guilds ?? {}).flatMap((guild) =>
      (guild.users ?? []).concat(
        Object.values(guild.channels ?? {}).flatMap((channel) => channel.users ?? []),
      ),
    );
    return [allowFrom, Object.keys(account.config.dms ?? {}), guildUsers];
  },
  normalizeId: (raw) => {
    const mention = raw.match(/^<@!?(\d+)>$/);
    const cleaned = (mention?.[1] ?? raw).replace(/^(discord|user):/i, "").trim();
    return /^\d+$/.test(cleaned) ? `user:${cleaned}` : null;
  },
});

export const listDiscordDirectoryGroupsFromConfig = createResolvedDirectoryEntriesLister<
  ReturnType<typeof resolveDiscordDirectoryConfigAccount>
>({
  kind: "group",
  resolveAccount: (cfg, accountId) => resolveDiscordDirectoryConfigAccount(cfg, accountId),
  resolveSources: (account) =>
    Object.values(account.config.guilds ?? {}).map((guild) => Object.keys(guild.channels ?? {})),
  normalizeId: (raw) => {
    const mention = raw.match(/^<#(\d+)>$/);
    const cleaned = (mention?.[1] ?? raw).replace(/^(discord|channel|group):/i, "").trim();
    return /^\d+$/.test(cleaned) ? `channel:${cleaned}` : null;
  },
});
