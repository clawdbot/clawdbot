// Line helper module supports directory config behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createResolvedDirectoryEntriesLister } from "openclaw/plugin-sdk/directory-config-runtime";
import { resolveLineAccount } from "./accounts.js";
import { resolveLineGroupLookupIds } from "./group-keys.js";
import { inferLineTargetChatType, normalizeLineMessagingTarget } from "./messaging-target.js";
import type { ResolvedLineAccount } from "./types.js";

function resolveLineDirectoryAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedLineAccount {
  return resolveLineAccount({ cfg, accountId: accountId ?? undefined });
}

// A directory entry must be an address someone can send to, so the send-target pair
// below decides membership: an allowlist entry naming no conversation (`*`,
// `accessGroup:<name>`) drops out, and widening what counts as a target widens this.
function toLineDirectoryId(entry: string, kind: "direct" | "group"): string | null {
  const id = normalizeLineMessagingTarget(entry);
  return id && inferLineTargetChatType(id) === kind ? id : null;
}

export const listLineDirectoryPeersFromConfig =
  createResolvedDirectoryEntriesLister<ResolvedLineAccount>({
    kind: "user",
    resolveAccount: resolveLineDirectoryAccount,
    // Senders reach the bot through three allowlist scopes and the ingress gate reads
    // all of them, so a directory built from fewer would omit configured people.
    resolveSources: (account) => [
      account.config.allowFrom ?? [],
      account.config.groupAllowFrom ?? [],
      ...Object.values(account.config.groups ?? {}).map((group) => group?.allowFrom ?? []),
    ],
    normalizeId: (entry) => toLineDirectoryId(entry, "direct"),
  });

export const listLineDirectoryGroupsFromConfig =
  createResolvedDirectoryEntriesLister<ResolvedLineAccount>({
    kind: "group",
    resolveAccount: resolveLineDirectoryAccount,
    resolveSources: (account) => [Object.keys(account.config.groups ?? {})],
    // A group entry may be keyed bare or with the `group:`/`room:` prefix the config
    // lookup also accepts; that lookup owns which conversation id either spelling means.
    normalizeId: (entry) => toLineDirectoryId(resolveLineGroupLookupIds(entry)[0] ?? "", "group"),
  });
