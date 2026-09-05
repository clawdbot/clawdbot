// Feishu plugin module implements directory behavior.
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ClawdbotConfig } from "../runtime-api.js";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import {
  listFeishuDirectoryGroups,
  listFeishuDirectoryPeers,
  type FeishuDirectoryGroup,
  type FeishuDirectoryPeer,
} from "./directory.static.js";

const MAX_FEISHU_DIRECTORY_PAGES = 100;

export async function listFeishuDirectoryPeersLive(params: {
  cfg: ClawdbotConfig;
  query?: string;
  limit?: number;
  accountId?: string;
  fallbackToStatic?: boolean;
}): Promise<FeishuDirectoryPeer[]> {
  const account = resolveFeishuAccount({ cfg: params.cfg, accountId: params.accountId });
  if (!account.configured) {
    return listFeishuDirectoryPeers(params);
  }

  try {
    const client = createFeishuClient(account);
    const peers: FeishuDirectoryPeer[] = [];
    const limit = params.limit ?? 50;

    const response = await client.contact.user.list({
      params: {
        page_size: Math.min(limit, 50),
      },
    });

    if (response.code !== 0) {
      throw new Error(response.msg || `code ${response.code}`);
    }

    const q = normalizeLowercaseStringOrEmpty(params.query);
    for (const user of response.data?.items ?? []) {
      if (user.open_id) {
        const name = user.name || "";
        if (
          !q ||
          normalizeLowercaseStringOrEmpty(user.open_id).includes(q) ||
          normalizeLowercaseStringOrEmpty(name).includes(q)
        ) {
          peers.push({
            kind: "user",
            id: user.open_id,
            name: name || undefined,
          });
        }
      }
      if (peers.length >= limit) {
        break;
      }
    }

    return peers;
  } catch (err) {
    if (params.fallbackToStatic === false) {
      throw err instanceof Error ? err : new Error("Feishu live peer lookup failed");
    }
    return listFeishuDirectoryPeers(params);
  }
}

export async function listFeishuDirectoryGroupsLive(params: {
  cfg: ClawdbotConfig;
  query?: string;
  limit?: number;
  accountId?: string;
  fallbackToStatic?: boolean;
  filter?: (group: FeishuDirectoryGroup) => boolean;
}): Promise<FeishuDirectoryGroup[]> {
  const account = resolveFeishuAccount({ cfg: params.cfg, accountId: params.accountId });
  if (!account.configured) {
    return listFeishuDirectoryGroups(params);
  }

  try {
    const client = createFeishuClient(account);
    const groups: FeishuDirectoryGroup[] = [];
    const limit = params.limit ?? 50;
    const q = normalizeLowercaseStringOrEmpty(params.query);
    let pageToken: string | undefined;
    let pages = 0;
    const seenPageTokens = new Set<string>();
    do {
      const response = await client.im.chat.list({
        params: {
          page_size: Math.min(limit, 100),
          page_token: pageToken,
        },
      });
      if (response.code !== 0) {
        throw new Error(response.msg || `code ${response.code}`);
      }
      for (const chat of response.data?.items ?? []) {
        if (chat.chat_id) {
          const name = chat.name || "";
          const group = {
            kind: "group",
            id: chat.chat_id,
            name: name || undefined,
          } satisfies FeishuDirectoryGroup;
          const matchesQuery =
            !q ||
            normalizeLowercaseStringOrEmpty(chat.chat_id).includes(q) ||
            normalizeLowercaseStringOrEmpty(name).includes(q);
          if (matchesQuery && (!params.filter || params.filter(group))) {
            groups.push(group);
          }
        }
        if (groups.length >= limit) {
          break;
        }
      }
      pages += 1;
      const nextPageToken = response.data?.has_more ? response.data.page_token : undefined;
      if (nextPageToken && seenPageTokens.has(nextPageToken)) {
        throw new Error("Feishu live group directory returned a repeated page token");
      }
      if (nextPageToken) {
        seenPageTokens.add(nextPageToken);
      }
      pageToken = nextPageToken;
    } while (pageToken && groups.length < limit && pages < MAX_FEISHU_DIRECTORY_PAGES);
    if (pageToken && pages >= MAX_FEISHU_DIRECTORY_PAGES) {
      throw new Error("Feishu live group directory pagination limit exceeded");
    }

    return groups;
  } catch (err) {
    if (params.fallbackToStatic === false) {
      throw err instanceof Error ? err : new Error("Feishu live group lookup failed");
    }
    return listFeishuDirectoryGroups(params);
  }
}
