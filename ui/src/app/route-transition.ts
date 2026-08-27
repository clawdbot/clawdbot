import type { RouteId } from "../app-routes.ts";
import { claimActiveRouteTransition, type RouteTransitionOwner } from "./route-transition-owner.ts";

type RouteTransitionOptions = {
  document: Document;
  from: RouteId | undefined;
  navigate: () => Promise<void>;
  prepare?: () => Promise<void>;
  prefersReducedMotion: boolean;
  to: RouteId;
};

export const CHAT_ROUTE_READY_EVENT = "openclaw-chat-route-ready";
const SESSION_ROUTE_ENTER_KEYFRAMES: Keyframe[] = [
  { transform: "translateY(5px) scale(0.997)" },
  { transform: "none" },
];
const SESSION_ROUTE_ENTER_OPTIONS: KeyframeAnimationOptions = {
  duration: 180,
  easing: "cubic-bezier(0.16, 1, 0.3, 1)",
};

type ActiveRouteTransition = RouteTransitionOwner & {
  animation?: Animation;
  canceled: Promise<void>;
  isCanceled: boolean;
};

function createRouteTransition(target: RouteId): ActiveRouteTransition {
  let resolveCanceled!: () => void;
  const canceled = new Promise<void>((resolve) => {
    resolveCanceled = resolve;
  });
  const transition: ActiveRouteTransition = {
    canceled,
    isCanceled: false,
    isStartingNavigation: false,
    target,
    cancel: () => {
      if (transition.isCanceled) {
        return;
      }
      transition.isCanceled = true;
      transition.animation?.cancel();
      resolveCanceled();
    },
  };
  return transition;
}

async function awaitRouteTransitionStep(
  transition: ActiveRouteTransition,
  step: Promise<unknown> | undefined,
): Promise<boolean> {
  return Promise.race([
    Promise.resolve(step).then(() => true),
    transition.canceled.then(() => false),
  ]);
}

function startRouteNavigation(
  transition: ActiveRouteTransition,
  navigate: () => Promise<void>,
): Promise<void> {
  if (transition.isCanceled) {
    return Promise.resolve();
  }
  transition.isStartingNavigation = true;
  try {
    return navigate();
  } finally {
    transition.isStartingNavigation = false;
  }
}

function waitForChatRouteReady(document: Document) {
  if (document.querySelector(".agent-chat__composer-combobox")) {
    return { cancel: () => undefined, ready: Promise.resolve() };
  }
  let resolve!: () => void;
  const ready = new Promise<void>((next) => {
    resolve = next;
  });
  const handleReady = () => resolve();
  document.addEventListener(CHAT_ROUTE_READY_EVENT, handleReady, { once: true });
  return {
    cancel: () => document.removeEventListener(CHAT_ROUTE_READY_EVENT, handleReady),
    ready,
  };
}

async function navigateAndAnimate(
  document: Document,
  transition: ActiveRouteTransition,
  navigate: () => Promise<void>,
  prefersReducedMotion: boolean,
) {
  const outlet = document.querySelector<HTMLElement & { updateComplete?: Promise<unknown> }>(
    "openclaw-router-outlet",
  );
  const chatReady = waitForChatRouteReady(document);
  try {
    if (!(await awaitRouteTransitionStep(transition, startRouteNavigation(transition, navigate)))) {
      return;
    }
    if (!(await awaitRouteTransitionStep(transition, outlet?.updateComplete))) {
      return;
    }
    if (!(await awaitRouteTransitionStep(transition, chatReady.ready))) {
      return;
    }
  } finally {
    chatReady.cancel();
  }
  if (prefersReducedMotion) {
    return;
  }
  const animation = outlet?.animate?.(SESSION_ROUTE_ENTER_KEYFRAMES, SESSION_ROUTE_ENTER_OPTIONS);
  if (transition.isCanceled) {
    animation?.cancel();
  } else {
    transition.animation = animation;
  }
  await awaitRouteTransitionStep(
    transition,
    animation?.finished.catch(() => undefined),
  );
}

export async function navigateWithRouteTransition(options: RouteTransitionOptions): Promise<void> {
  const { document, from, navigate, prepare, prefersReducedMotion, to } = options;
  if (from !== "new-session" || to !== "chat") {
    return navigate();
  }

  const transition = createRouteTransition(to);
  const release = claimActiveRouteTransition(document, transition);
  try {
    try {
      if (!(await awaitRouteTransitionStep(transition, prepare?.()))) {
        return;
      }
    } catch {
      // Preparation is an enhancement. Preserve direct navigation so its normal
      // route error handling remains authoritative when preloading fails.
      await awaitRouteTransitionStep(transition, startRouteNavigation(transition, navigate));
      return;
    }

    await navigateAndAnimate(document, transition, navigate, prefersReducedMotion);
  } finally {
    release();
  }
}
