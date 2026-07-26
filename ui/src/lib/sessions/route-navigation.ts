import type { ApplicationNavigationOptions, ApplicationContext } from "../../app/context.ts";
import type { BoardFace } from "../board/settings.ts";
import { catalogSessionSearch, parseCatalogSessionKey } from "./catalog-key.ts";
import { pathForSessionKey } from "./navigation.ts";
import {
  areUiSessionKeysEquivalent,
  buildAgentMainSessionKey,
  resolveUiConfiguredMainKey,
  resolveUiDefaultAgentId,
} from "./session-key.ts";

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

export function sessionRouteNavigationOptions<TRouteId extends string>(params: {
  context: ApplicationContext<TRouteId>;
  face: BoardFace;
  sessionKey: string;
  agentId?: string;
}): ApplicationNavigationOptions {
  const { context, face, sessionKey } = params;
  const defaults = {
    agentsList: context.agents.state.agentsList,
    hello: context.gateway.snapshot.hello,
  };
  const mainKey = resolveUiConfiguredMainKey(defaults);
  const fallbackAgentId = resolveSessionNavigationAgentId(context, params.agentId);
  const catalogKey = parseCatalogSessionKey(sessionKey);
  if (catalogKey) {
    const mainSessionKey = buildAgentMainSessionKey({ agentId: fallbackAgentId, mainKey });
    return {
      pathname: pathForSessionKey(
        face,
        mainSessionKey,
        fallbackAgentId,
        context.basePath,
        undefined,
        mainKey,
      ),
      search: catalogSessionSearch(catalogKey),
    };
  }
  const row = context.sessions.state.result?.sessions.find((candidate) =>
    areUiSessionKeysEquivalent(candidate.key, sessionKey),
  );
  return {
    pathname: pathForSessionKey(
      face,
      row?.key ?? sessionKey,
      fallbackAgentId,
      context.basePath,
      row,
      mainKey,
    ),
  };
}
