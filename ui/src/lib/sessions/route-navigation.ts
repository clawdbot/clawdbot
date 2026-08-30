import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { GatewaySessionRow } from "../../api/types.ts";
import { pathForRoute } from "../../app-route-paths.ts";
import { pathForSession } from "../../app-session-path-builder.ts";
import type { ApplicationNavigationOptions, ApplicationContext } from "../../app/context.ts";
import type { BoardFace } from "../board/settings.ts";
import { catalogSessionSearch, parseCatalogSessionKey } from "./catalog-key.ts";
import {
  areUiSessionKeysEquivalent,
  buildAgentMainSessionKey,
  isUiGlobalSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
  resolveUiDefaultAgentId,
} from "./session-key.ts";

export const SESSION_FACE_PREFERENCE_PARAM = "__openclawSessionFacePreference";
export const SESSION_NAVIGATION_KEY_PARAM = "__openclawSessionKey";
export const SESSION_COMPOSER_FOCUS_PARAM = "__openclawComposerFocus";

export function composerDraftSearch(draft: string): string {
  return `?${new URLSearchParams({ draft, [SESSION_COMPOSER_FOCUS_PARAM]: "1" }).toString()}`;
}
const SESSION_KEY_UUID_SUFFIX_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

type SessionNavigationContext<TRouteId extends string> = Pick<
  ApplicationContext<TRouteId>,
  "agents" | "agentSelection" | "basePath" | "gateway" | "sessions"
>;

type ContextSessionNavigationTargetParams<TRouteId extends string> = {
  context: SessionNavigationContext<TRouteId>;
  face: BoardFace;
  sessionKey: string;
  agentId?: string;
  fallbackAgentId?: never;
  basePath?: never;
  row?: never;
  mainKey?: never;
  shortIdLength?: number;
  exactKey?: boolean;
  preferenceDerivedFace?: boolean;
  focusComposer?: boolean;
  navigationKey?: string;
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
  exactKey?: boolean;
  agentId?: never;
  preferenceDerivedFace?: boolean;
  focusComposer?: boolean;
  navigationKey?: string;
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

export function findUiSessionRow<TRouteId extends string>(
  context: Pick<ApplicationContext<TRouteId>, "sessions" | "agents" | "agentSelection" | "gateway">,
  sessionKey: string,
  agentId?: string | null,
): GatewaySessionRow | undefined {
  const row = context.sessions.state.result?.sessions.find((candidate) =>
    areUiSessionKeysEquivalent(candidate.key, sessionKey),
  );
  if (!row || !isUiGlobalSessionKey(row.key)) {
    return row;
  }
  // A canonical global row carries no owner in its key. Only reuse it while
  // the list's scope matches the navigation owner or its board face can leak across agents.
  const resultAgentId = context.sessions.state.agentId?.trim();
  const navigationAgentId = resolveSessionNavigationAgentId(context, agentId);
  return resultAgentId && normalizeAgentId(resultAgentId) === normalizeAgentId(navigationAgentId)
    ? row
    : undefined;
}

export function resolveSessionPreferredFaceForKey<TRouteId extends string>(
  context: Pick<ApplicationContext<TRouteId>, "sessions" | "agents" | "agentSelection" | "gateway">,
  sessionKey: string,
  agentId?: string | null,
): BoardFace {
  return resolveSessionPreferredFace(findUiSessionRow(context, sessionKey, agentId));
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
  exactKey?: boolean;
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
      exactKey: params.exactKey,
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
    row = findUiSessionRow(context, sessionKey, fallbackAgentId);
  } else {
    fallbackAgentId = params.fallbackAgentId;
    basePath = params.basePath ?? "";
    row = params.row;
    mainKey = params.mainKey;
  }

  const catalogKey = parseCatalogSessionKey(row?.key ?? sessionKey);
  const targetKey = catalogKey
    ? buildAgentMainSessionKey({
        agentId: parseAgentSessionKey(sessionKey)?.agentId ?? fallbackAgentId,
        mainKey: mainKey ?? "main",
      })
    : (row?.key ?? sessionKey);
  const pathname = pathForNonCatalogSessionKey({
    face: params.face,
    sessionKey: targetKey,
    fallbackAgentId,
    basePath,
    shortIdLength: params.shortIdLength,
    exactKey: params.exactKey,
    ...(catalogKey ? { mainKey } : { row, mainKey }),
  });
  const search = catalogKey ? catalogSessionSearch(catalogKey) : undefined;
  // A cached row carries the authoritative boardFace, so the caller's face is already
  // correct. Only an uncached key made it a guess: mark the in-app navigation so the
  // chat loader re-derives the face from the gateway and replaces the URL.
  //
  // The marker stays out of `href` on purpose. That string is what users hover, copy,
  // and share, and it must not carry an internal parameter. The accepted cost is that
  // alternate activation (middle-click, open-in-new-tab, modified click) follows the
  // clean guessed path and can land on the other face for an uncached session, exactly
  // as every open did before gateway resolution existed. The face is one click to
  // change and the change persists, so this is a smaller win, not a regression.
  const navigationParams = new URLSearchParams(search ?? "");
  if (params.preferenceDerivedFace && !row) {
    navigationParams.set(SESSION_FACE_PREFERENCE_PARAM, "1");
  }
  if (params.focusComposer) {
    navigationParams.set(SESSION_COMPOSER_FOCUS_PARAM, "1");
  }
  const navigationKey = params.navigationKey?.trim() || row?.key;
  if (navigationKey && SESSION_KEY_UUID_SUFFIX_RE.test(navigationKey)) {
    // Sidebar navigation already owns the full row. Carry its key only through the
    // in-app location so the short route never has to rediscover it from sessions.list.
    navigationParams.set(SESSION_NAVIGATION_KEY_PARAM, navigationKey);
  }
  const serializedNavigation = navigationParams.toString();
  const options = serializedNavigation
    ? { pathname, search: `?${serializedNavigation}` }
    : { pathname };
  return { href: `${pathname}${search ?? ""}`, options };
}
