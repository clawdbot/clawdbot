import type { ApplicationContext, ApplicationNavigationOptions } from "../../app/context.ts";
import { navigateWithRouteTransition } from "../../app/route-transition.ts";

export function navigateToStartedSession(
  context: ApplicationContext,
  options: ApplicationNavigationOptions,
): Promise<void> {
  // Keep transition code on the lazy new-session path instead of the startup bundle.
  return navigateWithRouteTransition({
    document,
    from: "new-session",
    to: "chat",
    prefersReducedMotion:
      globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
    prepare: () => context.preload("chat", options),
    navigate: () => context.navigateAndWait("chat", options),
  }).catch(() => undefined);
}
