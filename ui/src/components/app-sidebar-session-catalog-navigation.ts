import type { ApplicationNavigationOptions } from "../app/context.ts";
import { catalogSessionSearch, type CatalogSessionKey } from "../lib/sessions/catalog-key.ts";
import { pathForSessionKey } from "../lib/sessions/index.ts";

export function catalogSessionNavigation(
  agentId: string,
  key: CatalogSessionKey,
  basePath = "",
): { href: string; navigation: ApplicationNavigationOptions } {
  const pathname = pathForSessionKey("chat", `agent:${agentId}:main`, basePath);
  const search = catalogSessionSearch(key);
  return { href: `${pathname}${search}`, navigation: { pathname, search } };
}
