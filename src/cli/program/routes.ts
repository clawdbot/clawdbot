import { routedCommands, type RouteSpec } from "./route-specs.js";

export type { RouteSpec } from "./route-specs.js";

export function findRoutedCommand(path: string[]): RouteSpec | null {
  for (const route of routedCommands) {
    if (route.matches(path)) {
      return route;
    }
  }
  return null;
}
