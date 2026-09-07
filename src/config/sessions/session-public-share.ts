import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { InternalSessionEntry } from "./types.js";

export type SessionPublicShareGrant = {
  id: string;
  sessionId: string;
  createdAt: number;
};

/** Publication is valid only for its exact current generation, including copied metadata. */
export function resolveSessionPublicShare(
  entry: InternalSessionEntry | undefined,
): SessionPublicShareGrant | undefined {
  const share = entry?.publicShare;
  if (
    !entry ||
    entry.incognito === true ||
    !isRecord(share) ||
    share.sessionId !== entry.sessionId ||
    typeof share.id !== "string" ||
    !/^[a-f0-9]{48}$/.test(share.id) ||
    !Number.isSafeInteger(share.createdAt) ||
    share.createdAt < 0
  ) {
    return undefined;
  }
  return { id: share.id, sessionId: share.sessionId, createdAt: share.createdAt };
}
