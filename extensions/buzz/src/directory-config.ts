import type {
  ChannelDirectoryEntry,
  DirectoryConfigParams,
} from "openclaw/plugin-sdk/directory-runtime";
import { buildBuzzTarget, parseBuzzTarget } from "./target.js";
import { resolveBuzzAccount } from "./types.js";

function applyQueryAndLimit(
  entries: ChannelDirectoryEntry[],
  params: DirectoryConfigParams,
): ChannelDirectoryEntry[] {
  const query = params.query?.trim().toLowerCase() ?? "";
  const limit =
    typeof params.limit === "number" && params.limit > 0 ? Math.floor(params.limit) : undefined;
  const results: ChannelDirectoryEntry[] = [];
  for (const entry of entries) {
    if (
      query &&
      !entry.id.toLowerCase().includes(query) &&
      !entry.name?.toLowerCase().includes(query)
    ) {
      continue;
    }
    results.push(entry);
    if (limit !== undefined && results.length >= limit) {
      break;
    }
  }
  return results;
}

export async function listBuzzDirectoryPeersFromConfig(
  _params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  return [];
}

export async function listBuzzDirectoryGroupsFromConfig(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  const account = resolveBuzzAccount({ cfg: params.cfg, accountId: params.accountId });
  const entries = Object.entries(account.config.groups ?? {})
    .filter(([, config]) => config.enabled !== false)
    .map(([roomId]) => {
      const id = parseBuzzTarget(roomId);
      return {
        kind: "group",
        id: buildBuzzTarget(id),
        name: id,
        raw: { roomId: id },
      } satisfies ChannelDirectoryEntry;
    })
    .toSorted((a, b) => a.id.localeCompare(b.id));
  return applyQueryAndLimit(entries, params);
}
