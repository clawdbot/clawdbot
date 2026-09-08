import type { RouteLocation } from "@openclaw/uirouter";
import { buildControlUiResourcePath } from "../../../../src/gateway/control-ui-resource-routes.js";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import {
  ACTIVITY_PERSON_PARAM,
  activityPersonFromPath,
  activityPersonLocation,
  pathForRoute,
} from "../../app-route-paths.ts";
import { readAvatarGatewayContext } from "../../lib/identity-avatar-context.ts";
import type { PresenceViewer } from "../../lib/presence-users.ts";

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

export function parseSessionActivityFilters(
  search: string,
  pathPersonId?: string | null,
): SessionActivityFilters {
  const params = new URLSearchParams(search);
  const rawTime = params.get("time");
  return {
    personId: pathPersonId ?? normalized(params.get(ACTIVITY_PERSON_PARAM)) ?? null,
    query: params.get("q")?.trim() ?? "",
    time: isActivityTimeFilter(rawTime) ? rawTime : DEFAULT_ACTIVITY_TIME_FILTER,
  };
}

export function sessionActivityLocation(
  filters: SessionActivityFilters,
  basePath = "",
  personLabel?: string,
): { pathname: string; search: string } {
  const params = new URLSearchParams();
  if (filters.time !== DEFAULT_ACTIVITY_TIME_FILTER) {
    params.set("time", filters.time);
  }
  if (filters.query) {
    params.set("q", filters.query);
  }
  const serialized = params.toString();
  const search = serialized ? `?${serialized}` : "";
  const pathname = filters.personId
    ? activityPersonLocation(filters.personId, basePath, personLabel).pathname
    : pathForRoute("activity", basePath);
  return { pathname, search };
}

export function canonicalSessionActivityLocation(
  location: RouteLocation,
  personId: string,
  label: string | undefined,
  basePath: string,
): RouteLocation | null {
  const params = new URLSearchParams(location.search);
  const pathReference = activityPersonFromPath(location.pathname, basePath);
  const compactReference = (pathReference ?? params.get(ACTIVITY_PERSON_PARAM))?.replaceAll(
    "-",
    "",
  );
  const prefixLength =
    compactReference &&
    /^[0-9a-f]{8,32}$/.test(compactReference) &&
    personId.replaceAll("-", "").startsWith(compactReference)
      ? compactReference.length
      : 32;
  // Empty filtered pages carry no profile metadata; retain the readable incoming link.
  const pathname =
    pathReference && !label
      ? location.pathname
      : activityPersonLocation(personId, basePath, label, prefixLength).pathname;
  params.delete(ACTIVITY_PERSON_PARAM);
  const query = params.toString();
  const search = query ? `?${query}` : "";
  return pathname === location.pathname && search === location.search
    ? null
    : { pathname, search, hash: location.hash };
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

export function resolveViewingNow(
  identity: PresenceViewer,
  rows: readonly GatewaySessionRow[],
): readonly GatewaySessionRow[] {
  const watched = new Set(identity.watchedSessions);
  return rows.filter((row) => watched.has(row.key)).toSorted(compareSessionActivity);
}
