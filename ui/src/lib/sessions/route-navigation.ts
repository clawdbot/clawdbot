import type { GatewaySessionRow } from "../../api/types.ts";
import { pathForRoute } from "../../app-route-paths.ts";
import { pathForSession } from "../../app-session-path-builder.ts";
import type { ApplicationNavigationOptions, ApplicationContext } from "../../app/context.ts";
import type { BoardFace } from "../board/settings.ts";
import { normalizeOptionalString } from "../string-coerce.ts";
import { catalogSessionSearch, parseCatalogSessionKey } from "./catalog-key.ts";
import {
  areUiSessionKeysEquivalent,
  buildAgentMainSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
  resolveUiDefaultAgentId,
} from "./session-key.ts";

type ContextSessionNavigationTargetParams<TRouteId extends string> = {
  context: ApplicationContext<TRouteId>;
  face: BoardFace;
  sessionKey: string;
  agentId?: string;
  fallbackAgentId?: never;
  basePath?: never;
  row?: never;
  mainKey?: never;
  shortIdLength?: number;
};

type ExplicitSessionNavigationTargetParams = {
  context?: never;
  face: BoardFace;
  sessionKey: string;
  fallbackAgentId: string;
  basePath?: string;
  row?: Pick<GatewaySessionRow, "displayName" | "key">;
  mainKey?: string | null;
  shortIdLength?: number;
  agentId?: never;
};

type SessionNavigationTarget = {
  href: string;
  options: ApplicationNavigationOptions & { pathname: string };
};

export function resolveSessionPreferredFace(
  row: Pick<GatewaySessionRow, "boardFace"> | null | undefined,
): BoardFace {
  return row?.boardFace === "dashboard" ? "dashboard" : "chat";
}

export function resolveSessionPreferredFaceForKey<TRouteId extends string>(
  context: Pick<ApplicationContext<TRouteId>, "sessions">,
  sessionKey: string,
): BoardFace {
  const row = context.sessions.state.result?.sessions.find((candidate) =>
    areUiSessionKeysEquivalent(candidate.key, sessionKey),
  );
  return resolveSessionPreferredFace(row);
}

export function resolveSessionNavigationAgentId<TRouteId extends string>(
  context: Pick<ApplicationContext<TRouteId>, "agents" | "agentSelection" | "gateway">,
  agentId?: string | null,
): string {
  const configured = {
    agentsList: context.agents.state.agentsList,
    hello: context.gateway.snapshot.hello,
  };
  return (
    agentId?.trim() ||
    context.agentSelection.state.selectedId?.trim() ||
    resolveUiDefaultAgentId(configured)
  );
}

function pathForNonCatalogSessionKey(params: {
  face: BoardFace;
  sessionKey: string;
  fallbackAgentId: string;
  basePath: string;
  row?: Pick<GatewaySessionRow, "displayName" | "key">;
  mainKey?: string | null;
  shortIdLength?: number;
}): string {
  const key = params.row?.key ?? params.sessionKey;
  const agentId =
    parseAgentSessionKey(key)?.agentId ?? normalizeOptionalString(params.fallbackAgentId);
  if (!agentId) {
    return pathForRoute(params.face, params.basePath);
  }
  return (
    pathForSession(params.face, normalizeAgentId(agentId), key, params.basePath, {
      displayName: params.row?.displayName,
      mainKey: params.mainKey,
      shortIdLength: params.shortIdLength,
    }) ?? pathForRoute(params.face, params.basePath)
  );
}

export function sessionNavigationTarget<TRouteId extends string>(
  params: ContextSessionNavigationTargetParams<TRouteId> | ExplicitSessionNavigationTargetParams,
): SessionNavigationTarget {
  const context = params.context;
  const sessionKey = params.sessionKey;
  let fallbackAgentId: string;
  let basePath: string;
  let row: Pick<GatewaySessionRow, "displayName" | "key"> | undefined;
  let mainKey: string | null | undefined;
  if (context) {
    const defaults = {
      agentsList: context.agents.state.agentsList,
      hello: context.gateway.snapshot.hello,
    };
    fallbackAgentId = resolveSessionNavigationAgentId(context, params.agentId);
    basePath = context.basePath;
    mainKey = resolveUiConfiguredMainKey(defaults);
    row = context.sessions.state.result?.sessions.find((candidate) =>
      areUiSessionKeysEquivalent(candidate.key, sessionKey),
    );
  } else {
    fallbackAgentId = params.fallbackAgentId;
    basePath = params.basePath ?? "";
    row = params.row;
    mainKey = params.mainKey;
  }

  const catalogKey = parseCatalogSessionKey(row?.key ?? sessionKey);
  const targetKey = catalogKey
    ? buildAgentMainSessionKey({ agentId: fallbackAgentId, mainKey: mainKey ?? "main" })
    : (row?.key ?? sessionKey);
  const pathname = pathForNonCatalogSessionKey({
    face: params.face,
    sessionKey: targetKey,
    fallbackAgentId,
    basePath,
    shortIdLength: params.shortIdLength,
    ...(catalogKey ? { mainKey } : { row, mainKey }),
  });
  const search = catalogKey ? catalogSessionSearch(catalogKey) : undefined;
  const options = search ? { pathname, search } : { pathname };
  return { href: `${pathname}${search ?? ""}`, options };
}
