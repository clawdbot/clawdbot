import type { RouteLocation } from "@openclaw/uirouter";
import { notFound } from "@openclaw/uirouter";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { INTERNAL_SESSION_PATH_PARAM } from "../../app-route-paths.ts";
import { pathForSession } from "../../app-session-path-builder.ts";
import { sessionRefFromPath, type SessionPathTarget } from "../../app-session-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { waitForGatewayClient } from "../../app/gateway-readiness.ts";
import type { BoardFace } from "../../lib/board/settings.ts";
import {
  buildCatalogSessionKey,
  catalogSessionKeyFromSearch,
} from "../../lib/sessions/catalog-key.ts";
import {
  buildAgentMainSessionKey,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
  resolveUiConfiguredMainKey,
} from "../../lib/sessions/session-key.ts";

const SESSION_REF_SEARCH_LIMIT = 20;
const SESSION_REF_SEARCH_MAX_PAGES = 5;
const SESSION_UUID_SUFFIX_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu;

type SessionCandidate = {
  agentId: string;
  displayName: string;
  href: string;
  idPrefix: string;
};

export type ChatRouteData =
  | {
      kind: "session";
      sessionKey: string;
      agentId?: string;
      draft?: string;
      face: BoardFace;
      shortId?: string;
      canonicalLocation?: RouteLocation;
      canonicalLocationReady?: Promise<RouteLocation | null>;
    }
  | {
      kind: "ambiguous";
      shortId: string;
      candidates: SessionCandidate[];
      truncated: boolean;
      face: BoardFace;
    };

export type SessionChatRouteData = Omit<
  Extract<ChatRouteData, { kind: "session" }>,
  "face" | "kind"
> & {
  face?: BoardFace;
  kind?: "session";
};

export function locationWithoutDraft(location: RouteLocation): RouteLocation {
  const params = new URLSearchParams(location.search);
  params.delete("draft");
  const search = params.toString();
  return { ...location, search: search ? `?${search}` : "" };
}

type SessionPrefixResolution =
  | { kind: "not-found" }
  | { kind: "unique"; session: GatewaySessionRow }
  | { kind: "ambiguous"; sessions: GatewaySessionRow[]; truncated: boolean };

const resolutionCache = new WeakMap<
  GatewayBrowserClient,
  Map<string, Promise<SessionPrefixResolution | null>>
>();

function sessionKeyUuid(sessionKey: string): string | null {
  const uuid = parseAgentSessionKey(sessionKey)?.rest.match(SESSION_UUID_SUFFIX_RE)?.[1];
  return uuid ? uuid.toLowerCase().replaceAll("-", "") : null;
}

function uniqueShortIdPrefix(
  value: string,
  candidates: readonly string[],
  truncated: boolean,
): string | null {
  const uuid = value.toLowerCase().replaceAll("-", "");
  if (!/^[0-9a-f]{8,32}$/u.test(uuid)) {
    return null;
  }
  if (truncated) {
    return uuid;
  }
  const normalizedCandidates = candidates.map((candidate) =>
    candidate.toLowerCase().replaceAll("-", ""),
  );
  for (let length = 8; length <= uuid.length; length += 1) {
    const prefix = uuid.slice(0, length);
    if (normalizedCandidates.filter((candidate) => candidate.startsWith(prefix)).length === 1) {
      return prefix;
    }
  }
  return uuid;
}

function sessionPrefixMatches(result: SessionsListResult, shortId: string): GatewaySessionRow[] {
  const prefix = shortId.toLowerCase().replaceAll("-", "");
  return result.sessions.filter((row) => {
    const keyUuid = sessionKeyUuid(row.key);
    return keyUuid?.startsWith(prefix) === true;
  });
}

