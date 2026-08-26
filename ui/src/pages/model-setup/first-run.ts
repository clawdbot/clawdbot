import type { RouteLocation, RouterHistory } from "@openclaw/uirouter";
import { sessionRouteNamespaceFromPath } from "../../app-route-paths.ts";
import type { RouteId } from "../../app-routes.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { readSessionDefaults } from "../../app/gateway-store.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";

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
  redirect?: () => void;
  onInitialDecision?: () => void;
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
    params.onInitialDecision?.();
    return () => undefined;
  }
  return startModelSetupFirstRunRedirect({
    context: params.context,
    isStillDefaultLanding: () => locationsMatch(params.history.location(), initialLocation),
    redirect:
      params.redirect ?? (() => params.context.replace("model-setup", { search: "?firstRun=1" })),
    onInitialDecision: params.onInitialDecision ?? (() => undefined),
  });
}

function startModelSetupFirstRunRedirect(params: {
  context: ApplicationContext<RouteId>;
  isStillDefaultLanding: () => boolean;
  redirect: () => void;
  onInitialDecision: () => void;
}): () => void {
  let initialDecisionSettled = false;
  const settleInitialDecision = () => {
    if (!initialDecisionSettled) {
      initialDecisionSettled = true;
      params.onInitialDecision();
    }
  };
  const handleSnapshot: Parameters<ApplicationContext<RouteId>["gateway"]["subscribe"]>[0] = (
    snapshot,
  ) => {
    if (initialDecisionSettled) {
      return;
    }
    if (snapshot.phase !== "connected") {
      // A build fence can move a previously authenticated client straight into
      // reconnecting or reload-required, while a terminal first attempt returns
      // to stopped. Do not hold the router when the shell needs to present recovery.
      if (snapshot.hello || snapshot.phase === "reload-required" || snapshot.phase === "stopped") {
        settleInitialDecision();
      }
      return;
    }
    const defaults = snapshot.hello ? readSessionDefaults(snapshot.hello) : undefined;
    const selectedAgentId = params.context.agentSelection.state.selectedId?.trim() || null;
    const defaultAgentId = defaults?.defaultAgentId?.trim() || null;
    const usesDefaultAgent = selectedAgentId === null || selectedAgentId === defaultAgentId;
    if (
      hasOperatorAdminAccess(snapshot.hello?.auth ?? null) &&
      isGatewayMethodAdvertised(snapshot, "openclaw.setup.detect") === true &&
      defaults?.modelConfigured === false &&
      usesDefaultAgent &&
      params.isStillDefaultLanding()
    ) {
      params.redirect();
    }
    settleInitialDecision();
  };
  const unsubscribe = params.context.gateway.subscribe(handleSnapshot);
  handleSnapshot(params.context.gateway.snapshot);
  return () => {
    unsubscribe();
    settleInitialDecision();
  };
}
