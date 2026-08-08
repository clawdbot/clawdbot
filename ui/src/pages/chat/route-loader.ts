import { controlUiSessionSlug } from "@openclaw/session-url-contract";
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
  findUiSessionRow,
  SESSION_COMPOSER_FOCUS_PARAM,
  SESSION_FACE_PREFERENCE_PARAM,
  SESSION_NAVIGATION_KEY_PARAM,
} from "../../lib/sessions/route-navigation.ts";
import {
  buildAgentMainSessionKey,
  areUiSessionKeysEquivalent,
  isUiGlobalScopeConfigured,
  isUiGlobalSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
  resolveUiConfiguredMainKey,
  resolveUiGlobalAliasAgentId,
} from "../../lib/sessions/session-key.ts";
import { draftRouteDataFromLocation, draftSearchFromLocation } from "./route-draft.ts";
import {
  findCachedShortSession,
  incompleteShortSessionResolution,
  narrowShortResolutionBySlugHint,
  requireShortSessionResolution,
  sessionKeyUuid,
  type ShortSessionResolution as SessionReferenceResolution,
} from "./route-loader-short-cache.ts";

const SESSION_REF_SEARCH_LIMIT = 20;
const SESSION_REF_SEARCH_MAX_PAGES = 5;
// A uuid's first block is the longest run that is contiguous in both the hyphenated
// stored key and the hyphen-stripped short id used in URLs.

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
      focusComposer?: boolean;
      face: BoardFace;
      shortId?: string;
      canonicalLocation?: RouteLocation;
      canonicalLocationReady?: Promise<RouteLocation | null>;
      canonicalLocationSource?: RouteLocation;
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
  params.delete(SESSION_COMPOSER_FOCUS_PARAM);
  const search = params.toString();
  return { ...location, search: search ? `?${search}` : "" };
}

type SessionReferenceSearch = { agentId: string } & (
  | { kind: "short"; value: string }
  | { kind: "exact"; value: string }
  | { kind: "slug"; value: string }
);

type PendingSessionReference = {
  controller: AbortController;
  promise: Promise<SessionReferenceResolution | null>;
  subscribers: Set<AbortSignal>;
};

const resolutionCache = new WeakMap<GatewayBrowserClient, Map<string, PendingSessionReference>>();

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

// The gateway matches `search` as a plain substring of the stored key, id, and title
// fields, so every needle here has to be a run that literally appears in one of them.
// sessionReferenceMatches still applies the exact rule per row, so a loose needle only
// widens the candidate set; too narrow a needle loses the session entirely.
function exactGlobalAliasAgentId(
  context: ApplicationContext,
  search: SessionReferenceSearch,
): string | null {
  if (search.kind !== "exact") {
    return null;
  }
  const host = {
    agentsList: context.agents.state.agentsList,
    hello: context.gateway.snapshot.hello,
  };
  const aliasAgentId = resolveUiGlobalAliasAgentId(host, search.value);
  const aliasRest = parseAgentSessionKey(search.value)?.rest.toLowerCase();
  return aliasRest === "global" || isUiGlobalScopeConfigured(host) ? aliasAgentId : null;
}

function sessionReferenceSearchText(
  context: ApplicationContext,
  search: SessionReferenceSearch,
): string {
  if (search.kind === "exact") {
    // Gateway search filters literal stored keys before client-side alias matching.
    // A scoped main alias therefore has to request the canonical global key.
    if (exactGlobalAliasAgentId(context, search) === normalizeAgentId(search.agentId)) {
      return "global";
    }
    return search.value;
  }
  if (search.kind === "slug") {
    // controlUiSessionSlug builds every token from a contiguous alphanumeric run of the
    // lowercased display name, so one token always matches while the joined slug would
    // miss any name whose separators were punctuation ("Fix: auth bug" -> "fix-auth-bug").
    // The longest token is the most selective of those.
    return search.value
      .split("-")
      .reduce((longest, token) => (token.length > longest.length ? token : longest), "");
  }
  // Short ids are compared hyphen-stripped, but the stored key holds a hyphenated uuid,
  // so only its first block survives as a contiguous substring. Anything longer (from a
  // disambiguation link or a canonicalized slug) would match nothing server-side.
  return search.value.slice(0, 8);
}

