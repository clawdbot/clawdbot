import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { resolveMatrixDirectUserId, resolveMatrixTargetIdentity } from "./target-ids.js";

export function trimMaybeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveMatrixRoomTargetId(value: unknown): string | undefined {
  const trimmed = trimMaybeString(value);
  if (!trimmed) {
    return undefined;
  }
  const target = resolveMatrixTargetIdentity(trimmed);
  return target?.kind === "room" && target.id.startsWith("!") ? target.id : undefined;
}

export function resolveMatrixSessionAccountId(value: unknown): string | undefined {
  const trimmed = trimMaybeString(value);
  return trimmed ? normalizeAccountId(trimmed) : undefined;
}

export function resolveMatrixStoredRoomId(params: {
  deliveryTo?: unknown;
  lastTo?: unknown;
  originNativeChannelId?: unknown;
  originTo?: unknown;
}): string | undefined {
  return (
    resolveMatrixRoomTargetId(params.deliveryTo) ??
    resolveMatrixRoomTargetId(params.lastTo) ??
    resolveMatrixRoomTargetId(params.originNativeChannelId) ??
    resolveMatrixRoomTargetId(params.originTo)
  );
}

type MatrixStoredSessionEntryLike = {
  deliveryContext?: {
    channel?: unknown;
    to?: unknown;
    accountId?: unknown;
  };
  origin?: {
    provider?: unknown;
    from?: unknown;
    to?: unknown;
    nativeChannelId?: unknown;
    nativeDirectUserId?: unknown;
    accountId?: unknown;
    chatType?: unknown;
  };
  lastChannel?: unknown;
  lastTo?: unknown;
  lastAccountId?: unknown;
  chatType?: unknown;
};

export function resolveMatrixStoredSessionMeta(entry?: MatrixStoredSessionEntryLike): {
  channel?: string;
  accountId?: string;
  roomId?: string;
  directUserId?: string;
} | null {
  if (!entry) {
    return null;
  }
  const channel =
    trimMaybeString(entry.deliveryContext?.channel) ??
    trimMaybeString(entry.lastChannel) ??
    trimMaybeString(entry.origin?.provider);
  const accountId =
    resolveMatrixSessionAccountId(
      entry.deliveryContext?.accountId ?? entry.lastAccountId ?? entry.origin?.accountId,
    ) ?? undefined;
  const roomId = resolveMatrixStoredRoomId({
    deliveryTo: entry.deliveryContext?.to,
    lastTo: entry.lastTo,
    originNativeChannelId: entry.origin?.nativeChannelId,
    originTo: entry.origin?.to,
  });
  const chatType =
    trimMaybeString(entry.origin?.chatType) ?? trimMaybeString(entry.chatType) ?? undefined;
  const directUserId =
    chatType === "direct"
      ? (trimMaybeString(entry.origin?.nativeDirectUserId) ??
        resolveMatrixDirectUserId({
          from: trimMaybeString(entry.origin?.from),
          to:
            (roomId ? `room:${roomId}` : undefined) ??
            trimMaybeString(entry.deliveryContext?.to) ??
            trimMaybeString(entry.lastTo) ??
            trimMaybeString(entry.origin?.to),
          chatType,
        }))
      : undefined;
  if (!channel && !accountId && !roomId && !directUserId) {
    return null;
  }
  return {
    ...(channel ? { channel } : {}),
    ...(accountId ? { accountId } : {}),
    ...(roomId ? { roomId } : {}),
    ...(directUserId ? { directUserId } : {}),
  };
}
