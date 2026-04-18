import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveMatrixAuth } from "./matrix/client.js";
import { MatrixAuthedHttpClient } from "./matrix/sdk/http-client.js";
import { isMatrixQualifiedUserId, normalizeMatrixMessagingTarget } from "./matrix/target-ids.js";
import type { ChannelDirectoryEntry } from "./runtime-api.js";

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

type MatrixDirectoryLiveParams = {
  cfg: unknown;
  accountId?: string | null;
  query?: string | null;
  limit?: number | null;
};

type MatrixResolvedAuth = Awaited<ReturnType<typeof resolveMatrixAuth>>;

const MATRIX_DIRECTORY_TIMEOUT_MS = 10_000;

function resolveMatrixDirectoryLimit(limit?: number | null): number {
  return typeof limit === "number" && Number.isFinite(limit) && limit > 0
    ? Math.max(1, Math.floor(limit))
    : 20;
}

function createMatrixDirectoryClient(auth: MatrixResolvedAuth): MatrixAuthedHttpClient {
  return new MatrixAuthedHttpClient({
    homeserver: auth.homeserver,
    accessToken: auth.accessToken,
    ssrfPolicy: auth.ssrfPolicy,
    dispatcherPolicy: auth.dispatcherPolicy,
  });
}

async function resolveMatrixDirectoryContext(params: MatrixDirectoryLiveParams): Promise<{
  auth: MatrixResolvedAuth;
  client: MatrixAuthedHttpClient;
  query: string;
  queryLower: string;
} | null> {
  const query = normalizeOptionalString(params.query) ?? "";
  if (!query) {
    return null;
  }
  const auth = await resolveMatrixAuth({ cfg: params.cfg as never, accountId: params.accountId });
  return {
    auth,
    client: createMatrixDirectoryClient(auth),
    query,
    queryLower: normalizeLowercaseStringOrEmpty(query),
  };
}

function createGroupDirectoryEntry(params: {
  id: string;
  name: string;
  handle?: string;
}): ChannelDirectoryEntry {
  return {
    kind: "group",
    id: params.id,
    name: params.name,
    handle: params.handle,
  } satisfies ChannelDirectoryEntry;
}

async function requestMatrixJson<T>(
  client: MatrixAuthedHttpClient,
  params: {
    method: "GET" | "POST";
    endpoint: string;
    body?: unknown;
  },
): Promise<T> {
  return (await client.requestJson({
    method: params.method,
    endpoint: params.endpoint,
    body: params.body,
    timeoutMs: MATRIX_DIRECTORY_TIMEOUT_MS,
  })) as T;
}

export async function listMatrixDirectoryPeersLive(
  params: MatrixDirectoryLiveParams,
): Promise<ChannelDirectoryEntry[]> {
  const query = normalizeOptionalString(params.query) ?? "";
  if (!query) {
    return [];
  }
  const directUserId = normalizeMatrixMessagingTarget(query);
  if (directUserId && isMatrixQualifiedUserId(directUserId)) {
    return [{ kind: "user", id: directUserId }];
  }
  const context = await resolveMatrixDirectoryContext({
    ...params,
    query,
  });
  if (!context) {
    return [];
  }

  const res = await requestMatrixJson<MatrixUserDirectoryResponse>(context.client, {
    method: "POST",
    endpoint: "/_matrix/client/v3/user_directory/search",
    body: {
      search_term: context.query,
      limit: resolveMatrixDirectoryLimit(params.limit),
    },
  });
  const results = res.results ?? [];
  return results
    .map((entry) => {
      const userId = normalizeOptionalString(entry.user_id);
      if (!userId) {
        return null;
      }
      const displayName = normalizeOptionalString(entry.display_name);
      return {
        kind: "user",
        id: userId,
        name: displayName,
        handle: displayName ? `@${displayName}` : undefined,
        raw: entry,
      } satisfies ChannelDirectoryEntry;
    })
    .filter(Boolean) as ChannelDirectoryEntry[];
}

async function resolveMatrixRoomAlias(
  client: MatrixAuthedHttpClient,
  alias: string,
): Promise<string | null> {
  try {
    const res = await requestMatrixJson<MatrixAliasLookup>(client, {
      method: "GET",
      endpoint: `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
    });
    return normalizeOptionalString(res.room_id) ?? null;
  } catch {
    return null;
  }
}

async function fetchMatrixRoomName(
  client: MatrixAuthedHttpClient,
  roomId: string,
): Promise<string | null> {
  try {
    const res = await requestMatrixJson<MatrixRoomNameState>(client, {
      method: "GET",
      endpoint: `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.name`,
    });
    return normalizeOptionalString(res.name) ?? null;
  } catch {
    return null;
  }
}

export async function listMatrixDirectoryGroupsLive(
  params: MatrixDirectoryLiveParams,
): Promise<ChannelDirectoryEntry[]> {
  const query = normalizeOptionalString(params.query) ?? "";
  if (!query) {
    return [];
  }
  const directTarget = normalizeMatrixMessagingTarget(query);

  if (directTarget?.startsWith("!")) {
    return [createGroupDirectoryEntry({ id: directTarget, name: directTarget })];
  }

  const context = await resolveMatrixDirectoryContext({
    ...params,
    query,
  });
  if (!context) {
    return [];
  }
  const { client, queryLower } = context;
  const limit = resolveMatrixDirectoryLimit(params.limit);

  if (directTarget?.startsWith("#")) {
    const roomId = await resolveMatrixRoomAlias(client, directTarget);
    if (!roomId) {
      return [];
    }
    return [createGroupDirectoryEntry({ id: roomId, name: directTarget, handle: directTarget })];
  }

  const joined = await requestMatrixJson<MatrixJoinedRoomsResponse>(client, {
    method: "GET",
    endpoint: "/_matrix/client/v3/joined_rooms",
  });
  const rooms = (joined.joined_rooms ?? [])
    .map((roomId) => normalizeOptionalString(roomId))
    .filter((roomId): roomId is string => Boolean(roomId));
  const results: ChannelDirectoryEntry[] = [];

  for (const roomId of rooms) {
    const name = await fetchMatrixRoomName(client, roomId);
    if (!name || !normalizeLowercaseStringOrEmpty(name).includes(queryLower)) {
      continue;
    }
    results.push({
      kind: "group",
      id: roomId,
      name,
      handle: `#${name}`,
    });
    if (results.length >= limit) {
      break;
    }
  }

  return results;
}
