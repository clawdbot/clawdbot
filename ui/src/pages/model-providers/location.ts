import type { RouteLocation } from "@openclaw/uirouter";
import { pathForRoute } from "../../app-route-paths.ts";

type ModelsView = "manage" | "connect";

export type ModelsRouteState = {
  view: ModelsView;
  firstRun: boolean;
};

export type ModelsLocationIntent = { view: "manage" } | { view: "connect"; firstRun?: boolean };

export function readModelsRouteState(location: Pick<RouteLocation, "search">): ModelsRouteState {
  const search = new URLSearchParams(location.search);
  const firstRun = search.get("firstRun") === "1";
  return {
    view: search.get("view") === "connect" || firstRun ? "connect" : "manage",
    firstRun,
  };
}

export function modelsNavigationOptions(
  intent: ModelsLocationIntent,
  current?: Pick<RouteLocation, "search" | "hash">,
): Pick<RouteLocation, "search" | "hash"> {
  const search = new URLSearchParams(current?.search ?? "");
  if (intent.view === "connect") {
    search.set("view", "connect");
    if (intent.firstRun) {
      search.set("firstRun", "1");
    } else {
      search.delete("firstRun");
    }
  } else {
    search.delete("view");
    search.delete("firstRun");
  }
  const query = search.toString();
  return { search: query ? `?${query}` : "", hash: current?.hash ?? "" };
}

export const MODELS_CONNECT_NAVIGATION = modelsNavigationOptions({ view: "connect" });
export const MODELS_FIRST_RUN_NAVIGATION = modelsNavigationOptions({
  view: "connect",
  firstRun: true,
});

export function modelsLocation(
  basePath: string,
  intent: ModelsLocationIntent,
  current?: Pick<RouteLocation, "search" | "hash">,
): RouteLocation {
  return {
    pathname: pathForRoute("model-providers", basePath),
    ...modelsNavigationOptions(intent, current),
  };
}
