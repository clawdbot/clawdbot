import type { RouteLocation } from "@openclaw/uirouter";
import type { RouteId } from "../../app-routes.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { cacheModelSetupDetection } from "./detect-cache.ts";
import { detectModelSetup } from "./rpc.ts";

export function isDefaultChatLanding(
  location: RouteLocation,
  basePath: string,
  routeIdFromPath: (pathname: string, basePath: string) => string | null,
): boolean {
  const routeId = routeIdFromPath(location.pathname, basePath);
  if (routeId !== null && routeId !== "chat") {
    return false;
  }
  const searchSession = new URLSearchParams(location.search).get("session")?.trim();
  const hash = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
  const hashSession = new URLSearchParams(hash).get("session")?.trim();
  return !searchSession && !hashSession;
}

export function locationsMatch(
  left: RouteLocation,
  right: RouteLocation,
  sessionKeysMatch: (left: string, right: string) => boolean = (candidateLeft, candidateRight) =>
    candidateLeft === candidateRight,
): boolean {
  if (left.pathname !== right.pathname || left.hash !== right.hash) {
    return false;
  }
  if (left.search === right.search) {
    return true;
  }
  const leftSearch = new URLSearchParams(left.search);
  const rightSearch = new URLSearchParams(right.search);
  const leftSession = leftSearch.get("session")?.trim();
  const rightSession = rightSearch.get("session")?.trim();
  leftSearch.delete("session");
  rightSearch.delete("session");
  return (
    leftSearch.toString() === rightSearch.toString() &&
    Boolean(leftSession && rightSession && sessionKeysMatch(leftSession, rightSession))
  );
}

export function startModelSetupFirstRunRedirect(params: {
  context: ApplicationContext<RouteId>;
  isStillDefaultLanding: () => boolean;
}): () => void {
  let attempted = false;
  let redirected = false;
  return params.context.gateway.subscribe((snapshot) => {
    if (
      attempted ||
      redirected ||
      !snapshot.connected ||
      !snapshot.client ||
      !hasOperatorAdminAccess(snapshot.hello?.auth ?? null) ||
      isGatewayMethodAdvertised(snapshot, "openclaw.setup.detect") !== true
    ) {
      return;
    }
    attempted = true;
    const client = snapshot.client;
    void detectModelSetup(client)
      .then((result) => {
        cacheModelSetupDetection(client, result);
        if (!result.setupComplete && !redirected && params.isStillDefaultLanding()) {
          redirected = true;
          params.context.replace("model-setup", { search: "?firstRun=1" });
        }
      })
      .catch(() => {
        // First-run guidance is best effort. The page offers an explicit retry.
      });
  });
}
