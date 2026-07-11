import { createRouter } from "@openclaw/uirouter";
import type { PageDefinition, Router, RouterHistory } from "@openclaw/uirouter";
import { routeIdFromPath, type RouteId } from "./app-route-paths.ts";
import type { ApplicationContext } from "./app/context.ts";
import { page as aboutPage } from "./pages/about/route.ts";
import { page as activityPage } from "./pages/activity/route.ts";
import { page as agentsPage } from "./pages/agents/route.ts";
import { page as channelsPage } from "./pages/channels/route.ts";
import { page as chatPage } from "./pages/chat/route.ts";
import { pages as configPages } from "./pages/config/route.ts";
import { page as cronPage } from "./pages/cron/route.ts";
import { page as debugPage } from "./pages/debug/route.ts";
import { page as dreamsPage } from "./pages/dreams/route.ts";
import { page as instancesPage } from "./pages/instances/route.ts";
import { page as logsPage } from "./pages/logs/route.ts";
import { page as modelProvidersPage } from "./pages/model-providers/route.ts";
import { page as nodesPage } from "./pages/nodes/route.ts";
import { page as overviewPage } from "./pages/overview/route.ts";
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
  overviewPage,
  activityPage,
  agentsPage,
  channelsPage,
  aboutPage,
  ...configPages,
  modelProvidersPage,
  profilePage,
  workboardPage,
  worktreesPage,
  instancesPage,
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
  dreamsPage,
  pluginPage,
] as const;

const appRoutes = APP_ROUTE_TREE as readonly AppRoute[];

export function createApplicationRouter(): ApplicationRouter {
  return createRouter<RouteId, ApplicationContext<RouteId>, AppRouteModule>({
    routes: appRoutes,
  });
}

export async function startApplicationRouter(
  router: ApplicationRouter,
  history: RouterHistory,
  basePath: string,
  context: ApplicationContext<RouteId>,
): Promise<void> {
  const location = history.location();
  if (routeIdFromPath(location.pathname, basePath) === null) {
    history.replace({
      ...location,
      pathname: router.pathForRoute("chat", basePath),
    });
  }
  await router.start(history, basePath, context);
}

export {
  APP_ROUTE_IDS,
  inferBasePathFromPathname,
  isRouteId,
  locationForRoute,
  normalizeBasePath,
  pathForRoute,
  routeIdFromPath,
  type RouteId,
} from "./app-route-paths.ts";
