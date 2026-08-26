import type { RouteLocation, RouterHistory } from "@openclaw/uirouter";
import { sessionRouteNamespaceFromPath } from "../../app-route-paths.ts";
import { sameRouteLocation, type RouteId } from "../../app-routes.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { readSessionDefaults } from "../../app/gateway-store.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";

export function isDefaultChatLanding(
  location: RouteLocation,
  basePath: string,
  routeIdFromPath: (pathname: string, basePath: string) => string | null,
): boolean {
  if (
    new URLSearchParams(location.search).has("session") ||
    new URLSearchParams(location.hash.slice(1)).has("session")
  ) {
    return false;
  }
  const routeId = routeIdFromPath(location.pathname, basePath);
  return (
    (routeId === null || routeId === "chat") &&
    sessionRouteNamespaceFromPath(location.pathname, basePath) === null
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
    !sameRouteLocation(params.history.location(), initialLocation) &&
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
    isStillDefaultLanding: () => sameRouteLocation(params.history.location(), initialLocation),
    redirect:
      params.redirect ?? (() => params.context.replace("model-setup", { search: "?firstRun=1" })),
    onInitialDecision: params.onInitialDecision,
  });
}

function startModelSetupFirstRunRedirect(params: {
  context: ApplicationContext<RouteId>;
  isStillDefaultLanding: () => boolean;
  redirect: () => void;
  onInitialDecision?: () => void;
}): () => void {
  let initialDecisionSettled = false;
  const settleInitialDecision = () => {
    if (!initialDecisionSettled) {
      initialDecisionSettled = true;
      params.onInitialDecision?.();
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
    if (
      hasOperatorAdminAccess(snapshot.hello?.auth ?? null) &&
      isGatewayMethodAdvertised(snapshot, "openclaw.setup.detect") === true &&
      (!selectedAgentId || selectedAgentId === defaults?.defaultAgentId?.trim()) &&
      params.isStillDefaultLanding()
    ) {
      if (defaults?.modelConfigured === false) {
        params.redirect();
      } else if (defaults?.modelConfigured) {
        try {
          if (localStorage.getItem("openclaw.modelSetup.pendingActivation.v1")) {
            const ownerRevision = params.context.gateway.connectionRevision;
            // Crypto stays lazy; only an existing receipt suspends startup.
            void import("./model-setup-page.ts")
              .then(({ resumeFirstRunActivation }) =>
                resumeFirstRunActivation(
                  params,
                  snapshot,
                  ownerRevision,
                  selectedAgentId,
                  () => initialDecisionSettled,
                  settleInitialDecision,
                ),
              )
              .catch(settleInitialDecision);
            return;
          }
        } catch {
          // Blocked browser storage cannot own durable activation recovery.
        }
      }
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
