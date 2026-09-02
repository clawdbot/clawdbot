// Routed command lookup for fast paths that bypass full Commander registration.
import { routedCommands, type RouteSpec } from "./route-specs.js";

/** Routed command contract re-exported for callers that only need route lookup. */

/** Find the first route matching a command path and parseable argv. */
export function findRoutedCommand(path: string[], argv?: string[]): RouteSpec | null {
  for (const route of routedCommands) {
    if (route.matches(path)) {
      if (argv && route.canRun && !route.canRun(argv)) {
        continue;
      }
      return route;
    }
  }
  return null;
}
