import type { MatrixClient } from "matrix-bot-sdk";

import { EventType, type MatrixDirectAccountData } from "./types.js";

function normalizeTarget(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Matrix target is required (room:<id> or #alias)");
  }
  return trimmed;
}

export function normalizeThreadId(raw?: string | number | null): string | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = String(raw).trim();
  return trimmed ? trimmed : null;
}

const directRoomCache = new Map<string, string>();

async function persistDirectRoom(
  client: MatrixClient,
  userId: string,
  roomId: string,
): Promise<void> {
  let directContent: MatrixDirectAccountData | null = null;
  try {
    directContent = (await client.getAccountData(
      EventType.Direct,
    )) as MatrixDirectAccountData | null;
  } catch {
    // Ignore fetch errors and fall back to an empty map.
  }
  const existing =
    directContent && !Array.isArray(directContent) ? directContent : {};
  const current = Array.isArray(existing[userId]) ? existing[userId] : [];
  if (current[0] === roomId) return;
  const next = [roomId, ...current.filter((id) => id !== roomId)];
  try {
    await client.setAccountData(EventType.Direct, {
      ...existing,
      [userId]: next,
    });
  } catch {
    // Ignore persistence errors.
  }
}

async function resolveDirectRoomId(
  client: MatrixClient,
  userId: string,
): Promise<string> {
  const trimmed = userId.trim();
  if (!trimmed.startsWith("@")) {
    throw new Error(
      `Matrix user IDs must be fully qualified (got "${trimmed}")`,
    );
  }

  const cached = directRoomCache.get(trimmed);
  if (cached) return cached;

  // 1) Fast path: use account data (m.direct) for *this* logged-in user (the bot).
  try {
    const directContent = (await client.getAccountData(
      EventType.Direct,
    )) as MatrixDirectAccountData | null;
    const list = Array.isArray(directContent?.[trimmed])
      ? directContent[trimmed]
      : [];
    if (list.length > 0) {
      directRoomCache.set(trimmed, list[0]);
      return list[0];
    }
  } catch {
    // Ignore and fall back.
  }

  // 2) Fallback: look for an existing joined room that looks like a 1:1 with the user.
  // Many clients only maintain m.direct for *their own* account data, so relying on it is brittle.
  let fallbackRoom: string | null = null;
  try {
    const rooms = await client.getJoinedRooms();
    for (const roomId of rooms) {
      let members: string[];
      try {
        members = await client.getJoinedRoomMembers(roomId);
      } catch {
        continue;
      }
      if (!members.includes(trimmed)) continue;
      // Prefer classic 1:1 rooms, but allow larger rooms if requested.
      if (members.length === 2) {
        directRoomCache.set(trimmed, roomId);
        await persistDirectRoom(client, trimmed, roomId);
        return roomId;
      }
      if (!fallbackRoom) {
        fallbackRoom = roomId;
      }
    }
  } catch {
    // Ignore and fall back.
  }

  if (fallbackRoom) {
    directRoomCache.set(trimmed, fallbackRoom);
    await persistDirectRoom(client, trimmed, fallbackRoom);
    return fallbackRoom;
  }

  throw new Error(`No direct room found for ${trimmed} (m.direct missing)`);
}

export async function resolveMatrixRoomId(
  client: MatrixClient,
  raw: string,
): Promise<string> {
  const target = normalizeTarget(raw);
  const lowered = target.toLowerCase();
  if (lowered.startsWith("matrix:")) {
    return await resolveMatrixRoomId(client, target.slice("matrix:".length));
  }
  if (lowered.startsWith("room:")) {
    return await resolveMatrixRoomId(client, target.slice("room:".length));
  }
  if (lowered.startsWith("channel:")) {
    return await resolveMatrixRoomId(client, target.slice("channel:".length));
  }
  if (lowered.startsWith("user:")) {
    return await resolveDirectRoomId(client, target.slice("user:".length));
  }
  if (target.startsWith("@")) {
    return await resolveDirectRoomId(client, target);
  }
  if (target.startsWith("#")) {
    const resolved = await client.resolveRoom(target);
    if (!resolved) {
      throw new Error(`Matrix alias ${target} could not be resolved`);
    }
    return resolved;
  }
  return target;
}
