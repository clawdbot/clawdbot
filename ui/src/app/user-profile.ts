import type { PresenceEntry } from "../api/types.ts";
import {
  gatewayHttpBaseUrl,
  gatewayUserAvatarUrl,
  userAvatarRoute,
} from "../lib/user-avatar-url.ts";

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

/** Prefers local profile edits for the current presence identity only. */
export function resolveCurrentSelfUser({
  snapshotUser,
  presenceEntries,
  presenceInstanceId,
}: {
  snapshotUser?: AuthenticatedUser | null;
  presenceEntries?: readonly PresenceEntry[];
  presenceInstanceId?: string;
}): AuthenticatedUser | null {
  const presenceUser = resolveSelfPresenceUser(presenceEntries ?? [], presenceInstanceId);
  // Gateway state folds newer presence into snapshotUser, so a matching profile is
  // either the latest presence projection or the local profile edit it should retain.
  return snapshotUser && (!presenceUser || snapshotUser.id === presenceUser.id)
    ? snapshotUser
    : presenceUser;
}

export function userProfileAvatarUrl(
  gatewayUrl: string,
  profileId: string,
  updatedAt: number,
  documentHref = globalThis.location?.href,
): string | null {
  if (!documentHref) {
    return null;
  }
  const gatewayBase = gatewayHttpBaseUrl(gatewayUrl, documentHref);
  if (!gatewayBase) {
    return null;
  }
  // The shared avatar loader authenticates cross-origin Gateway requests and
  // turns their response into a local blob accepted by the Control UI CSP.
  const url = gatewayUserAvatarUrl(gatewayBase, userAvatarRoute(profileId));
  if (!url) {
    return null;
  }
  url.search = `?v=${updatedAt}`;
  return url.href;
}
