// Mattermost plugin module implements directory behavior.
import { isPrivateNetworkOptInEnabled } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { listMattermostAccountIds, resolveMattermostAccount } from "./accounts.js";
import {
  createMattermostClient,
  fetchMattermostMe,
  type MattermostChannel,
  type MattermostClient,
  type MattermostUser,
} from "./client.js";
import type { ChannelDirectoryEntry, OpenClawConfig, RuntimeEnv } from "./runtime-api.js";

type MattermostDirectoryParams = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  query?: string | null;
  limit?: number | null;
  runtime: RuntimeEnv;
};

function buildClient(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): MattermostClient | null {
  const account = resolveMattermostAccount({ cfg: params.cfg, accountId: params.accountId });
  if (!account.enabled || !account.botToken || !account.baseUrl) {
    return null;
  }
  return createMattermostClient({
    baseUrl: account.baseUrl,
    botToken: account.botToken,
    allowPrivateNetwork: isPrivateNetworkOptInEnabled(account.config),
  });
}

/**
 * Build clients from ALL enabled accounts (deduplicated by token).
 *
 * We always scan every account because:
 * - Private channels are only visible to bots that are members
 * - The requesting agent's account may have an expired/invalid token
 *
 * This means a single healthy bot token is enough for directory discovery.
 */
function buildClients(params: MattermostDirectoryParams): MattermostClient[] {
  const accountIds = listMattermostAccountIds(params.cfg);
  const seen = new Set<string>();
  const clients: MattermostClient[] = [];
  for (const id of accountIds) {
    const client = buildClient({ cfg: params.cfg, accountId: id });
    if (client && !seen.has(client.token)) {
      seen.add(client.token);
      clients.push(client);
    }
  }
  return clients;
}

/**
 * List channels (public + private) visible to any configured bot account.
 *
 * NOTE: Uses per_page=200 which covers most instances. Mattermost does not
 * return a "has more" indicator, so very large instances (200+ channels per bot)
 * may see incomplete results. Pagination can be added if needed.
 */
export async function listMattermostDirectoryGroups(
  params: MattermostDirectoryParams,
): Promise<ChannelDirectoryEntry[]> {
  const clients = buildClients(params);
  if (!clients.length) {
    return [];
  }
  const q = normalizeLowercaseStringOrEmpty(params.query);
  const seenIds = new Set<string>();
  const entries: ChannelDirectoryEntry[] = [];

  for (const client of clients) {
    try {
      const me = await fetchMattermostMe(client);
      const channels = await client.request<MattermostChannel[]>(
        `/users/${me.id}/channels?per_page=200`,
      );
      for (const ch of channels) {
        if (ch.type !== "O" && ch.type !== "P") {
          continue;
        }
        if (seenIds.has(ch.id)) {
          continue;
        }
        if (q) {
          const name = normalizeLowercaseStringOrEmpty(ch.name);
          const display = normalizeLowercaseStringOrEmpty(ch.display_name);
          if (!name.includes(q) && !display.includes(q)) {
            continue;
          }
        }
        seenIds.add(ch.id);
        entries.push({
          kind: "group" as const,
          id: `channel:${ch.id}`,
          name: ch.name ?? undefined,
          handle: ch.display_name ?? undefined,
        });
      }
    } catch (err) {
      // Token may be expired/revoked — skip this account and try others
      console.debug?.(
        "[mattermost-directory] listGroups: skipping account:",
        (err as Error)?.message,
      );
      continue;
    }
  }
  return params.limit && params.limit > 0 ? entries.slice(0, params.limit) : entries;
}

/**
 * List team members as peer directory entries.
 *
 * Uses only the first available client since all bots in a team see the same
 * user list (unlike channels where membership varies). Uses the first team
 * returned — multi-team setups will only see members from that team.
 *
 * Uses paginated member listing with per_page=200, the Mattermost API maximum.
 */
export async function listMattermostDirectoryPeers(
  params: MattermostDirectoryParams,
): Promise<ChannelDirectoryEntry[]> {
  const clients = buildClients(params);
  if (!clients.length) {
    return [];
  }
  // All bots see the same user list, so one client suffices (unlike channels
  // where private channel membership varies per bot).
  const client = clients[0];
  if (!client) {
    return [];
  }
  try {
    const me = await fetchMattermostMe(client);
    const teams = await client.request<{ id: string }[]>("/users/me/teams");
    if (!teams.length) {
      return [];
    }
    // Uses first team — multi-team setups may need iteration in the future
    const team = teams[0];
    if (!team) {
      return [];
    }
    const teamId = team.id;
    const q = normalizeLowercaseStringOrEmpty(params.query);

    let users: MattermostUser[];
    if (q) {
      users = await client.request<MattermostUser[]>("/users/search", {
        method: "POST",
        body: JSON.stringify({ term: q, team_id: teamId }),
      });
    } else {
      const pageSize = 200;
      const userIds: string[] = [];
      for (let page = 0; ; page += 1) {
        const pageMembers = await client.request<ReadonlyArray<{ user_id: string }>>(
          `/teams/${teamId}/members?page=${page}&per_page=${pageSize}`,
        );
        for (const member of pageMembers) {
          if (member.user_id !== me.id) {
            userIds.push(member.user_id);
          }
        }
        if (pageMembers.length < pageSize) {
          break;
        }
      }
      if (!userIds.length) {
        return [];
      }
      users = [];
      for (let index = 0; index < userIds.length; index += pageSize) {
        const userIdBatch = userIds.slice(index, index + pageSize);
        users.push(
          ...(await client.request<MattermostUser[]>("/users/ids", {
            method: "POST",
            body: JSON.stringify(userIdBatch),
          })),
        );
      }
    }

    const entries = users
      .filter((u) => u.id !== me.id)
      .map((u) => ({
        kind: "user" as const,
        id: `user:${u.id}`,
        name: u.username ?? undefined,
        handle:
          [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || u.nickname || undefined,
      }));
    return params.limit && params.limit > 0 ? entries.slice(0, params.limit) : entries;
  } catch (err) {
    console.debug?.("[mattermost-directory] listPeers failed:", (err as Error)?.message);
    return [];
  }
}
