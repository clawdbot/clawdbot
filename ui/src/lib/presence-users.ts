import type { PresenceEntry } from "../api/types.ts";
import { readPresenceEntries } from "../app/user-profile.ts";

export type PresenceViewer = {
  id: string;
  name?: string;
  email?: string;
  avatarUrl?: string;
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

function projectPresenceViewers(
  entries: readonly PresenceEntry[],
  authenticatedSelfUserId?: string,
  selfInstanceId?: string,
): { users: readonly PresenceViewer[]; selfUserId?: string } {
  const grouped = new Map<string, PresenceEntry[]>();
  let selfUserId = normalized(authenticatedSelfUserId);
  for (const entry of entries) {
    if (entry.reason === "disconnect" || !entry.user?.id) {
      continue;
    }
    const userId = entry.user.id;
    const existing = grouped.get(userId);
    if (existing) {
      existing.push(entry);
    } else {
      grouped.set(userId, [entry]);
    }
    if (!selfUserId && selfInstanceId && entry.instanceId === selfInstanceId) {
      selfUserId = userId;
    }
  }
  return {
    selfUserId,
    users: [...grouped.entries()]
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([id, userEntries]) => ({
        id,
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
let cachedAuthenticatedSelfUserId: string | undefined;
let cachedSelfInstanceId: string | undefined;
let cachedPresenceProjection: ReturnType<typeof projectPresenceViewers> | undefined;

export function projectPresencePayload(
  value: unknown,
  authenticatedSelfUserId?: string,
  selfInstanceId?: string,
) {
  if (
    cachedPresenceProjection &&
    cachedPresencePayload === value &&
    cachedAuthenticatedSelfUserId === authenticatedSelfUserId &&
    cachedSelfInstanceId === selfInstanceId
  ) {
    return cachedPresenceProjection;
  }
  cachedPresencePayload = value;
  cachedAuthenticatedSelfUserId = authenticatedSelfUserId;
  cachedSelfInstanceId = selfInstanceId;
  cachedPresenceProjection = projectPresenceViewers(
    readPresenceEntries(value) ?? [],
    authenticatedSelfUserId,
    selfInstanceId,
  );
  return cachedPresenceProjection;
}

export function presenceViewerLabel(user: PresenceViewer): string {
  return user.name ?? user.email ?? user.id;
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
  return labelA < labelB ? -1 : labelA > labelB ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function projectOnlinePresenceViewers(
  value: unknown,
  authenticatedSelfUserId?: string,
  selfInstanceId?: string,
): readonly PresenceViewer[] {
  const projection = projectPresencePayload(value, authenticatedSelfUserId, selfInstanceId);
  return projection.users
    .filter((user) => user.id !== projection.selfUserId)
    .toSorted(comparePresenceViewers);
}

export function hasSessionPresenceViewers(
  value: unknown,
  authenticatedSelfUserId: string | undefined,
  selfInstanceId: string | undefined,
  sessionKey: string,
  excludeUserId?: string,
): boolean {
  const projection = projectPresencePayload(value, authenticatedSelfUserId, selfInstanceId);
  const excludedUserId = normalized(excludeUserId);
  return projection.users.some(
    (user) =>
      user.id !== projection.selfUserId &&
      user.id !== excludedUserId &&
      user.watchedSessions.includes(sessionKey),
  );
}

export function hasMultiplePresenceIdentities(value: unknown): boolean {
  return projectPresencePayload(value).users.length >= 2;
}
