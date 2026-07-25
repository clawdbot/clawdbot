import {
  controlUiSessionKeyUuid,
  controlUiUniqueShortIdPrefix,
} from "@openclaw/session-url-contract";
import type { RouteLocation } from "@openclaw/uirouter";
import { definePage, notFound } from "@openclaw/uirouter";
import { html, nothing } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import {
  INTERNAL_SESSION_PATH_PARAM,
  pathForSession,
  sessionRefFromPath,
  type SessionPathTarget,
} from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import type { BoardFace } from "../../lib/board/settings.ts";
import {
  buildAgentMainSessionKey,
  resolveAgentIdFromSessionKey,
  resolveUiConfiguredMainKey,
} from "../../lib/sessions/session-key.ts";

const SESSION_REF_SEARCH_LIMIT = 20;

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
      draft?: string;
      face: BoardFace;
      canonicalLocation?: RouteLocation;
    }
  | {
      kind: "ambiguous";
      shortId: string;
      candidates: SessionCandidate[];
      truncated: boolean;
      face: BoardFace;
    };

export type SessionPrefixResolution =
  | { kind: "not-found" }
  | { kind: "unique"; session: GatewaySessionRow }
  | { kind: "ambiguous"; sessions: GatewaySessionRow[]; truncated: boolean };

const resolutionCache = new WeakMap<
  GatewayBrowserClient,
  Map<string, Promise<SessionPrefixResolution | null>>
>();

export function resolveSessionPrefix(
  result: SessionsListResult,
  shortId: string,
): SessionPrefixResolution {
  const prefix = shortId.toLowerCase().replaceAll("-", "");
  const sessions = result.sessions.filter((row) => {
    const keyUuid = controlUiSessionKeyUuid(row.key);
    return keyUuid?.startsWith(prefix) === true;
  });
  if (result.hasMore === true || sessions.length > 1) {
    return { kind: "ambiguous", sessions, truncated: result.hasMore === true };
  }
  if (sessions.length === 0) {
    return { kind: "not-found" };
  }
  const session = sessions[0];
  return session ? { kind: "unique", session } : { kind: "not-found" };
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Session route load aborted", "AbortError");
}

function waitForGatewayClient(
  context: ApplicationContext,
  signal: AbortSignal,
): Promise<GatewayBrowserClient> {
  const current = context.gateway.snapshot.client;
  if (current && context.gateway.snapshot.phase === "connected") {
    return Promise.resolve(current);
  }
  return new Promise((resolve, reject) => {
    let unsubscribe: () => void = () => undefined;
    let settled = false;
    const cleanup = () => {
      unsubscribe();
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(abortError(signal));
    };
    unsubscribe = context.gateway.subscribe((snapshot) => {
      if (snapshot.phase === "connected" && snapshot.client) {
        settled = true;
        cleanup();
        resolve(snapshot.client);
      }
    });
    if (settled) {
      unsubscribe();
    }
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  });
}

async function querySessionPrefix(
  context: ApplicationContext,
  shortId: string,
  signal: AbortSignal,
): Promise<SessionPrefixResolution> {
  while (!signal.aborted) {
    const client = await waitForGatewayClient(context, signal);
    let cache = resolutionCache.get(client);
    if (!cache) {
      cache = new Map();
      resolutionCache.set(client, cache);
    }
    let pending = cache.get(shortId);
    if (!pending) {
      pending = context.sessions
        .list({
          archivedFilter: "all",
          includeDerivedTitles: true,
          limit: SESSION_REF_SEARCH_LIMIT,
          search: shortId.slice(0, 8),
        })
        .then((result) => (result ? resolveSessionPrefix(result, shortId) : null));
      cache.set(shortId, pending);
    }
    try {
      const resolved = await pending;
      if (resolved) {
        return resolved;
      }
    } finally {
      if (cache.get(shortId) === pending) {
        cache.delete(shortId);
      }
    }
  }
  throw abortError(signal);
}

function draftFromLocation(location: RouteLocation): string | undefined {
  return new URLSearchParams(location.search).get("draft") || undefined;
}

function targetFromLocation(location: RouteLocation, basePath: string) {
  const direct = sessionRefFromPath(location.pathname, basePath);
  if (direct) {
    return { target: direct, normalized: false };
  }
  const internalPath = new URLSearchParams(location.search).get(INTERNAL_SESSION_PATH_PARAM);
  const target = internalPath ? sessionRefFromPath(internalPath, basePath) : null;
  return target ? { target, normalized: true } : null;
}

