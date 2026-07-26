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
  const catalogKey = parseCatalogSessionKey(sessionKey);
  if (catalogKey) {
    const agentId =
      params.agentId?.trim() ||
      context.agentSelection.state.selectedId?.trim() ||
      resolveUiDefaultAgentId(defaults);
    const mainSessionKey = buildAgentMainSessionKey({ agentId, mainKey });
    return {
      pathname: pathForSessionKey(face, mainSessionKey, context.basePath, undefined, mainKey),
      search: catalogSessionSearch(catalogKey),
    };
  }
  const row = context.sessions.state.result?.sessions.find((candidate) =>
    areUiSessionKeysEquivalent(candidate.key, sessionKey),
  );
  return {
    pathname: pathForSessionKey(face, row?.key ?? sessionKey, context.basePath, row, mainKey),
  };
}
