import { buildControlUiResourcePath } from "../../../../src/gateway/control-ui-resource-routes.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { ACTIVITY_PERSON_PARAM } from "../../app-route-paths.ts";
import { readAvatarGatewayContext } from "../../lib/identity-avatar.ts";
import {
  presenceViewerLabel,
  projectPresencePayload,
  type PresenceViewer,
} from "../../lib/presence-users.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";

export const ACTIVITY_TIME_FILTERS = ["24h", "7d", "30d", "all"] as const;
export type ActivityTimeFilter = (typeof ACTIVITY_TIME_FILTERS)[number];

export type SessionActivityFilters = {
  personId: string | null;
  query: string;
  time: ActivityTimeFilter;
};

type ActivityPerson = PresenceViewer & { count: number; lastActiveAt: number };

type SessionActivityDay = {
  key: string;
  timestamp: number | null;
  sessions: readonly GatewaySessionRow[];
};

type SessionActivityProjection = {
  days: readonly SessionActivityDay[];
  matchedCount: number;
  people: readonly ActivityPerson[];
  sessions: readonly GatewaySessionRow[];
  timeCount: number;
};

const DEFAULT_ACTIVITY_TIME_FILTER: ActivityTimeFilter = "7d";
const ACTIVITY_RENDER_LIMIT = 100;

function isActivityTimeFilter(value: string | null): value is ActivityTimeFilter {
  return value === "24h" || value === "7d" || value === "30d" || value === "all";
}

