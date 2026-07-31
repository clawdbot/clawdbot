import type { RouteLocation, RouterHistory } from "@openclaw/uirouter";
import { sessionRouteNamespaceFromPath } from "../../app-route-paths.ts";
import type { RouteId } from "../../app-routes.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { cacheModelSetupDetection, type ModelSetupDetectionConnection } from "./detect-cache.ts";
import { detectModelSetup } from "./rpc.ts";

export function isDefaultChatLanding(
  location: RouteLocation,
  basePath: string,
  routeIdFromPath: (pathname: string, basePath: string) => string | null,
): boolean {
  const query = new URLSearchParams(location.search);
  const hash = new URLSearchParams(location.hash.startsWith("#") ? location.hash.slice(1) : "");
  if (query.has("session") || hash.has("session")) {
    return false;
  }
  const routeId = routeIdFromPath(location.pathname, basePath);
  if (routeId !== null && routeId !== "chat") {
    return false;
  }
  return sessionRouteNamespaceFromPath(location.pathname, basePath) === null;
}

function locationsMatch(left: RouteLocation, right: RouteLocation): boolean {
  // Session aliases are canonicalized into the pathname before this guard;
  // the removed query-based session identity needs no separate comparison.
  return (
    left.pathname === right.pathname && left.search === right.search && left.hash === right.hash
  );
}

export async function startModelSetupFirstRunRedirectAfterLocation(params: {
  context: ApplicationContext<RouteId>;
  enabled: boolean;
  history: Pick<RouterHistory, "location" | "replace">;
  initialLocationReady: Promise<RouteLocation>;
  installLocation?: (location: RouteLocation) => void | Promise<void>;
  shouldInstallLocation?: () => boolean;
}): Promise<() => void> {
  const initialLocation = await params.initialLocationReady;
  if (
    !locationsMatch(params.history.location(), initialLocation) &&
    params.shouldInstallLocation?.() !== false
  ) {
    if (params.installLocation) {
      await params.installLocation(initialLocation);
    } else {
      params.history.replace(initialLocation);
    }
  }
  if (!params.enabled) {
    return () => undefined;
  }
  return startModelSetupFirstRunRedirect({
    context: params.context,
    isStillDefaultLanding: () => locationsMatch(params.history.location(), initialLocation),
  });
}

function startModelSetupFirstRunRedirect(params: {
  context: ApplicationContext<RouteId>;
  isStillDefaultLanding: () => boolean;
}): () => void {
  let attemptedConnection: ModelSetupDetectionConnection | null = null;
  let redirected = false;
  const handleSnapshot: Parameters<ApplicationContext<RouteId>["gateway"]["subscribe"]>[0] = (
    snapshot,
  ) => {
    if (
      redirected ||
      snapshot.phase !== "connected" ||
      !snapshot.client ||
      !hasOperatorAdminAccess(snapshot.hello?.auth ?? null) ||
      isGatewayMethodAdvertised(snapshot, "openclaw.setup.detect") !== true
    ) {
      return;
    }
    const connection = { client: snapshot.client, hello: snapshot.hello };
    if (
      connection.client === attemptedConnection?.client &&
      connection.hello === attemptedConnection?.hello
    ) {
      return;
    }
    attemptedConnection = connection;
    void detectModelSetup(snapshot.client)
      .then((result) => {
        const current = params.context.gateway.snapshot;
        if (
          current.phase !== "connected" ||
          current.client !== connection.client ||
          current.hello !== connection.hello
        ) {
          return;
        }
        cacheModelSetupDetection(connection, result);
        if (!result.setupComplete && !redirected && params.isStillDefaultLanding()) {
          redirected = true;
          params.context.replace("model-setup", { search: "?firstRun=1" });
        }
      })
      .catch(() => {
        // First-run guidance is best effort. The page offers an explicit retry.
      });
  };
  const unsubscribe = params.context.gateway.subscribe(handleSnapshot);
  handleSnapshot(params.context.gateway.snapshot);
  return unsubscribe;
}
