import type { ApplicationNavigationOptions } from "../app/context.ts";
import { catalogSessionSearch, type CatalogSessionKey } from "../lib/sessions/catalog-key.ts";
import { pathForSessionKey } from "../lib/sessions/index.ts";
import { buildAgentMainSessionKey } from "../lib/sessions/session-key.ts";

export function catalogSessionNavigation(
  agentId: string,
  key: CatalogSessionKey,
  basePath: string,
  mainKey: string,
): { href: string; navigation: ApplicationNavigationOptions } {
  const pathname = pathForSessionKey(
    "chat",
    buildAgentMainSessionKey({ agentId, mainKey }),
    agentId,
    basePath,
    undefined,
    mainKey,
  );
  const search = catalogSessionSearch(key);
  return { href: `${pathname}${search}`, navigation: { pathname, search } };
}
