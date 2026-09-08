import type { SessionParticipantIdentity } from "../../../packages/gateway-protocol/src/schema/session-participant.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import { presenceUserKey } from "../../../src/shared/presence-user.ts";
import type { PresenceEntry } from "../api/types.ts";
import {
  readPresenceEntries,
  resolveSelfPresenceUser,
  type AuthenticatedUser,
} from "../app/user-profile.ts";
import { t } from "../i18n/index.ts";

export type PresenceViewer = NonNullable<PresenceEntry["user"]> & {
  watchedSessions: readonly string[];
  entries?: readonly PresenceEntry[];
};

// Matches the native Mac's recent-input window for interactive presence.
const PRESENCE_ACTIVE_INPUT_THRESHOLD_SECONDS = 120;

function normalized(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function firstSorted(values: Iterable<string | null | undefined>): string | undefined {
  return [...values]
    .map(normalized)
    .filter((value): value is string => value !== undefined)
    .toSorted()[0];
}

function presenceEntrySortKey(entry: PresenceEntry): string {
  return [
    normalized(entry.host) ?? "",
    normalized(entry.platform) ?? "",
    normalized(entry.deviceFamily) ?? "",
    normalized(entry.instanceId) ?? "",
    String(entry.ts ?? 0).padStart(16, "0"),
  ].join("\u0000");
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function groupPresenceUsers(entries: readonly PresenceEntry[]): {
  users: readonly PresenceViewer[];
} {
  const grouped = new Map<string, PresenceEntry[]>();
  for (const entry of entries) {
    if (entry.reason === "disconnect" || !entry.user?.id) {
      continue;
    }
    const key = presenceUserKey(entry.user);
    const existing = grouped.get(key);
    if (existing) {
      existing.push(entry);
    } else {
      grouped.set(key, [entry]);
    }
  }
  return {
    users: [...grouped.entries()]
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, userEntries]) => ({
        id: userEntries[0]!.user!.id,
        identity: userEntries[0]!.user!.identity,
        name: firstSorted(userEntries.map((entry) => entry.user?.name)),
        email: firstSorted(userEntries.map((entry) => entry.user?.email)),
        avatarUrl: firstSorted(userEntries.map((entry) => entry.user?.avatarUrl)),
        watchedSessions: [
          ...new Set(userEntries.flatMap((entry) => entry.watchedSessions ?? [])),
        ].toSorted(),
        entries: userEntries.toSorted((a, b) =>
          compareText(presenceEntrySortKey(a), presenceEntrySortKey(b)),
        ),
      })),
  };
}

let cachedPresencePayload: unknown;
let cachedPresenceProjection: ReturnType<typeof groupPresenceUsers> | undefined;

export function projectPresencePayload(value: unknown) {
  if (cachedPresenceProjection && cachedPresencePayload === value) {
    return cachedPresenceProjection;
  }
  cachedPresencePayload = value;
  cachedPresenceProjection = groupPresenceUsers(readPresenceEntries(value) ?? []);
  return cachedPresenceProjection;
}

export function presenceUserLabel(
  user: Pick<PresenceViewer, "id" | "name" | "email">,
  fallbackName = user.id,
) {
  const isSharedOwner = user.id === GATEWAY_OWNER_PROFILE_ID;
  return {
    name: isSharedOwner
      ? t("presence.sharedOwner.name")
      : (user.name ?? user.email ?? fallbackName),
    isSharedOwner,
  };
}

export function presenceViewerLabel(user: Pick<PresenceViewer, "id" | "name" | "email">): string {
  return presenceUserLabel(user).name;
}

export function isPresenceViewerIdle(user: PresenceViewer): boolean {
  const recencies = (user.entries ?? []).flatMap((entry) =>
    entry.lastInputSeconds === undefined ? [] : [entry.lastInputSeconds],
  );
  return (
    recencies.length > 0 &&
    recencies.every((seconds) => seconds > PRESENCE_ACTIVE_INPUT_THRESHOLD_SECONDS)
  );
}

function comparePresenceViewers(a: PresenceViewer, b: PresenceViewer): number {
  const activityOrder = Number(isPresenceViewerIdle(a)) - Number(isPresenceViewerIdle(b));
  if (activityOrder !== 0) {
    return activityOrder;
  }
  const labelA = presenceViewerLabel(a).toLowerCase();
  const labelB = presenceViewerLabel(b).toLowerCase();
  return compareText(labelA, labelB) || compareText(presenceUserKey(a), presenceUserKey(b));
}

export function presenceMatchesProfile(
  user: PresenceViewer,
  identity?: SessionParticipantIdentity,
): boolean {
  return identity?.type === "profile" && user.identity?.id === identity.id;
}

export function projectPresenceViewers(
  value: unknown,
  selfUser?: AuthenticatedUser | null,
  selfInstanceId?: string,
  sessionKey?: string,
  excludeIdentities: readonly SessionParticipantIdentity[] = [],
): readonly PresenceViewer[] {
  const self =
    selfUser ?? resolveSelfPresenceUser(readPresenceEntries(value) ?? [], selfInstanceId);
  const selfKey = self ? presenceUserKey(self) : undefined;
  return projectPresencePayload(value).users.filter(
    (user) =>
      presenceUserKey(user) !== selfKey &&
      !excludeIdentities.some((identity) => presenceMatchesProfile(user, identity)) &&
      (sessionKey === undefined || user.watchedSessions.includes(sessionKey)),
  );
}

export function projectOnlinePresenceViewers(
  value: unknown,
  authenticatedSelfUser?: AuthenticatedUser | null,
  selfInstanceId?: string,
): readonly PresenceViewer[] {
  return projectPresenceViewers(value, authenticatedSelfUser, selfInstanceId).toSorted(
    comparePresenceViewers,
  );
}

export function hasSessionPresenceViewers(
  value: unknown,
  selfUser: AuthenticatedUser | null | undefined,
  selfInstanceId: string | undefined,
  sessionKey: string,
): boolean {
  return projectPresenceViewers(value, selfUser, selfInstanceId, sessionKey).length > 0;
}

export function hasMultiplePresenceIdentities(value: unknown): boolean {
  return projectPresencePayload(value).users.length >= 2;
}
