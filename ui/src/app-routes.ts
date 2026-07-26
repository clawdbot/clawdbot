import { createRouter } from "@openclaw/uirouter";
import type { PageDefinition, Router, RouterHistory } from "@openclaw/uirouter";
import {
  pathForRoute,
  routeIdFromPath,
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
import { page as chatPage } from "./pages/chat/route.ts";
import { pages as configPages } from "./pages/config/route.ts";
import { page as connectionPage } from "./pages/connection/route.ts";
import { page as cronPage } from "./pages/cron/route.ts";
import { page as custodianPage } from "./pages/custodian/route.ts";
import { page as debugPage } from "./pages/debug/route.ts";
import { page as labsPage } from "./pages/labs/route.ts";
import { page as logsPage } from "./pages/logs/route.ts";
import { page as memoryImportPage } from "./pages/memory-import/route.ts";
import { page as modelProvidersPage } from "./pages/model-providers/route.ts";
import { page as modelSetupPage } from "./pages/model-setup/route.ts";
import { page as newSessionPage } from "./pages/new-session/route.ts";
import { page as nodesPage } from "./pages/nodes/route.ts";
import { page as pluginPage } from "./pages/plugin/route.ts";
import { page as pluginsPage } from "./pages/plugins/route.ts";
import { page as profilePage } from "./pages/profile/route.ts";
import { page as sessionsPage } from "./pages/sessions/route.ts";
import { page as skillWorkshopPage } from "./pages/skill-workshop/route.ts";
import { page as skillsPage } from "./pages/skills/route.ts";
import { page as tasksPage } from "./pages/tasks/route.ts";
import { page as usagePage } from "./pages/usage/route.ts";
import { page as workboardPage } from "./pages/workboard/route.ts";
import { page as worktreesPage } from "./pages/worktrees/route.ts";

type AppRouteModule = {
  render: (data: unknown) => unknown;
};

export type ApplicationRouter = Router<
  RouteId,
  ApplicationContext<RouteId>,
  AppRouteModule,
  unknown
>;
type AppRoute = PageDefinition<RouteId, ApplicationContext<RouteId>, AppRouteModule>;

const APP_ROUTE_TREE = [
  chatPage,
  custodianPage,
  newSessionPage,
  activityPage,
  appsPage,
  agentsPage,
  approvalsPage,
  channelsPage,
  connectionPage,
  labsPage,
  aboutPage,
  ...configPages,
  modelSetupPage,
  modelProvidersPage,
  memoryImportPage,
  profilePage,
  workboardPage,
  worktreesPage,
  sessionsPage,
  usagePage,
  debugPage,
  logsPage,
  skillWorkshopPage,
  skillsPage,
  pluginsPage,
  cronPage,
  tasksPage,
  nodesPage,
  pluginPage,
] as const;

const appRoutes = APP_ROUTE_TREE as readonly AppRoute[];

export function createApplicationRouter(): ApplicationRouter {
  const router = createRouter<RouteId, ApplicationContext<RouteId>, AppRouteModule>({
    routes: appRoutes,
  });
  // The shared router intentionally matches exact paths only. Workboard board
  // ids are runtime data, so the app owns this one dynamic path family.
  return {
    ...router,
    routeIdFromPath,
  };
}

function routerHistoryLocation(location: ReturnType<RouterHistory["location"]>, basePath: string) {
  const boardId = workboardBoardIdFromPath(location.pathname, basePath);
  if (!boardId) {
    return location;
  }
  const search = new URLSearchParams(location.search);
  search.set("board", boardId);
  return {
    ...location,
    pathname: pathForRoute("workboard", basePath),
    search: `?${search.toString()}`,
  };
}

export async function startApplicationRouter(
  router: ApplicationRouter,
  history: RouterHistory,
  basePath: string,
  context: ApplicationContext<RouteId>,
): Promise<void> {
  let location = history.location();
  // Unknown paths (including retired routes like /overview) land on chat, so
  // removed pages need no legacy aliases for stale bookmarks or history.
  if (routeIdFromPath(location.pathname, basePath) === null) {
    history.replace({
      ...location,
      pathname: router.pathForRoute("chat", basePath),
    });
    location = history.location();
  }
  const initialBoardId = workboardBoardIdFromPath(location.pathname, basePath);
  const applicationHistory: RouterHistory = {
    location: () => routerHistoryLocation(history.location(), basePath),
    push: (next) => history.push(next),
    replace: (next) => history.replace(next),
    listen: (listener) =>
      history.listen((next) => {
        if (workboardBoardIdFromPath(next.pathname, basePath)) {
          void router
            .navigate("workboard", context, { history: "none" }, next)
            .catch((error: unknown) => {
              console.error("[openclaw] Workboard route navigation failed", error);
            });
          return;
        }
        listener(next);
      }),
  };
  await router.start(applicationHistory, basePath, context);
  if (initialBoardId) {
    // Replace the synthetic exact-match location with the real browser path
    // before the shell renders; the matching board data is already cached.
    await router.navigate("workboard", context, { history: "none", revalidate: true }, location);
  }
}

export {
  APP_ROUTE_IDS,
  isRouteId,
  locationForRoute,
  pathForRoute,
  routeIdFromPath,
  type RouteId,
} from "./app-route-paths.ts";
