import { normalizeRouteBasePath } from "@openclaw/uirouter";

type DashboardDocumentLocation = Pick<Location, "search">;

export function isDashboardOnlyView(
  location: DashboardDocumentLocation | undefined = globalThis.location,
): boolean {
  return new URLSearchParams(location?.search ?? "").get("view") === "dashboard";
}

export function dashboardDocumentSession(
  location: DashboardDocumentLocation | undefined = globalThis.location,
): string | null {
  return new URLSearchParams(location?.search ?? "").get("session");
}

export function dashboardDocumentHref(basePath: string, sessionRef: string): string {
  const path = normalizeRouteBasePath(basePath) || "/";
  const search = new URLSearchParams({ view: "dashboard", session: sessionRef });
  return `${path}?${search}`;
}
