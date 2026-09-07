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

function resolveFeishuDirectoryLimit(limit: number | undefined): number {
  // Static directory treats nonpositive limits as unlimited; provider page sizes must stay valid.
  return limit === undefined ? 50 : limit > 0 ? limit : Number.POSITIVE_INFINITY;
}

type FeishuDirectoryEntry = FeishuDirectoryGroup | FeishuDirectoryPeer;
type FeishuDirectoryPage<Item> = {
  code?: number;
  msg?: string;
  data?: {
    items?: Item[];
    has_more?: boolean;
    page_token?: string;
  };
};

async function listLiveFeishuDirectoryEntries<Item, Entry extends FeishuDirectoryEntry>(params: {
  kind: "peer" | "group";
  limit: number;
  query?: string;
  fetchPage: (pageToken?: string) => Promise<FeishuDirectoryPage<Item>>;
  toEntry: (item: Item) => Entry | undefined;
  filter?: (entry: Entry) => boolean;
}): Promise<Entry[]> {
  const entries: Entry[] = [];
  const query = normalizeLowercaseStringOrEmpty(params.query);
  const seenPageTokens = new Set<string>();
  let pageToken: string | undefined;

  for (let page = 0; page < MAX_FEISHU_DIRECTORY_PAGES; page += 1) {
    const response = await params.fetchPage(pageToken);
    if (response.code !== 0) {
      throw new Error(response.msg || `code ${response.code}`);
    }

    for (const item of response.data?.items ?? []) {
      const entry = params.toEntry(item);
      if (!entry) {
        continue;
      }
      const matchesQuery =
        !query ||
        normalizeLowercaseStringOrEmpty(entry.id).includes(query) ||
        normalizeLowercaseStringOrEmpty(entry.name).includes(query);
      if (matchesQuery && (!params.filter || params.filter(entry))) {
        entries.push(entry);
      }
      if (entries.length >= params.limit) {
        // A complete result must not fail on an unused, malformed continuation token.
        return entries;
      }
    }

    if (response.data?.has_more !== true) {
      return entries;
    }

    const nextPageToken = response.data.page_token?.trim();
    if (!nextPageToken) {
      throw new Error(`Feishu live ${params.kind} directory is missing its next page token`);
    }
    if (seenPageTokens.has(nextPageToken)) {
      throw new Error(`Feishu live ${params.kind} directory returned a repeated page token`);
    }
    seenPageTokens.add(nextPageToken);
    pageToken = nextPageToken;
  }

  throw new Error(`Feishu live ${params.kind} directory pagination limit exceeded`);
}

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
    const limit = resolveFeishuDirectoryLimit(params.limit);
    return await listLiveFeishuDirectoryEntries({
      kind: "peer",
      limit,
      query: params.query,
      fetchPage: (pageToken) =>
        client.contact.user.list({
          params: {
            page_size: Math.min(limit, 50),
            ...(pageToken ? { page_token: pageToken } : {}),
          },
        }),
      toEntry: (user) =>
        user.open_id ? { kind: "user", id: user.open_id, name: user.name || undefined } : undefined,
    });
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
    const limit = resolveFeishuDirectoryLimit(params.limit);
    return await listLiveFeishuDirectoryEntries({
      kind: "group",
      limit,
      query: params.query,
      fetchPage: (pageToken) =>
        client.im.chat.list({
          params: {
            page_size: Math.min(limit, 100),
            ...(pageToken ? { page_token: pageToken } : {}),
          },
        }),
      toEntry: (chat) =>
        chat.chat_id
          ? { kind: "group", id: chat.chat_id, name: chat.name || undefined }
          : undefined,
      filter: params.filter,
    });
  } catch (err) {
    if (params.fallbackToStatic === false) {
      throw err instanceof Error ? err : new Error("Feishu live group lookup failed");
    }
    return listFeishuDirectoryGroups(params);
  }
}
