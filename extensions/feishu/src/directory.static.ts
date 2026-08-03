// Feishu plugin module implements directory.static behavior.
import {
  applyDirectoryQueryAndLimit,
  listDirectoryGroupEntriesFromMapKeysAndAllowFrom,
  listDirectoryUserEntriesFromAllowFrom,
  listDirectoryUserEntriesFromAllowFromAndMapKeys,
} from "openclaw/plugin-sdk/directory-runtime";
import type { ClawdbotConfig } from "../runtime-api.js";
import { resolveFeishuAccount } from "./accounts.js";
import { isFeishuGroupReadAllowed } from "./read-policy.js";
import { normalizeFeishuTarget } from "./targets.js";

export type FeishuDirectoryPeer = {
  kind: "user";
  id: string;
  name?: string;
};

export type FeishuDirectoryGroup = {
  kind: "group";
  id: string;
  name?: string;
};

function toFeishuDirectoryPeers(ids: string[]): FeishuDirectoryPeer[] {
  return ids.map((id) => ({ kind: "user", id }));
}

function toFeishuDirectoryGroups(ids: string[]): FeishuDirectoryGroup[] {
  return ids.map((id) => ({ kind: "group", id }));
}

export async function listFeishuDirectoryPeers(params: {
  cfg: ClawdbotConfig;
  query?: string;
  limit?: number;
  accountId?: string;
}): Promise<FeishuDirectoryPeer[]> {
  const account = resolveFeishuAccount({ cfg: params.cfg, accountId: params.accountId });
  const entries = listDirectoryUserEntriesFromAllowFromAndMapKeys({
    allowFrom: account.config.allowFrom,
    map: account.config.dms,
    query: params.query,
    limit: params.limit,
    normalizeAllowFromId: (entry) => normalizeFeishuTarget(entry) ?? entry,
    normalizeMapKeyId: (entry) => normalizeFeishuTarget(entry) ?? entry,
  });
  return toFeishuDirectoryPeers(entries.map((entry) => entry.id));
}

export async function listFeishuDirectoryGroups(params: {
  cfg: ClawdbotConfig;
  query?: string;
  limit?: number;
  accountId?: string;
}): Promise<FeishuDirectoryGroup[]> {
  const account = resolveFeishuAccount({ cfg: params.cfg, accountId: params.accountId });
  const entries = listDirectoryGroupEntriesFromMapKeysAndAllowFrom({
    groups: account.config.groups,
    allowFrom: account.config.groupAllowFrom,
    query: params.query,
    limit: params.limit,
  });
  return toFeishuDirectoryGroups(entries.map((entry) => entry.id));
}

export async function listAuthorizedFeishuDirectoryPeers(params: {
  cfg: ClawdbotConfig;
  query?: string;
  limit?: number;
  accountId?: string;
}): Promise<FeishuDirectoryPeer[]> {
  const account = resolveFeishuAccount({ cfg: params.cfg, accountId: params.accountId });
  const entries = listDirectoryUserEntriesFromAllowFrom({
    allowFrom: account.config.allowFrom,
    query: params.query,
    limit: params.limit,
    normalizeId: (entry) => normalizeFeishuTarget(entry) ?? entry,
  });
  return toFeishuDirectoryPeers(entries.map((entry) => entry.id));
}

export async function listAuthorizedFeishuDirectoryGroups(params: {
  cfg: ClawdbotConfig;
  query?: string;
  limit?: number;
  accountId?: string;
}): Promise<FeishuDirectoryGroup[]> {
  const account = resolveFeishuAccount({ cfg: params.cfg, accountId: params.accountId });
  const enabledGroups = Object.fromEntries(
    Object.entries(account.config.groups ?? {}).filter(([, group]) => group?.enabled !== false),
  );
  const entries = listDirectoryGroupEntriesFromMapKeysAndAllowFrom({
    groups: enabledGroups,
    allowFrom: account.config.groupAllowFrom,
  });
  const authorizedEntries = entries.filter((entry) =>
    isFeishuGroupReadAllowed(params.cfg, account, entry.id, false),
  );
  return toFeishuDirectoryGroups(
    applyDirectoryQueryAndLimit(
      authorizedEntries.map((entry) => entry.id),
      params,
    ),
  );
}
