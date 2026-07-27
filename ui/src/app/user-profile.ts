import type { PresenceEntry } from "../api/types.ts";

export type AuthenticatedUser = NonNullable<PresenceEntry["user"]>;
export type PresencePayload = { presence: readonly PresenceEntry[] };
export type ActorIdentityUser = {
  id: string;
  name?: string;
  email?: string;
  avatarUrl?: string;
};

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

function normalizeActorIdentityUser(
  user: AuthenticatedUser | null | undefined,
): ActorIdentityUser | null {
  if (!user) {
    return null;
  }
  const id = user.id.trim();
  if (!id) {
    return null;
  }
  const optional = (value: string | null | undefined) => value?.trim() || undefined;
  return {
    id,
    ...(optional(user.name) ? { name: optional(user.name) } : {}),
    ...(optional(user.email) ? { email: optional(user.email) } : {}),
    ...(optional(user.avatarUrl) ? { avatarUrl: optional(user.avatarUrl) } : {}),
  };
}

/** Builds actor identities from the same self and presence sources as the sidebar footer. */
export function resolveActorIdentityUsers({
  snapshotUser,
  presenceEntries,
  presenceInstanceId,
}: {
  snapshotUser?: AuthenticatedUser | null;
  presenceEntries?: readonly PresenceEntry[];
  presenceInstanceId?: string;
}): ReadonlyMap<string, ActorIdentityUser> {
  const users = new Map<string, ActorIdentityUser>();
  const addUser = (user: AuthenticatedUser | null | undefined) => {
    const normalized = normalizeActorIdentityUser(user);
    if (!normalized) {
      return;
    }
    users.set(normalized.id, { ...users.get(normalized.id), ...normalized });
  };
  for (const entry of presenceEntries ?? []) {
    if (entry.reason !== "disconnect") {
      addUser(entry.user);
    }
  }
  addUser(resolveCurrentSelfUser({ snapshotUser, presenceEntries, presenceInstanceId }));
  return users;
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
  try {
    const url = new URL(gatewayUrl, documentHref);
    if (url.protocol === "ws:") {
      url.protocol = "http:";
    } else if (url.protocol === "wss:") {
      url.protocol = "https:";
    }
    // The shared avatar loader authenticates cross-origin Gateway requests and
    // turns their response into a local blob accepted by the Control UI CSP.
    if (!["http:", "https:"].includes(url.protocol)) {
      return null;
    }
    url.username = "";
    url.password = "";
    url.pathname = `/api/users/${encodeURIComponent(profileId)}/avatar`;
    url.search = `?v=${updatedAt}`;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}