function mainSessionKey(
  context: ApplicationContext,
  target: Extract<SessionPathTarget, { kind: "main" }>,
): string {
  return buildAgentMainSessionKey({
    agentId: target.agentId,
    mainKey: resolveUiConfiguredMainKey({
      agentsList: context.agents.state.agentsList,
      hello: context.gateway.snapshot.hello,
    }),
  });
}

function candidatesForResolution(
  context: ApplicationContext,
  face: BoardFace,
  resolution: Extract<SessionPrefixResolution, { kind: "ambiguous" }>,
): SessionCandidate[] {
  const resolvedRows = resolution.sessions.flatMap((row) => {
    const uuid = controlUiSessionKeyUuid(row.key);
    return uuid ? [{ row, uuid }] : [];
  });
  const uuids = resolvedRows.map(({ uuid }) => uuid);
  return resolvedRows.flatMap(({ row, uuid }) => {
    const prefix = controlUiUniqueShortIdPrefix(uuid, uuids, resolution.truncated);
    if (!prefix) {
      return [];
    }
    const agentId = resolveAgentIdFromSessionKey(row.key);
    const href = pathForSession(face, agentId, row.key, context.basePath, {
      displayName: row.displayName,
      shortIdLength: prefix.length,
    });
    return href
      ? [
          {
            agentId,
            displayName: row.displayName?.trim() || row.key,
            href,
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
  const resolvedTarget = targetFromLocation(location, context.basePath);
  if (!resolvedTarget || resolvedTarget.target.namespace !== face) {
    return notFound({ routeId: face });
  }
  const { target } = resolvedTarget;
  if (target.kind === "main") {
    return {
      kind: "session",
      sessionKey: mainSessionKey(context, target),
      draft: draftFromLocation(location),
      face,
    };
  }
  if (target.kind === "literal") {
    return {
      kind: "session",
      sessionKey: target.sessionKey,
      draft: draftFromLocation(location),
      face,
    };
  }
  const resolution = await querySessionPrefix(context, target.shortId, signal);
  if (resolution.kind === "not-found") {
    return {
      kind: "session",
      sessionKey: target.literalSessionKey,
      draft: draftFromLocation(location),
      face,
    };
  }
  if (resolution.kind === "ambiguous") {
    return {
      kind: "ambiguous",
      shortId: target.shortId,
      candidates: candidatesForResolution(context, face, resolution),
      truncated: resolution.truncated,
      face,
    };
  }
  const row = resolution.session;
  const agentId = resolveAgentIdFromSessionKey(row.key);
  const canonicalPath = pathForSession(face, agentId, row.key, context.basePath, {
    displayName: row.displayName,
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
    ...(!resolvedTarget.normalized && location.pathname !== canonicalPath
      ? { canonicalLocation: { ...location, pathname: canonicalPath } }
      : {}),
  };
}

function renderAmbiguous(data: Extract<ChatRouteData, { kind: "ambiguous" }>) {
  return html`
    <section class="card">
      <h2>${t("chat.sessionRoute.chooseTitle")}</h2>
      <p>${t("chat.sessionRoute.multipleMatches", { shortId: data.shortId })}</p>
      ${data.candidates.map(
        (candidate) => html`
          <p>
            <a href=${candidate.href}>${candidate.displayName}</a><br />
            <small>${candidate.agentId} · ${candidate.idPrefix}</small>
          </p>
        `,
      )}
      ${data.truncated
        ? html`<p><small>${t("chat.sessionRoute.additionalMatches")}</small></p>`
        : null}
    </section>
  `;
}

function sessionPage(face: BoardFace) {
  return definePage({
    id: face,
    path: `/${face}`,
    loaderDeps: (_context: ApplicationContext, location: RouteLocation) =>
      `${location.pathname}\u0000${location.search}`,
    loader: (context: ApplicationContext, { location, signal }) =>
      loadChatRoute(context, location, face, signal),
    component: () =>
      import("./chat-page.ts").then(() => ({
        header: true,
        render: (data: unknown) => {
          const routeData = data as ChatRouteData | undefined;
          if (!routeData) {
            return nothing;
          }
          return routeData.kind === "ambiguous"
            ? renderAmbiguous(routeData)
            : html`<openclaw-chat-page .data=${routeData}></openclaw-chat-page>`;
        },
      })),
  });
}

export const pages = [sessionPage("chat"), sessionPage("dashboard")] as const;
