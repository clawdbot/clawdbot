import type { RouteId } from "../app-routes.ts";

export type RouteTransitionOwner = {
  cancel: () => void;
  isStartingNavigation: boolean;
  target: RouteId;
};

const activeRouteTransitions = new WeakMap<Document, RouteTransitionOwner>();

export function claimActiveRouteTransition(
  document: Document,
  transition: RouteTransitionOwner,
): () => void {
  activeRouteTransitions.get(document)?.cancel();
  document.defaultView?.addEventListener("popstate", transition.cancel);
  activeRouteTransitions.set(document, transition);
  return () => {
    document.defaultView?.removeEventListener("popstate", transition.cancel);
    if (activeRouteTransitions.get(document) === transition) {
      activeRouteTransitions.delete(document);
    }
  };
}

export function cancelActiveRouteTransition(
  document: Document,
  navigation?: { routeId: RouteId; mode: "push" | "replace" },
): void {
  const transition = activeRouteTransitions.get(document);
  // The transition's own same-target context.navigateAndWait call passes through
  // this owner. Later same-target replacements only remove canonical route hints;
  // another target or an unscoped shutdown is a new owner and must cancel.
  if (
    transition &&
    navigation?.routeId === transition.target &&
    (transition.isStartingNavigation || navigation.mode === "replace")
  ) {
    return;
  }
  transition?.cancel();
}
