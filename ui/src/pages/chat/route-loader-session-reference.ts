import { SHORT_SESSION_ID_RE } from "@openclaw/session-url-contract";
import type { SessionsResolveResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { pathForRoute } from "../../app-route-paths.ts";
import { waitForGatewayClient } from "../../app/gateway-readiness.ts";
import type { BoardFace } from "../../lib/board/settings.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import {
  buildAgentMainSessionKey,
  normalizeAgentId,
  resolveUiConfiguredMainKey,
} from "../../lib/sessions/session-key.ts";
import { subscribeToSharedRequest } from "../../lib/shared-request-subscription.ts";
import type { SessionRouteContext as ApplicationContext } from "./route-loader-context.ts";
import {
  sessionReferenceResolution,
  type SessionReferenceResolution,
} from "./route-loader-short-resolve.ts";

export type MissingSessionRouteData = {
  kind: "missing-session";
  face: BoardFace;
  currentSessionHref: string;
  sessionsHref: string;
};

type SessionReferenceSearch = { agentId: string; key: string; slug?: string };

type PendingSessionReference = {
  controller: AbortController;
  promise: Promise<SessionReferenceResolution | null>;
  subscribers: Set<AbortSignal>;
};

const resolutionCache = new WeakMap<GatewayBrowserClient, Map<string, PendingSessionReference>>();

export function missingSessionRouteData(
  context: ApplicationContext,
  face: BoardFace,
  agentId: string,
): MissingSessionRouteData {
  const mainKey = resolveUiConfiguredMainKey({
    agentsList: context.agents.state.agentsList,
    hello: context.gateway.snapshot.hello,
  });
  const mainSessionKey = buildAgentMainSessionKey({ agentId, mainKey });
  return {
    kind: "missing-session",
    face,
    currentSessionHref: sessionNavigationTarget({
      context,
      face,
      sessionKey: mainSessionKey,
      agentId,
    }).href,
    sessionsHref: pathForRoute("sessions", context.basePath),
  };
}

export function uniqueShortIdPrefix(
  value: string,
  candidates: readonly string[],
  truncated: boolean,
): string | null {
  const uuid = value.toLowerCase().replaceAll("-", "");
  if (!SHORT_SESSION_ID_RE.test(uuid)) {
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

export async function querySessionReference(
  context: ApplicationContext,
  search: SessionReferenceSearch,
  signal: AbortSignal,
): Promise<SessionReferenceResolution | null> {
  const client = await waitForGatewayClient(context.gateway, signal);
  signal.throwIfAborted();
  const cache = resolutionCache.get(client) ?? new Map<string, PendingSessionReference>();
  resolutionCache.set(client, cache);
  const cacheKey = JSON.stringify([normalizeAgentId(search.agentId), search.key, search.slug]);
  let pending = cache.get(cacheKey);
  if (!pending || pending.controller.signal.aborted) {
    const controller = new AbortController();
    const { hello } = context.gateway.snapshot;
    const isCurrent = () =>
      context.gateway.snapshot.phase === "connected" &&
      context.gateway.snapshot.client === client &&
      context.gateway.snapshot.hello === hello;
    pending = {
      controller,
      promise: Promise.resolve().then(async () => {
        controller.signal.throwIfAborted();
        if (!isCurrent()) {
          return null;
        }
        try {
          const result = await client.request<SessionsResolveResult>("sessions.resolve", {
            reference: { key: search.key, ...(search.slug ? { slug: search.slug } : {}) },
            agentId: search.agentId,
            includeGlobal: true,
            includeUnknown: true,
            allowMissing: true,
          });
          return isCurrent() ? sessionReferenceResolution(result) : null;
        } catch (error) {
          // Reconnects abandon old discovery; current failures belong to the route's error view.
          if (!isCurrent()) {
            return null;
          }
          throw error;
        }
      }),
      subscribers: new Set(),
    };
    cache.set(cacheKey, pending);
  }
  const shared = pending;
  return await subscribeToSharedRequest(shared, signal, signal, () => {
    if (shared.subscribers.size === 0 && cache.get(cacheKey) === shared) {
      cache.delete(cacheKey);
    }
  });
}
