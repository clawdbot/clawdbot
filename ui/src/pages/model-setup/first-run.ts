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
  let detection:
    | {
        connection: ModelSetupDetectionConnection;
        attempts: number;
        phase: "in-flight" | "retry-ready" | "settled";
      }
    | undefined;
  let redirected = false;
  let disposed = false;
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
    if (redirected) {
      return;
    }
    if (snapshot.phase !== "connected" || !snapshot.client) {
      // A build fence can move a previously authenticated client straight into
      // reconnecting or reload-required, while a terminal first attempt returns
      // to stopped. Do not hold the router when the shell needs to present recovery.
      if (snapshot.hello || snapshot.phase === "reload-required" || snapshot.phase === "stopped") {
        settleInitialDecision();
      }
      return;
    }
    if (
      !hasOperatorAdminAccess(snapshot.hello?.auth ?? null) ||
      isGatewayMethodAdvertised(snapshot, "openclaw.setup.detect") !== true
    ) {
      settleInitialDecision();
      return;
    }
    const agentId = params.context.agentSelection.state.selectedId;
    const connection = { client: snapshot.client, hello: snapshot.hello, agentId };
    const previous = detection;
    const sameGeneration =
      connection.client === previous?.connection.client &&
      connection.hello === previous?.connection.hello &&
      connection.agentId === previous?.connection.agentId;
    if (sameGeneration && previous?.phase !== "retry-ready") {
      return;
    }
    detection =
      sameGeneration && previous
        ? { connection, attempts: previous.attempts + 1, phase: "in-flight" }
        : { connection, attempts: 1, phase: "in-flight" };
    const attempt = detection;
    void detectModelSetup(snapshot.client, agentId ?? undefined)
      .then((result) => {
        if (disposed || detection !== attempt) {
          return;
        }
        const current = params.context.gateway.snapshot;
        if (
          current.phase !== "connected" ||
          current.client !== connection.client ||
          current.hello !== connection.hello ||
          params.context.agentSelection.state.selectedId !== connection.agentId
        ) {
          return;
        }
        detection = { ...attempt, phase: "settled" };
        cacheModelSetupDetection(connection, result);
        if (!result.setupComplete && !redirected && params.isStillDefaultLanding()) {
          redirected = true;
          params.redirect();
        }
        settleInitialDecision();
      })
      .catch(() => {
        if (disposed || detection !== attempt) {
          return;
        }
        // One same-generation retry absorbs a transient startup race without
        // turning first-run guidance into a background retry loop.
        detection = { ...attempt, phase: attempt.attempts < 2 ? "retry-ready" : "settled" };
        if (detection.phase === "retry-ready" && params.isStillDefaultLanding()) {
          handleSnapshot(params.context.gateway.snapshot);
        } else {
          settleInitialDecision();
        }
      });
  };
  const unsubscribe = params.context.gateway.subscribe(handleSnapshot);
  const unsubscribeSelection = params.context.agentSelection.subscribe(() =>
    handleSnapshot(params.context.gateway.snapshot),
  );
  handleSnapshot(params.context.gateway.snapshot);
  return () => {
    disposed = true;
    unsubscribe();
    unsubscribeSelection();
    settleInitialDecision();
  };
}