function normalized(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function parseSessionActivityFilters(search: string): SessionActivityFilters {
  const params = new URLSearchParams(search);
  const rawTime = params.get("time");
  return {
    personId: normalized(params.get(ACTIVITY_PERSON_PARAM)) ?? null,
    query: params.get("q")?.trim() ?? "",
    time: isActivityTimeFilter(rawTime) ? rawTime : DEFAULT_ACTIVITY_TIME_FILTER,
  };
}

export function sessionActivitySearch(filters: SessionActivityFilters): string {
  const params = new URLSearchParams();
  if (filters.time !== DEFAULT_ACTIVITY_TIME_FILTER) {
    params.set("time", filters.time);
  }
  if (filters.personId) {
    params.set(ACTIVITY_PERSON_PARAM, filters.personId);
  }
  if (filters.query) {
    params.set("q", filters.query);
  }
  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}

export function sessionActivityTimestamp(row: GatewaySessionRow): number {
  return row.lastActivityAt ?? row.updatedAt ?? row.createdAt ?? 0;
}

function compareSessionActivity(a: GatewaySessionRow, b: GatewaySessionRow): number {
  const recency = sessionActivityTimestamp(b) - sessionActivityTimestamp(a);
  return recency || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

function sessionActors(row: GatewaySessionRow) {
  const actors = [row.owner?.actor, row.createdActor, ...(row.participants ?? [])];
  const byId = new Map<string, NonNullable<(typeof actors)[number]>>();
  for (const actor of actors) {
    const id = normalized(actor?.id);
    if (id && !byId.has(id)) {
      byId.set(id, actor!);
    }
  }
  return [...byId.entries()].map(([id, actor]) => Object.assign({}, actor, { id }));
}

export function sessionActivityOwner(row: GatewaySessionRow): PresenceViewer {
  const actor = row.owner?.actor ?? row.createdActor;
  const agentId = normalized(row.agentId);
  const { resourceBasePath } = readAvatarGatewayContext();
  return {
    id: normalized(actor?.id) ?? agentId ?? "system",
    name: normalized(actor?.label) ?? agentId,
    avatarUrl: actor
      ? normalized(actor.avatarUrl)
      : agentId
        ? buildControlUiResourcePath("agentAvatar", resourceBasePath, agentId)
        : undefined,
    watchedSessions: [],
  };
}

function sessionInvolvesPerson(row: GatewaySessionRow, personId: string): boolean {
  return sessionActors(row).some((actor) => actor.id === personId);
}

function timeWindowStart(filter: ActivityTimeFilter, now: number): number | null {
  const day = 24 * 60 * 60 * 1000;
  return filter === "24h"
    ? now - day
    : filter === "7d"
      ? now - 7 * day
      : filter === "30d"
        ? now - 30 * day
        : null;
}

function dayKey(timestamp: number): string {
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function dayStart(timestamp: number): number {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function projectPeople(rows: readonly GatewaySessionRow[]): ActivityPerson[] {
  const people = new Map<string, ActivityPerson>();
  for (const row of rows) {
    const lastActiveAt = sessionActivityTimestamp(row);
    for (const actor of sessionActors(row)) {
      const existing = people.get(actor.id);
      if (existing) {
        existing.count += 1;
        existing.lastActiveAt = Math.max(existing.lastActiveAt, lastActiveAt);
        continue;
      }
      people.set(actor.id, {
        id: actor.id,
        name: normalized(actor.label),
        avatarUrl: normalized(actor.avatarUrl),
        watchedSessions: [],
        count: 1,
        lastActiveAt,
      });
    }
  }
  return [...people.values()].toSorted((a, b) => {
    const activityOrder = b.lastActiveAt - a.lastActiveAt;
    if (activityOrder !== 0) {
      return activityOrder;
    }
    const labelA = presenceViewerLabel(a).toLowerCase();
    const labelB = presenceViewerLabel(b).toLowerCase();
    return labelA < labelB ? -1 : labelA > labelB ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export function projectSessionActivity(
  rows: readonly GatewaySessionRow[],
  filters: SessionActivityFilters,
  now = Date.now(),
): SessionActivityProjection {
  const start = timeWindowStart(filters.time, now);
  const inTimeWindow = rows
    .filter((row) => start === null || sessionActivityTimestamp(row) >= start)
    .toSorted(compareSessionActivity);
  const people = projectPeople(inTimeWindow);
  const query = filters.query.toLowerCase();
  const matched = inTimeWindow.filter(
    (row) =>
      (!filters.personId || sessionInvolvesPerson(row, filters.personId)) &&
      (!query || resolveSessionDisplayName(row.key, row).toLowerCase().includes(query)),
  );
  const visible = matched.slice(0, ACTIVITY_RENDER_LIMIT);
  const grouped = new Map<string, GatewaySessionRow[]>();
  for (const row of visible) {
    const timestamp = sessionActivityTimestamp(row);
    const key = timestamp > 0 ? dayKey(timestamp) : "unknown";
    const existing = grouped.get(key);
    if (existing) {
      existing.push(row);
    } else {
      grouped.set(key, [row]);
    }
  }
  const days = [...grouped.entries()].map(([key, sessions]) => ({
    key,
    timestamp: key === "unknown" ? null : dayStart(sessionActivityTimestamp(sessions[0]!)),
    sessions,
  }));
  return {
    days,
    matchedCount: matched.length,
    people,
    sessions: visible,
    timeCount: inTimeWindow.length,
  };
}

export function resolveActivityIdentity(
  userId: string,
  presencePayload: unknown,
  rows: readonly GatewaySessionRow[],
): PresenceViewer | null {
  const online = projectPresencePayload(presencePayload).users.find((user) => user.id === userId);
  if (online) {
    return online;
  }
  for (const row of rows.toSorted(compareSessionActivity)) {
    const actor = sessionActors(row).find((candidate) => candidate.id === userId);
    if (actor) {
      return {
        id: userId,
        name: normalized(actor.label),
        avatarUrl: normalized(actor.avatarUrl),
        watchedSessions: [],
      };
    }
  }
  return null;
}

export function resolveViewingNow(
  identity: PresenceViewer,
  rows: readonly GatewaySessionRow[],
): readonly GatewaySessionRow[] {
  const watched = new Set(identity.watchedSessions);
  return rows.filter((row) => watched.has(row.key)).toSorted(compareSessionActivity);
}