function sessionReferenceMatches(
  context: ApplicationContext,
  result: SessionsListResult,
  search: SessionReferenceSearch,
): GatewaySessionRow[] {
  if (search.kind === "exact") {
    const aliasAgentId = exactGlobalAliasAgentId(context, search);
    return result.sessions.filter(
      (row) =>
        areUiSessionKeysEquivalent(row.key, search.value) ||
        (isUiGlobalSessionKey(row.key) && aliasAgentId === normalizeAgentId(search.agentId)),
    );
  }
  if (search.kind === "slug") {
    return result.sessions.filter(
      (row) =>
        sessionKeyUuid(row.key) !== null && controlUiSessionSlug(row.displayName) === search.value,
    );
  }
  const prefix = search.value.toLowerCase().replaceAll("-", "");
  return result.sessions.filter((row) => sessionKeyUuid(row.key)?.startsWith(prefix) === true);
}

// Two sessions can share a short id's prefix, which would send an otherwise exact link to
// the disambiguation view. When the link also carries a display-name slug, that slug says
// which one was meant, so it settles the tie and keeps generated links durable at their
// normal length. It can only narrow: a hint that matches nothing (a stale or hand-edited
// name) leaves the original candidates for the chooser rather than dropping the session.
//
// A truncated set is not a tie, it is an unfinished search. Another page could hold the
// same prefix under the same slug, so settling here would be the guess the bounded search
// exists to avoid.
async function querySessionReference(
  context: ApplicationContext,
  search: SessionReferenceSearch,
  signal: AbortSignal,
): Promise<SessionReferenceResolution | null> {
  const client = await waitForGatewayClient(context.gateway, signal);
  signal.throwIfAborted();
  const cache = resolutionCache.get(client) ?? new Map<string, PendingSessionReference>();
  resolutionCache.set(client, cache);
  const cacheKey = `${normalizeAgentId(search.agentId)}:${search.kind}:${search.value}`;
  let pending = cache.get(cacheKey);
  if (!pending || pending.controller.signal.aborted) {
    const controller = new AbortController();
    pending = {
      controller,
      promise: Promise.resolve().then(() =>
        querySessionReferencePages(context, search, controller.signal),
      ),
      subscribers: new Set(),
    };
    cache.set(cacheKey, pending);
  }
  pending.subscribers.add(signal);
  const shared = pending;
  let rejectAbort: (reason: unknown) => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => {
    shared.subscribers.delete(signal);
    // The producer is shared: one cancelled navigation must not cancel another
    // active route's lookup, but the final subscriber must stop later pages.
    if (shared.subscribers.size === 0) {
      shared.controller.abort(signal.reason);
    }
    rejectAbort(signal.reason);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) {
    onAbort();
  }
  try {
    return await Promise.race([shared.promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
    shared.subscribers.delete(signal);
    if (shared.subscribers.size === 0 && cache.get(cacheKey) === shared) {
      cache.delete(cacheKey);
    }
  }
}

async function querySessionReferencePages(
  context: ApplicationContext,
  search: SessionReferenceSearch,
  signal: AbortSignal,
): Promise<SessionReferenceResolution | null> {
  const matches = new Map<string, GatewaySessionRow>();
  let offset = 0;
  for (let page = 0; ; page += 1) {
    signal.throwIfAborted();
    const result = await context.sessions.list({
      agentId: search.agentId,
      archivedFilter: "all",
      includeDerivedTitles: true,
      limit: SESSION_REF_SEARCH_LIMIT,
      search: sessionReferenceSearchText(context, search),
      ...(offset > 0 ? { offset } : {}),
    });
    signal.throwIfAborted();
    if (!result) {
      return null;
    }
    for (const session of sessionReferenceMatches(context, result, search)) {
      matches.set(session.key, session);
    }
    const sessions = [...matches.values()];
    if (search.kind === "exact" && sessions[0]) {
      return { kind: "unique", session: sessions[0] };
    }
    if (sessions.length > 1) {
      return { kind: "ambiguous", sessions, truncated: result.hasMore === true };
    }
    if (result.hasMore !== true) {
      const session = sessions[0];
      return session ? { kind: "unique", session } : { kind: "not-found" };
    }
    if (page === SESSION_REF_SEARCH_MAX_PAGES - 1) {
      return incompleteShortSessionResolution(search.kind, sessions);
    }
    const nextOffset = result.nextOffset ?? offset + result.sessions.length;
    if (nextOffset <= offset) {
      return incompleteShortSessionResolution(search.kind, sessions);
    }
    offset = nextOffset;
  }
}

function isPreferenceDerivedFace(location: RouteLocation): boolean {
  return new URLSearchParams(location.search).get(SESSION_FACE_PREFERENCE_PARAM) === "1";
}

function locationWithoutSearchParam(location: RouteLocation, key: string): RouteLocation {
  const params = new URLSearchParams(location.search);
  params.delete(key);
  const search = params.toString();
  return { ...location, search: search ? `?${search}` : "" };
}

function locationWithoutNavigationHints(location: RouteLocation): RouteLocation {
  return locationWithoutSearchParam(
    locationWithoutSearchParam(location, SESSION_FACE_PREFERENCE_PARAM),
    SESSION_NAVIGATION_KEY_PARAM,
  );
}

function preferredFace(row: Pick<GatewaySessionRow, "boardFace">): BoardFace {
  return row.boardFace === "dashboard" ? "dashboard" : "chat";
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
  return pathname && pathname !== location.pathname
    ? { ...locationWithoutNavigationHints(location), pathname }
    : null;
}

function canonicalSessionLocation(params: {
  context: ApplicationContext;
  location: RouteLocation;
  face: BoardFace;
  row: GatewaySessionRow;
  shortIdLength?: number;
}): RouteLocation | null | undefined {
  const face = params.face;
  const agentId = resolveAgentIdFromSessionKey(params.row.key);
  const pathname = pathForSession(face, agentId, params.row.key, params.context.basePath, {
    displayName: params.row.displayName,
    mainKey: configuredMainKey(params.context),
    shortIdLength: params.shortIdLength,
  });
  if (!pathname) {
    return undefined;
  }
  const location = locationWithoutNavigationHints(params.location);
  const changed =
    pathname !== params.location.pathname || location.search !== params.location.search;
  return changed ? { ...location, pathname } : null;
}

function targetFromLocation(context: ApplicationContext, location: RouteLocation) {
  const mainKey = configuredMainKey(context);
  const direct = sessionRefFromPath(location.pathname, context.basePath, mainKey);
  if (direct) {
    return { target: direct, location };
  }
  const internalPath = new URLSearchParams(location.search).get(INTERNAL_SESSION_PATH_PARAM);
  if (!internalPath) {
    return null;
  }
  const target = sessionRefFromPath(internalPath, context.basePath, mainKey);
  return target
    ? {
        target,
        location: {
          ...locationWithoutSearchParam(location, INTERNAL_SESSION_PATH_PARAM),
          pathname: internalPath,
        },
      }
    : null;
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
  resolution: Extract<SessionReferenceResolution, { kind: "ambiguous" }>,
  location: RouteLocation,
  preferenceDerived: boolean,
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
    const candidateFace = preferenceDerived ? preferredFace(row) : face;
    const href = pathForSession(candidateFace, agentId, row.key, context.basePath, {
      displayName: row.displayName,
      mainKey: configuredMainKey(context),
      shortIdLength: prefix.length,
    });
    return href
      ? [
          {
            agentId,
            displayName: row.displayName?.trim() || row.key,
            href: `${href}${draftSearchFromLocation(location)}`,
            idPrefix: prefix,
          },
        ]
      : [];
  });
}