async function querySessionPrefix(
  context: ApplicationContext,
  shortId: string,
  signal: AbortSignal,
): Promise<SessionPrefixResolution> {
  const client = await waitForGatewayClient(context.gateway, signal);
  let cache = resolutionCache.get(client);
  if (!cache) {
    cache = new Map();
    resolutionCache.set(client, cache);
  }
  let pending = cache.get(shortId);
  if (!pending) {
    pending = querySessionPrefixPages(context, shortId);
    cache.set(shortId, pending);
  }
  try {
    const resolved = await pending;
    if (!resolved) {
      throw new Error("Session list unavailable while resolving URL.");
    }
    return resolved;
  } finally {
    if (cache.get(shortId) === pending) {
      cache.delete(shortId);
    }
  }
}

async function querySessionPrefixPages(
  context: ApplicationContext,
  shortId: string,
): Promise<SessionPrefixResolution | null> {
  const matches = new Map<string, GatewaySessionRow>();
  let offset = 0;
  for (let page = 0; ; page += 1) {
    const result = await context.sessions.list({
      archivedFilter: "all",
      includeDerivedTitles: true,
      limit: SESSION_REF_SEARCH_LIMIT,
      search: shortId,
      ...(offset > 0 ? { offset } : {}),
    });
    if (!result) {
      return null;
    }
    for (const session of sessionPrefixMatches(result, shortId)) {
      matches.set(session.key, session);
    }
    const sessions = [...matches.values()];
    if (sessions.length > 1) {
      return { kind: "ambiguous", sessions, truncated: result.hasMore === true };
    }
    if (result.hasMore !== true) {
      const session = sessions[0];
      return session ? { kind: "unique", session } : { kind: "not-found" };
    }
    if (page === SESSION_REF_SEARCH_MAX_PAGES - 1) {
      return { kind: "ambiguous", sessions, truncated: true };
    }
    const nextOffset = result.nextOffset ?? offset + result.sessions.length;
    if (nextOffset <= offset) {
      return { kind: "ambiguous", sessions, truncated: true };
    }
    offset = nextOffset;
  }
}

function draftFromLocation(location: RouteLocation): string | undefined {
  return new URLSearchParams(location.search).get("draft") || undefined;
}

function configuredMainKey(context: ApplicationContext): string {
  return resolveUiConfiguredMainKey({
    agentsList: context.agents.state.agentsList,
    hello: context.gateway.snapshot.hello,
  });
}

function hasConfiguredMainKey(context: ApplicationContext): boolean {
  return Boolean(
    context.agents.state.agentsList?.mainKey?.trim() ||
    (context.gateway.snapshot.phase === "connected" && context.gateway.snapshot.hello),
  );
}

function canonicalMainLocation(
  context: ApplicationContext,
  location: RouteLocation,
  face: BoardFace,
  sessionKey: string,
): RouteLocation | null {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed) {
    return null;
  }
  const mainKey = configuredMainKey(context).toLowerCase();
  const rest = parsed.rest.toLowerCase();
  if (rest !== mainKey) {
    return null;
  }
  const pathname = pathForSession(face, parsed.agentId, sessionKey, context.basePath, { mainKey });
  return pathname && pathname !== location.pathname ? { ...location, pathname } : null;
}

function targetFromLocation(context: ApplicationContext, location: RouteLocation) {
  const mainKey = configuredMainKey(context);
  const direct = sessionRefFromPath(location.pathname, context.basePath, mainKey);
  if (direct) {
    return { target: direct, normalized: false };
  }
  const internalPath = new URLSearchParams(location.search).get(INTERNAL_SESSION_PATH_PARAM);
  const target = internalPath ? sessionRefFromPath(internalPath, context.basePath, mainKey) : null;
  return target ? { target, normalized: true } : null;
}

function mainSessionKey(
  context: ApplicationContext,
  target: Extract<SessionPathTarget, { kind: "main" }>,
): string {
  return buildAgentMainSessionKey({
    agentId: target.agentId,
    mainKey: configuredMainKey(context),
  });
}

