import type { RouteId } from "../app-routes.ts";

type RouteTransitionOptions = {
  document: Document;
  from: RouteId | undefined;
  navigate: () => Promise<void>;
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
  navigate: () => Promise<void>,
  prefersReducedMotion: boolean,
) {
  const outlet = document.querySelector<HTMLElement & { updateComplete?: Promise<unknown> }>(
    "openclaw-router-outlet",
  );
  const chatReady = waitForChatRouteReady(document);
  try {
    await navigate();
    await outlet?.updateComplete;
    await chatReady.ready;
  } finally {
    chatReady.cancel();
  }
  if (prefersReducedMotion) {
    return;
  }
  const animation = outlet?.animate?.(SESSION_ROUTE_ENTER_KEYFRAMES, SESSION_ROUTE_ENTER_OPTIONS);
  await animation?.finished.catch(() => undefined);
}

export async function navigateWithRouteTransition(options: RouteTransitionOptions): Promise<void> {
  const { document, from, navigate, prefersReducedMotion, to } = options;
  if (from !== "new-session" || to !== "chat") {
    return navigate();
  }

  // Navigation commits the URL while the outlet keeps the submitted prompt live.
  // Only the entrance animation waits for the rendered chat composer.
  return navigateAndAnimate(document, navigate, prefersReducedMotion);
}
