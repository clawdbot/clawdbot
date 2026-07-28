import { inferBasePathFromPathname, routeIdFromPath } from "../../app-route-paths.ts";

export function custodianUiContextFromPath(pathname: string): { page: string } | undefined {
  const basePath = inferBasePathFromPathname(pathname);
  const page = routeIdFromPath(pathname, basePath);
  return page ? { page } : undefined;
}

export function currentCustodianUiContext(): { page: string } | undefined {
  return custodianUiContextFromPath(window.location.pathname);
}
