import type { ChannelDirectoryEntry } from "clawdbot/plugin-sdk";

import { resolveMatrixAuth } from "./matrix/client.js";

type MatrixUserResult = {
  user_id?: string;
  display_name?: string;
};

type MatrixUserDirectoryResponse = {
  results?: MatrixUserResult[];
};

type MatrixJoinedRoomsResponse = {
  joined_rooms?: string[];
};

type MatrixRoomNameState = {
  name?: string;
};

type MatrixAliasLookup = {
  room_id?: string;
};

async function fetchMatrixJson<T>(params: {
  homeserver: string;
  path: string;
  accessToken: string;
  method?: "GET" | "POST";
  body?: unknown;
}): Promise<T> {
  const res = await fetch(`${params.homeserver}${params.path}`, {
    method: params.method ?? "GET",
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
      "Content-Type": "application/json",
    },
    body: params.body ? JSON.stringify(params.body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Matrix API ${params.path} failed (${res.status}): ${text || "unknown error"}`);
  }
  return (await res.json()) as T;
}

function normalizeQuery(value?: string | null): string {
  return value?.trim().toLowerCase() ?? "";
}

export async function listMatrixDirectoryPeersLive(params: {
  cfg: unknown;
  query?: string | null;
  limit?: number | null;
}): Promise<ChannelDirectoryEntry[]> {
  const query = normalizeQuery(params.query);
  if (!query) return [];
  const auth = await resolveMatrixAuth({ cfg: params.cfg as never });
  const res = await fetchMatrixJson<MatrixUserDirectoryResponse>({
    homeserver: auth.homeserver,
    accessToken: auth.accessToken,
    path: "/_matrix/client/v3/user_directory/search",
    method: "POST",
    body: {
      search_term: query,
      limit: typeof params.limit === "number" && params.limit > 0 ? params.limit : 20,
    },
  });
  const results = res.results ?? [];
  return results
    .map((entry) => {
      const userId = entry.user_id?.trim();
      if (!userId) return null;
      return {
        kind: "user",
        id: userId,
        name: entry.display_name?.trim() || undefined,
        handle: entry.display_name ? `@${entry.display_name.trim()}` : undefined,
        raw: entry,
      } satisfies ChannelDirectoryEntry;
    })
    .filter(Boolean) as ChannelDirectoryEntry[];
}

async function resolveMatrixRoomAlias(
  homeserver: string,
  accessToken: string,
  alias: string,
): Promise<string | null> {
  try {
    const res = await fetchMatrixJson<MatrixAliasLookup>({
      homeserver,
      accessToken,
      path: `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
    });
    return res.room_id?.trim() || null;
  } catch {
    return null;
  }
}

async function fetchMatrixRoomName(
  homeserver: string,
  accessToken: string,
  roomId: string,
): Promise<string | null> {
  try {
    const res = await fetchMatrixJson<MatrixRoomNameState>({
      homeserver,
      accessToken,
      path: `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.name`,
    });
    return res.name?.trim() || null;
  } catch {
    return null;
  }
}

export async function listMatrixDirectoryGroupsLive(params: {
  cfg: unknown;
  query?: string | null;
  limit?: number | null;
}): Promise<ChannelDirectoryEntry[]> {
  const query = normalizeQuery(params.query);
  if (!query) return [];
  const auth = await resolveMatrixAuth({ cfg: params.cfg as never });
  const limit = typeof params.limit === "number" && params.limit > 0 ? params.limit : 20;

  if (query.startsWith("#")) {
    const roomId = await resolveMatrixRoomAlias(auth.homeserver, auth.accessToken, query);
    if (!roomId) return [];
    return [
      {
        kind: "group",
        id: roomId,
        name: query,
        handle: query,
      } satisfies ChannelDirectoryEntry,
    ];
  }

  if (query.startsWith("!")) {
    return [
      {
        kind: "group",
        id: query,
        name: query,
      } satisfies ChannelDirectoryEntry,
    ];
  }

  const joined = await fetchMatrixJson<MatrixJoinedRoomsResponse>({
    homeserver: auth.homeserver,
    accessToken: auth.accessToken,
    path: "/_matrix/client/v3/joined_rooms",
  });
  const rooms = joined.joined_rooms ?? [];
  const results: ChannelDirectoryEntry[] = [];

  for (const roomId of rooms) {
    const name = await fetchMatrixRoomName(auth.homeserver, auth.accessToken, roomId);
    if (!name) continue;
    if (!name.toLowerCase().includes(query)) continue;
    results.push({
      kind: "group",
      id: roomId,
      name,
      handle: `#${name}`,
    });
    if (results.length >= limit) break;
  }

  return results;
}
