import type { RouteLocation } from "@openclaw/uirouter";
import { locationWithoutDraft } from "./route-draft.ts";

function currentRouteLocation(): RouteLocation {
  return {
    pathname: window.location.pathname,
    search: window.location.search,
    hash: window.location.hash,
  };
}

function routeLocationsMatch(left: RouteLocation, right: RouteLocation): boolean {
  return (
    left.pathname === right.pathname && left.search === right.search && left.hash === right.hash
  );
}

export function stillOwnsCanonicalLocation(
  source: RouteLocation | undefined,
  consumedSourceDraft: boolean,
): boolean {
  if (!source) {
    return false;
  }
  const current = currentRouteLocation();
  if (routeLocationsMatch(current, source)) {
    return true;
  }
  const sourceHasDraft = new URLSearchParams(source.search).has("draft");
  const currentHasDraft = new URLSearchParams(current.search).has("draft");
  // Only the source route's own one-shot draft may disappear without
  // transferring canonicalization ownership to a newer navigation.
  return (
    consumedSourceDraft &&
    sourceHasDraft &&
    !currentHasDraft &&
    routeLocationsMatch(locationWithoutDraft(current), locationWithoutDraft(source))
  );
}
