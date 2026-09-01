import { createRouter } from "@openclaw/uirouter";
import type {
  PageDefinition,
  RouteLocation,
  RouteMatch,
  RouteNotFound,
  Router,
  RouterHistory,
} from "@openclaw/uirouter";
import {
  activityPersonFromPath,
  agentRouteFromPath,
  INTERNAL_ACTIVITY_PATH_PARAM,
  INTERNAL_AGENT_PATH_PARAM,
  INTERNAL_MEMORY_PATH_PARAM,
  INTERNAL_PLUGINS_PATH_PARAM,
  INTERNAL_SESSION_PATH_PARAM,
  INTERNAL_WORKBOARD_PATH_PARAM,
  memoryTabFromPath,
  pathForAgentPanel,
  pathForRoute,
  pluginsHubTabFromPath,
  routeIdFromPath,
  sessionRouteNamespaceFromPath,
  workboardBoardIdFromPath,
  type RouteId,
} from "./app-route-paths.ts";
import type { ApplicationContext } from "./app/context.ts";
import { page as aboutPage } from "./pages/about/route.ts";
import { page as activityPage } from "./pages/activity/route.ts";
import { page as agentsPage } from "./pages/agents/route.ts";
import { page as approvalsPage } from "./pages/approvals/route.ts";
import { page as appsPage } from "./pages/apps/route.ts";
import { page as channelsPage } from "./pages/channels/route.ts";
import { pages as chatPages } from "./pages/chat/route.ts";
import { page as cloudWorkersPage } from "./pages/cloud-workers/route.ts";
import { pages as configPages } from "./pages/config/route.ts";
import { page as connectionPage } from "./pages/connection/route.ts";
import { page as cronPage } from "./pages/cron/route.ts";
import { page as custodianPage } from "./pages/custodian/route.ts";
import { page as dashboardsPage } from "./pages/dashboards/route.ts";
import { page as debugPage } from "./pages/debug/route.ts";
import { page as devicesPage } from "./pages/devices/route.ts";
import { page as labsPage } from "./pages/labs/route.ts";
import { page as lobsterdexPage } from "./pages/lobsterdex/route.ts";
import { page as logsPage } from "./pages/logs/route.ts";
import { page as meetingsPage } from "./pages/meetings/route.ts";
import { page as memoryImportPage } from "./pages/memory-import/route.ts";
import { page as modelProvidersPage } from "./pages/model-providers/route.ts";
import { page as modelSetupPage } from "./pages/model-setup/route.ts";
import { page as newSessionPage } from "./pages/new-session/route.ts";
import { page as pluginPage } from "./pages/plugin/route.ts";
import { page as pluginsPage } from "./pages/plugins/route.ts";
import { page as portalsPage } from "./pages/portals/route.ts";
import { page as profilePage } from "./pages/profile/route.ts";
import { page as secretsPage } from "./pages/secrets/route.ts";
import { page as sessionsPage } from "./pages/sessions/route.ts";
import { page as skillWorkshopPage } from "./pages/skill-workshop/route.ts";
import { page as skillsPage } from "./pages/skills/route.ts";
import { page as tasksPage } from "./pages/tasks/route.ts";
import { page as usagePage } from "./pages/usage/route.ts";
import { resolveWorkboardRouteLocation } from "./pages/workboard/route-location.ts";
import { page as workboardPage } from "./pages/workboard/route.ts";
import { page as worktreesPage } from "./pages/worktrees/route.ts";

type AppRouteModule = {
  render: (data: unknown, loaderPending: boolean) => unknown;
  renderOwnerKey?: (
    match: Pick<RouteMatch, "data" | "location">,
    settled: Pick<RouteMatch, "data" | "location"> | undefined,
  ) => string | undefined;
};

export type ApplicationRouter = Router<
  RouteId,
  ApplicationContext<RouteId>,
  AppRouteModule,
  unknown
>;
type AppRoute = PageDefinition<RouteId, ApplicationContext<RouteId>, AppRouteModule>;

const APP_ROUTE_TREE = [
  ...chatPages,
  custodianPage,
  newSessionPage,
  activityPage,
  meetingsPage,
  dashboardsPage,
  appsPage,
  portalsPage,
  agentsPage,
  approvalsPage,
  channelsPage,
  cloudWorkersPage,
  connectionPage,
  labsPage,
  aboutPage,
  lobsterdexPage,
  ...configPages,
  modelSetupPage,
  modelProvidersPage,
  memoryImportPage,
  profilePage,
  workboardPage,
  worktreesPage,
  sessionsPage,
  secretsPage,
  usagePage,
  debugPage,
  logsPage,
  skillWorkshopPage,
  skillsPage,
  pluginsPage,
  cronPage,
  tasksPage,
  devicesPage,
  pluginPage,
] as const;

const appRoutes = APP_ROUTE_TREE as readonly AppRoute[];

/** Starts route chunk downloads without running the route's loader. */
export function warmApplicationRouteModule(
  router: ApplicationRouter,
  location: RouteLocation,
  basePath: string,
): void {
  const routeId = routeIdFromPath(location.pathname, basePath);
  const route = routeId ? router.getRoute(routeId) : null;
  if (route) {
    // Navigation owns chunk errors; its import reuses the browser's module cache.
    void Promise.resolve(route.component()).catch(() => undefined);
  }
}

function canonicalRouteLocation(
  routeId: RouteId | null,
  location: RouteLocation,
  basePath: string,
): RouteLocation {
  return routeId === "workboard"
    ? (resolveWorkboardRouteLocation(location, basePath).canonicalLocation ?? location)
    : location;
}