function resolvedSessionRouteData(params: {
  context: ApplicationContext;
  location: RouteLocation;
  face: BoardFace;
  row: GatewaySessionRow;
  preferenceDerived: boolean;
  shortId?: string;
}): Extract<ChatRouteData, { kind: "session" }> | null {
  // The loader owns face resolution: a preference-derived open adopts the row's stored
  // face, so the page renders that board directly and replaces the URL with the matching
  // namespace instead of re-deriving a face from the path it was handed.
  const face = params.preferenceDerived ? preferredFace(params.row) : params.face;
  const canonicalLocation = canonicalSessionLocation({
    context: params.context,
    location: params.location,
    face,
    row: params.row,
    ...(params.shortId ? { shortIdLength: params.shortId.length } : {}),
  });
  if (canonicalLocation === undefined) {
    return null;
  }
  return {
    kind: "session",
    sessionKey: params.row.key,
    ...draftRouteDataFromLocation(params.location),
    face,
    ...(params.shortId && params.shortId.length > 8 ? { shortId: params.shortId } : {}),
    ...(canonicalLocation ? { canonicalLocation, canonicalLocationSource: params.location } : {}),
  };
}

function resolvedMainSessionRouteData(params: {
  context: ApplicationContext;
  location: RouteLocation;
  face: BoardFace;
  row: GatewaySessionRow;
  target: Extract<SessionPathTarget, { kind: "main" }>;
  preferenceDerived: boolean;
}): Extract<ChatRouteData, { kind: "session" }> | null {
  if (!isUiGlobalSessionKey(params.row.key)) {
    return resolvedSessionRouteData(params);
  }
  const face = params.preferenceDerived ? preferredFace(params.row) : params.face;
  const pathname = pathForSession(
    face,
    params.target.agentId,
    mainSessionKey(params.context, params.target),
    params.context.basePath,
    { mainKey: configuredMainKey(params.context) },
  );
  if (!pathname) {
    return null;
  }
  const location = locationWithoutNavigationHints(params.location);
  const canonicalLocation =
    pathname !== params.location.pathname || location.search !== params.location.search
      ? { ...location, pathname }
      : undefined;
  return {
    kind: "session",
    sessionKey: params.row.key,
    agentId: params.target.agentId,
    ...draftRouteDataFromLocation(params.location),
    face,
    ...(canonicalLocation ? { canonicalLocation, canonicalLocationSource: params.location } : {}),
  };
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
  const routeLocation = resolvedTarget.location;
  const preferenceDerived = isPreferenceDerivedFace(routeLocation);
  const catalogKey = catalogSessionKeyFromSearch(routeLocation.search);
  if (target.kind === "main" && catalogKey) {
    const sessionKey = buildCatalogSessionKey(catalogKey);
    let canonicalLocation = preferenceDerived
      ? locationWithoutNavigationHints(routeLocation)
      : null;
    let resolvedFace = face;
    if (preferenceDerived) {
      const resolution = await querySessionReference(
        context,
        { kind: "exact", value: sessionKey, agentId: target.agentId },
        signal,
      );
      if (resolution?.kind === "unique") {
        resolvedFace = preferredFace(resolution.session);
        const pathname = pathForSession(
          resolvedFace,
          target.agentId,
          mainSessionKey(context, target),
          context.basePath,
          { mainKey: configuredMainKey(context) },
        );
        if (pathname) {
          canonicalLocation = { ...locationWithoutNavigationHints(routeLocation), pathname };
        }
      }
    }
    return {
      kind: "session",
      sessionKey,
      agentId: target.agentId,
      ...draftRouteDataFromLocation(routeLocation),
      face: resolvedFace,
      // Non-null only on a preference-derived open, where it always at least drops the
      // marker from the URL.
      ...(canonicalLocation ? { canonicalLocation, canonicalLocationSource: routeLocation } : {}),
    };
  }
  if (target.kind === "main") {
    await waitForGatewayClient(context.gateway, signal);
    const sessionKey = mainSessionKey(context, target);
    if (preferenceDerived) {
      const resolution = await querySessionReference(
        context,
        { kind: "exact", value: sessionKey, agentId: target.agentId },
        signal,
      );
      if (resolution?.kind === "unique") {
        const resolved = resolvedMainSessionRouteData({
          context,
          location: routeLocation,
          face,
          row: resolution.session,
          target,
          preferenceDerived,
        });
        return resolved ?? notFound({ routeId: face });
      }
    }
    const canonicalLocation = preferenceDerived
      ? locationWithoutNavigationHints(routeLocation)
      : null;
    return {
      kind: "session",
      sessionKey,
      ...draftRouteDataFromLocation(routeLocation),
      face,
      ...(canonicalLocation && canonicalLocation.search !== routeLocation.search
        ? { canonicalLocation, canonicalLocationSource: routeLocation }
        : {}),
    };
  }
  if (target.kind === "literal") {
    let defaultsKnown = hasConfiguredMainKey(context);
    const needsGatewayResolution = preferenceDerived || Boolean(target.slugCandidate);
    if (!defaultsKnown && needsGatewayResolution) {
      await waitForGatewayClient(context.gateway, signal);
      defaultsKnown = hasConfiguredMainKey(context);
      if (defaultsKnown) {
        return await loadChatRoute(context, routeLocation, face, signal);
      }
    }
    if (needsGatewayResolution) {
      // Any single non-short-id segment is a slug candidate, so a plain literal route
      // would otherwise pay a sessions.list round-trip on every open. A cached row is
      // already proof the segment is a real key, which settles the exact lookup for
      // free; only genuinely unknown references reach the gateway.
      const cachedRow = defaultsKnown
        ? findUiSessionRow(context, target.sessionKey, target.agentId)
        : undefined;
      const exactResolution = cachedRow
        ? ({ kind: "unique", session: cachedRow } as const)
        : await querySessionReference(
            context,
            { kind: "exact", value: target.sessionKey, agentId: target.agentId },
            signal,
          );
      if (exactResolution?.kind === "unique") {
        const resolved = resolvedSessionRouteData({
          context,
          location: routeLocation,
          face,
          row: exactResolution.session,
          preferenceDerived,
        });
        return resolved ?? notFound({ routeId: face });
      }
      if (target.slugCandidate && exactResolution?.kind === "not-found") {
        const slugResolution = await querySessionReference(
          context,
          { kind: "slug", value: target.slugCandidate, agentId: target.agentId },
          signal,
        );
        if (slugResolution?.kind === "not-found") {
          return notFound({ routeId: face });
        }
        if (slugResolution?.kind === "ambiguous") {
          return {
            kind: "ambiguous",
            shortId: target.slugCandidate,
            candidates: candidatesForResolution(
              context,
              face,
              slugResolution,
              routeLocation,
              preferenceDerived,
            ),
            truncated: slugResolution.truncated,
            face,
          };
        }
        if (slugResolution?.kind === "unique") {
          // No shortId: a resolved slug canonicalizes to the same short reference every
          // other surface links to, so `/chat/main/deploy-monitor` settles on
          // `/chat/main/deploy-monitor-6db92d48` rather than a full uuid. A later
          // first-block collision lands in the disambiguation view like any short link.
          const resolved = resolvedSessionRouteData({
            context,
            location: routeLocation,
            face,
            row: slugResolution.session,
            preferenceDerived,
          });
          return resolved ?? notFound({ routeId: face });
        }
      }
    }
    const canonicalLocation = defaultsKnown
      ? canonicalMainLocation(context, routeLocation, face, target.sessionKey)
      : null;
    const parsed = parseAgentSessionKey(target.sessionKey);
    const canonicalLocationReady =
      !defaultsKnown && parsed
        ? waitForGatewayClient(context.gateway, signal)
            .then(() => canonicalMainLocation(context, routeLocation, face, target.sessionKey))
            .catch(() => null)
        : undefined;
    const preferenceLocation = preferenceDerived
      ? locationWithoutNavigationHints(routeLocation)
      : null;
    return {
      kind: "session",
      sessionKey: target.sessionKey,
      ...draftRouteDataFromLocation(routeLocation),
      face,
      ...(canonicalLocation
        ? { canonicalLocation, canonicalLocationSource: routeLocation }
        : preferenceLocation && preferenceLocation.search !== routeLocation.search
          ? { canonicalLocation: preferenceLocation, canonicalLocationSource: routeLocation }
          : {}),
      ...(canonicalLocationReady
        ? { canonicalLocationReady, canonicalLocationSource: routeLocation }
        : {}),
    };
  }
  const cached = findCachedShortSession(context, routeLocation, target);
  if (cached && !cached.row) {
    const canonicalLocation = locationWithoutNavigationHints(routeLocation);
    const canonicalLocationChanged = canonicalLocation.search !== routeLocation.search;
    return {
      kind: "session",
      sessionKey: cached.sessionKey,
      ...draftRouteDataFromLocation(routeLocation),
      face,
      ...(target.shortId.length > 8 ? { shortId: target.shortId } : {}),
      ...(canonicalLocationChanged
        ? { canonicalLocation, canonicalLocationSource: routeLocation }
        : {}),
    };
  }
  const resolution = cached?.row
    ? ({ kind: "unique", session: cached.row } as const)
    : narrowShortResolutionBySlugHint(
        requireShortSessionResolution(
          await querySessionReference(
            context,
            { kind: "short", value: target.shortId, agentId: target.agentId },
            signal,
          ),
        ),
        target.slugHint,
      );
  if (resolution.kind === "not-found") {
    return notFound({ routeId: face });
  }
  if (resolution.kind === "ambiguous") {
    return {
      kind: "ambiguous",
      shortId: target.shortId,
      candidates: candidatesForResolution(
        context,
        face,
        resolution,
        routeLocation,
        preferenceDerived,
      ),
      truncated: resolution.truncated,
      face,
    };
  }
  const resolved = resolvedSessionRouteData({
    context,
    location: routeLocation,
    face,
    row: resolution.session,
    preferenceDerived,
    shortId: target.shortId,
  });
  return resolved ?? notFound({ routeId: face });
}
