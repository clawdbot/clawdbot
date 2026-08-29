import type { PresenceEntry } from "../api/types.ts";

export type AuthenticatedUser = NonNullable<PresenceEntry["user"]>;
export type PresencePayload = { presence: readonly PresenceEntry[] };

export function readPresenceEntries(value: unknown): PresenceEntry[] | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const presence = (value as { presence?: unknown }).presence;
  return Array.isArray(presence) ? (presence as PresenceEntry[]) : undefined;
}

export function resolveSelfPresenceUser(
  entries: readonly PresenceEntry[],
  instanceId: string | undefined,
): AuthenticatedUser | null {
  if (!instanceId) {
    return null;
  }
  const entry = entries.find(
    (candidate) => candidate.instanceId === instanceId && candidate.reason !== "disconnect",
  );
  return entry?.user?.id ? entry.user : null;
}

/** Gateway state owns live identity updates and local profile edits; hello may be stale. */
export function resolveCurrentSelfUser({
  snapshotUser,
  presenceEntries,
  presenceInstanceId,
}: {
  snapshotUser?: AuthenticatedUser | null;
  presenceEntries?: readonly PresenceEntry[];
  presenceInstanceId?: string;
}): AuthenticatedUser | null {
  return snapshotUser ?? resolveSelfPresenceUser(presenceEntries ?? [], presenceInstanceId);
}
