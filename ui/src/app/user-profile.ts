import type { PresenceEntry } from "../api/types.ts";

export type AuthenticatedUser = NonNullable<PresenceEntry["user"]>;

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
  try {
    const url = new URL(gatewayUrl, documentHref);
    if (url.protocol === "ws:") {
      url.protocol = "http:";
    } else if (url.protocol === "wss:") {
      url.protocol = "https:";
    }
    // The authenticated avatar endpoint is HTTP-only and the Control UI CSP
    // permits images from its own origin. Cross-origin gateways keep initials.
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.origin !== new URL(documentHref).origin
    ) {
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
