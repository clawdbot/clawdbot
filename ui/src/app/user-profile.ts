import { normalizeRouteBasePath } from "@openclaw/uirouter";
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
  revision: string | number,
  resourceBasePath = "",
  documentHref?: string,
): string | null {
  const pageHref = documentHref ?? globalThis.location?.href;
  if (!pageHref) {
    return null;
  }
  try {
    const url = new URL(gatewayUrl, pageHref);
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
    const documentOrigin =
      documentHref === undefined && globalThis.location?.origin
        ? globalThis.location.origin
        : new URL(pageHref).origin;
    const sameOriginResourceBase =
      url.origin === documentOrigin ? normalizeRouteBasePath(resourceBasePath) : "";
    url.pathname = `${sameOriginResourceBase}/api/users/${encodeURIComponent(profileId)}/avatar`;
    url.search = `?v=${revision}`;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}
