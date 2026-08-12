import type { RouteId } from "../app-routes.ts";

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void | Promise<void>) => {
    finished: Promise<void>;
  };
};

type RouteTransitionOptions = {
  document: ViewTransitionDocument;
  from: RouteId | undefined;
  navigate: () => Promise<void>;
  prepare?: () => Promise<void>;
  prefersReducedMotion: boolean;
  to: RouteId;
};

const SESSION_ROUTE_TRANSITION_CLASS = "session-route-transition";

async function navigateAndRender(document: ViewTransitionDocument, navigate: () => Promise<void>) {
  await navigate();
  const outlet = document.querySelector<HTMLElement & { updateComplete?: Promise<unknown> }>(
    "openclaw-router-outlet",
  );
  await outlet?.updateComplete;
}

export async function navigateWithRouteTransition(options: RouteTransitionOptions): Promise<void> {
  const { document, from, navigate, prepare, prefersReducedMotion, to } = options;
  if (
    from !== "new-session" ||
    to !== "chat" ||
    prefersReducedMotion ||
    typeof document.startViewTransition !== "function"
  ) {
    return navigate();
  }

  try {
    await prepare?.();
  } catch {
    // Preparation is an enhancement. Preserve direct navigation so its normal
    // route error handling remains authoritative when preloading fails.
    return navigate();
  }

  document.documentElement.classList.add(SESSION_ROUTE_TRANSITION_CLASS);
  let navigation: Promise<void> | undefined;
  try {
    const transition = document.startViewTransition(
      () => (navigation ??= navigateAndRender(document, navigate)),
    );
    return transition.finished.finally(() => {
      document.documentElement.classList.remove(SESSION_ROUTE_TRANSITION_CLASS);
    });
  } catch {
    document.documentElement.classList.remove(SESSION_ROUTE_TRANSITION_CLASS);
    return navigation ?? navigate();
  }
}
