import {
  listResolvedDirectoryGroupEntriesFromMapKeys,
  listResolvedDirectoryUserEntriesFromAllowFrom,
  type DirectoryConfigParams,
} from "openclaw/plugin-sdk/directory-config-runtime";
import { resolveMergedWhatsAppAccountConfig } from "./account-config.js";
import type { WhatsAppAccountConfig } from "./account-types.js";
import { isWhatsAppGroupJid, normalizeWhatsAppTarget } from "./normalize.js";

type WhatsAppDirectoryAccount = WhatsAppAccountConfig & { accountId: string };

function resolveWhatsAppDirectoryAccount(
  cfg: DirectoryConfigParams["cfg"],
  accountId?: string | null,
): WhatsAppDirectoryAccount {
  return resolveMergedWhatsAppAccountConfig({ cfg, accountId });
}

export async function listWhatsAppDirectoryPeersFromConfig(params: DirectoryConfigParams) {
  return listResolvedDirectoryUserEntriesFromAllowFrom<WhatsAppDirectoryAccount>({
    ...params,
    resolveAccount: resolveWhatsAppDirectoryAccount,
    resolveAllowFrom: (account) => account.allowFrom,
    normalizeId: (entry) => {
      const normalized = normalizeWhatsAppTarget(entry);
      if (!normalized || isWhatsAppGroupJid(normalized)) {
        return null;
      }
      return normalized;
    },
  });
}

export async function listWhatsAppDirectoryGroupsFromConfig(params: DirectoryConfigParams) {
  return listResolvedDirectoryGroupEntriesFromMapKeys<WhatsAppDirectoryAccount>({
    ...params,
    resolveAccount: resolveWhatsAppDirectoryAccount,
    resolveGroups: (account) => account.groups,
  });
}
