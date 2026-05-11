import { normalizeAccountId } from "openclaw/plugin-sdk/account-resolution";
import {
  createResolvedDirectoryEntriesLister,
  type DirectoryConfigParams,
} from "openclaw/plugin-sdk/directory-config-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  mergeSlackAccountConfig,
  resolveDefaultSlackAccountId,
  resolveSlackAccountAllowFrom,
} from "./accounts.js";
import { parseSlackTarget } from "./targets.js";

function resolveSlackDirectoryConfigAccount(
  cfg: DirectoryConfigParams["cfg"],
  accountId?: string | null,
) {
  const resolvedAccountId = normalizeAccountId(accountId ?? resolveDefaultSlackAccountId(cfg));
  const config = mergeSlackAccountConfig(cfg, resolvedAccountId);
  return {
    accountId: resolvedAccountId,
    config,
    dm: config.dm,
    allowFrom: resolveSlackAccountAllowFrom({ cfg, accountId: resolvedAccountId }) ?? [],
  };
}

export const listSlackDirectoryPeersFromConfig = createResolvedDirectoryEntriesLister<
  ReturnType<typeof resolveSlackDirectoryConfigAccount>
>({
  kind: "user",
  resolveAccount: (cfg, accountId) => resolveSlackDirectoryConfigAccount(cfg, accountId),
  resolveSources: (account) => {
    const channelUsers = Object.values(account.config.channels ?? {}).flatMap(
      (channel) => channel.users ?? [],
    );
    return [account.allowFrom, Object.keys(account.config.dms ?? {}), channelUsers];
  },
  normalizeId: (raw) => {
    const mention = raw.match(/^<@([A-Z0-9]+)>$/i);
    const normalizedUserId = (mention?.[1] ?? raw).replace(/^(slack|user):/i, "").trim();
    if (!normalizedUserId) {
      return null;
    }
    const target = `user:${normalizedUserId}`;
    const normalized = parseSlackTarget(target, { defaultKind: "user" });
    return normalized?.kind === "user"
      ? `user:${normalizeLowercaseStringOrEmpty(normalized.id)}`
      : null;
  },
});

export const listSlackDirectoryGroupsFromConfig = createResolvedDirectoryEntriesLister<
  ReturnType<typeof resolveSlackDirectoryConfigAccount>
>({
  kind: "group",
  resolveAccount: (cfg, accountId) => resolveSlackDirectoryConfigAccount(cfg, accountId),
  resolveSources: (account) => [Object.keys(account.config.channels ?? {})],
  normalizeId: (raw) => {
    const normalized = parseSlackTarget(raw, { defaultKind: "channel" });
    return normalized?.kind === "channel"
      ? `channel:${normalizeLowercaseStringOrEmpty(normalized.id)}`
      : null;
  },
});
