import { buildControlUiResourcePath } from "../../../../src/gateway/control-ui-resource-routes.js";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { ACTIVITY_PERSON_PARAM } from "../../app-route-paths.ts";
import { readAvatarGatewayContext } from "../../lib/identity-avatar-context.ts";
import { projectPresencePayload, type PresenceViewer } from "../../lib/presence-users.ts";

export const ACTIVITY_TIME_FILTERS = ["24h", "7d", "30d", "all"] as const;
export type ActivityTimeFilter = (typeof ACTIVITY_TIME_FILTERS)[number];

export type SessionActivityFilters = {
  personId: string | null;
  query: string;
  time: ActivityTimeFilter;
};

type ActivityPerson = PresenceViewer & { count: number };

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

export function projectSessionActivity(
  result: SessionsListResult | undefined,
): SessionActivityProjection {
  const visible = result?.sessions ?? [];
  const people = (result?.people ?? []).map((person) => ({
    id: person.identity.id,
    name: person.label,
    avatarUrl: person.avatarUrl,
    watchedSessions: [],
    count: person.sessionCount,
  }));
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
    matchedCount: result?.totalCount ?? visible.length,
    people,
    sessions: visible,
    timeCount: result?.peopleSessionCount ?? visible.length,
  };
}

export function resolveActivityIdentity(
  userId: string,
  presencePayload: unknown,
  people: SessionsListResult["people"],
): PresenceViewer | null {
  const online = projectPresencePayload(presencePayload).users.find((user) => user.id === userId);
  if (online) {
    return online;
  }
  const person = people?.find((candidate) => candidate.identity.id === userId);
  return person
    ? {
        id: person.identity.id,
        name: person.label,
        avatarUrl: person.avatarUrl,
        watchedSessions: [],
      }
    : null;
}

export function resolveViewingNow(
  identity: PresenceViewer,
  rows: readonly GatewaySessionRow[],
): readonly GatewaySessionRow[] {
  const watched = new Set(identity.watchedSessions);
  return rows.filter((row) => watched.has(row.key)).toSorted(compareSessionActivity);
}