function candidatesForResolution(
  context: ApplicationContext,
  face: BoardFace,
  resolution: Extract<SessionPrefixResolution, { kind: "ambiguous" }>,
  draft: string | undefined,
): SessionCandidate[] {
  const resolvedRows = resolution.sessions.flatMap((row) => {
    const uuid = sessionKeyUuid(row.key);
    return uuid ? [{ row, uuid }] : [];
  });
  const uuids = resolvedRows.map(({ uuid }) => uuid);
  return resolvedRows.flatMap(({ row, uuid }) => {
    const prefix = uniqueShortIdPrefix(uuid, uuids, resolution.truncated);
    if (!prefix) {
      return [];
    }
    const agentId = resolveAgentIdFromSessionKey(row.key);
    const href = pathForSession(face, agentId, row.key, context.basePath, {
      displayName: row.displayName,
      mainKey: configuredMainKey(context),
      shortIdLength: prefix.length,
    });
    return href
      ? [
          {
            agentId,
            displayName: row.displayName?.trim() || row.key,
            href: `${href}${draft ? `?${new URLSearchParams({ draft }).toString()}` : ""}`,
            idPrefix: prefix,
          },
        ]
      : [];
  });
}

export async function loadChatRoute(
  context: ApplicationContext,
  location: RouteLocation,
  face: BoardFace,
  signal: AbortSignal,
): Promise<ChatRouteData | ReturnType<typeof notFound>> {
  const resolvedTarget = targetFromLocation(context, location);
  if (!resolvedTarget || resolvedTarget.target.namespace !== face) {
    return notFound({ routeId: face });
  }
  const { target } = resolvedTarget;
  const catalogKey = catalogSessionKeyFromSearch(location.search);
  if (target.kind === "main" && catalogKey) {
    return {
      kind: "session",
      sessionKey: buildCatalogSessionKey(catalogKey),
      agentId: target.agentId,
      draft: draftFromLocation(location),
      face,
    };
  }
  if (target.kind === "main") {
    await waitForGatewayClient(context.gateway, signal);
    return {
      kind: "session",
      sessionKey: mainSessionKey(context, target),
      draft: draftFromLocation(location),
      face,
    };
  }
  if (target.kind === "literal") {
    const defaultsKnown = hasConfiguredMainKey(context);
    const canonicalLocation = defaultsKnown
      ? canonicalMainLocation(context, location, face, target.sessionKey)
      : null;
    const parsed = parseAgentSessionKey(target.sessionKey);
    const canonicalLocationReady =
      !defaultsKnown && parsed
        ? waitForGatewayClient(context.gateway, signal)
            .then(() => canonicalMainLocation(context, location, face, target.sessionKey))
            .catch(() => null)
        : undefined;
    return {
      kind: "session",
      sessionKey: target.sessionKey,
      draft: draftFromLocation(location),
      face,
      ...(canonicalLocation ? { canonicalLocation } : {}),
      ...(canonicalLocationReady ? { canonicalLocationReady } : {}),
    };
  }
  const resolution = await querySessionPrefix(context, target.shortId, signal);
  if (resolution.kind === "not-found") {
    return notFound({ routeId: face });
  }
  if (resolution.kind === "ambiguous") {
    return {
      kind: "ambiguous",
      shortId: target.shortId,
      candidates: candidatesForResolution(context, face, resolution, draftFromLocation(location)),
      truncated: resolution.truncated,
      face,
    };
  }
  const row = resolution.session;
  const agentId = resolveAgentIdFromSessionKey(row.key);
  const canonicalPath = pathForSession(face, agentId, row.key, context.basePath, {
    displayName: row.displayName,
    mainKey: configuredMainKey(context),
    shortIdLength: target.shortId.length,
  });
  if (!canonicalPath) {
    return notFound({ routeId: face });
  }
  return {
    kind: "session",
    sessionKey: row.key,
    draft: draftFromLocation(location),
    face,
    ...(target.shortId.length > 8 ? { shortId: target.shortId } : {}),
    ...(!resolvedTarget.normalized && location.pathname !== canonicalPath
      ? { canonicalLocation: { ...location, pathname: canonicalPath } }
      : {}),
  };
}
