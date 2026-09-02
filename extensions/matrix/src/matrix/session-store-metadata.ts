// Matrix plugin module implements session store metadata behavior.
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import {
  deliveryContextFromSession,
  sessionDeliveryOrigin,
  type SessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveMatrixDirectUserId, resolveMatrixTargetIdentity } from "./target-ids.js";

function resolveMatrixRoomTargetId(value: unknown): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  const target = resolveMatrixTargetIdentity(trimmed);
  return target?.kind === "room" && target.id.startsWith("!") ? target.id : undefined;
}

function resolveMatrixSessionAccountId(value: unknown): string | undefined {
  const trimmed = normalizeOptionalString(value);
  return trimmed ? normalizeAccountId(trimmed) : undefined;
}

function resolveMatrixStoredRoomId(params: {
  deliveryTo?: unknown;
  originNativeChannelId?: unknown;
  originTo?: unknown;
}): string | undefined {
  return (
    resolveMatrixRoomTargetId(params.deliveryTo) ??
    resolveMatrixRoomTargetId(params.originNativeChannelId) ??
    resolveMatrixRoomTargetId(params.originTo)
  );
}

type MatrixStoredSessionEntryLike = Pick<SessionEntry, "chatType" | "delivery">;

export function resolveMatrixStoredSessionMeta(entry?: MatrixStoredSessionEntryLike): {
  channel?: string;
  accountId?: string;
  roomId?: string;
  directUserId?: string;
} | null {
  if (!entry) {
    return null;
  }
  const deliveryContext = deliveryContextFromSession(entry);
  const origin = sessionDeliveryOrigin(entry);
  const channel =
    normalizeOptionalString(deliveryContext?.channel) ?? normalizeOptionalString(origin?.provider);
  const accountId =
    resolveMatrixSessionAccountId(deliveryContext?.accountId ?? origin?.accountId) ?? undefined;
  const roomId = resolveMatrixStoredRoomId({
    deliveryTo: deliveryContext?.to,
    originNativeChannelId: origin?.nativeChannelId,
    originTo: origin?.to,
  });
  const chatType =
    normalizeOptionalString(origin?.chatType) ?? normalizeOptionalString(entry.chatType);
  const directUserId =
    chatType === "direct"
      ? (normalizeOptionalString(origin?.nativeDirectUserId) ??
        resolveMatrixDirectUserId({
          from: normalizeOptionalString(origin?.from),
          to:
            (roomId ? `room:${roomId}` : undefined) ??
            normalizeOptionalString(deliveryContext?.to) ??
            normalizeOptionalString(origin?.to),
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