export function createApplicationRouter(): ApplicationRouter {
  const router = createRouter<RouteId, ApplicationContext<RouteId>, AppRouteModule>({
    routes: appRoutes,
  });
  // The shared router intentionally matches exact paths only. People, Workboard
  // ids, hub tabs, and session refs are runtime data, so the app owns those paths.
  return {
    ...router,
    navigate: (routeId, context, options, location) =>
      router.navigate(
        routeId,
        context,
        options,
        location ? canonicalRouteLocation(routeId, location, context.basePath) : undefined,
      ),
    routeIdFromPath,
  };
}

type DynamicRoute = readonly [routeId: RouteId, searchKey: string, searchValue: string];

function dynamicRouteFromPath(pathname: string, basePath: string): DynamicRoute | null {
  if (activityPersonFromPath(pathname, basePath)) {
    return ["activity", INTERNAL_ACTIVITY_PATH_PARAM, pathname];
  }
  const agentRoute = agentRouteFromPath(pathname, basePath);
  if (agentRoute) {
    return ["agents", INTERNAL_AGENT_PATH_PARAM, pathname];
  }
  const boardId = workboardBoardIdFromPath(pathname, basePath);
  if (boardId) {
    return ["workboard", INTERNAL_WORKBOARD_PATH_PARAM, pathname];
  }
  const memoryTab = memoryTabFromPath(pathname, basePath);
  if (memoryTab && memoryTab !== "overview") {
    return ["memory", INTERNAL_MEMORY_PATH_PARAM, pathname];
  }
  const pluginsTab = pluginsHubTabFromPath(pathname, basePath);
  if (pluginsTab === "discover") {
    return ["plugins", INTERNAL_PLUGINS_PATH_PARAM, pathname];
  }
  const sessionNamespace = sessionRouteNamespaceFromPath(pathname, basePath);
  return sessionNamespace ? [sessionNamespace, INTERNAL_SESSION_PATH_PARAM, pathname] : null;
}

function routerHistoryLocation(location: ReturnType<RouterHistory["location"]>, basePath: string) {
  const dynamicRoute = dynamicRouteFromPath(location.pathname, basePath);
  if (!dynamicRoute) {
    return location;
  }
  const [routeId, searchKey, searchValue] = dynamicRoute;
  const search = new URLSearchParams(location.search);
  search.set(searchKey, searchValue);
  return {
    ...location,
    pathname: pathForRoute(routeId, basePath),
    search: `?${search.toString()}`,
  };
}

export function sameRouteLocation(left: RouteLocation, right: RouteLocation): boolean {
  return (
    left.pathname === right.pathname && left.search === right.search && left.hash === right.hash
  );
}

function isRouteNotFound(error: unknown): error is RouteNotFound {
  return (
    typeof error === "object" && error !== null && "type" in error && error.type === "notFound"
  );
}

async function tolerateRouteNotFound(navigation: Promise<void>): Promise<void> {
  try {
    await navigation;
  } catch (error) {
    // uirouter commits not-found state before rethrowing; the outlet owns its recovery UI.
    if (!isRouteNotFound(error)) {
      throw error;
    }
  }
}

export async function startApplicationRouter(
  router: ApplicationRouter,
  history: RouterHistory,
  basePath: string,
  context: ApplicationContext<RouteId>,
): Promise<void> {
  let location = history.location();
  const canonicalLocation = canonicalRouteLocation(
    routeIdFromPath(location.pathname, basePath),
    location,
    basePath,
  );
  // Normalize the requested URL before loaders or preload caches can outlive it.
  if (!sameRouteLocation(location, canonicalLocation)) {
    history.replace(canonicalLocation);
    location = history.location();
  }
  const initialAgentRoute = agentRouteFromPath(location.pathname, basePath);
  if (initialAgentRoute?.invalidPanel) {
    history.replace({
      ...location,
      pathname: pathForAgentPanel(initialAgentRoute.agentId, null, basePath),
    });
    location = history.location();
  }
  // Unknown paths (including retired routes like /overview) land on chat, so
  // removed pages need no legacy aliases for stale bookmarks or history.
  if (routeIdFromPath(location.pathname, basePath) === null) {
    history.replace({
      ...location,
      pathname: router.pathForRoute("chat", basePath),
    });
    location = history.location();
  }
  const initialDynamicRoute = dynamicRouteFromPath(location.pathname, basePath);
  const applicationHistory: RouterHistory = {
    location: () => routerHistoryLocation(history.location(), basePath),
    push: (next) => history.push(next),
    replace: (next) => history.replace(next),
    listen: (listener) =>
      history.listen((next) => {
        const canonical = canonicalRouteLocation(
          routeIdFromPath(next.pathname, basePath),
          next,
          basePath,
        );
        if (!sameRouteLocation(next, canonical)) {
          history.replace(canonical);
        }
        const dynamicRoute = dynamicRouteFromPath(canonical.pathname, basePath);
        if (dynamicRoute) {
          void router
            .navigate(dynamicRoute[0], context, { history: "none" }, canonical)
            .catch((error: unknown) => {
              console.error("[openclaw] Dynamic route navigation failed", error);
            });
          return;
        }
        listener(canonical);
      }),
  };
  await tolerateRouteNotFound(router.start(applicationHistory, basePath, context));
  if (initialDynamicRoute && sameRouteLocation(history.location(), location)) {
    // Replace the synthetic exact-match location with the real browser path
    // before the shell renders. A loader-visible redirect wins if it already
    // moved history while startup was still resolving.
    await tolerateRouteNotFound(
      router.navigate(initialDynamicRoute[0], context, { history: "none" }, location),
    );
  }
}

export {
  APP_ROUTE_IDS,
  isRouteId,
  locationForRoute,
  routeIdFromPath,
  type RouteId,
} from "./app-route-paths.ts";
