// Control UI module implements app scroll behavior.
import type { RenderLifecycle } from "./render-lifecycle.ts";

/** Distance (px) from the bottom within which we consider the user "near bottom". */
const NEAR_BOTTOM_THRESHOLD = 450;
const LATEST_MESSAGE_THRESHOLD = 1;
const FOLLOW_REACQUIRE_THRESHOLD = 8;

type ChatScrollHost = {
  renderLifecycle: RenderLifecycle;
  querySelector: (selectors: string) => Element | null;
  chatScrollCommitCleanup: (() => void) | null;
  chatScrollFrame: number | null;
  chatScrollGuardFrame: number | null;
  chatScrollGeneration: number;
  chatLastScrollTop: number;
  chatLastScrollHeight?: number;
  chatHasAutoScrolled: boolean;
  chatUserNearBottom: boolean;
  chatFollowLocked: boolean;
  chatNewMessagesBelow: boolean;
  chatIsProgrammaticScroll: boolean;
  chatProgrammaticScrollTarget: number;
  chatScrollToEnd?: (options: { behavior?: ScrollBehavior }) => void;
};

function queryHost(host: Partial<ChatScrollHost>, selectors: string): Element | null {
  return typeof host.querySelector === "function" ? host.querySelector(selectors) : null;
}

type ChatScrollOptions = {
  contentChanged?: boolean;
  source?: "auto" | "manual" | "resize";
};

function cancelCommittedChatScroll(host: ChatScrollHost): void {
  if (host.chatScrollFrame != null) {
    cancelAnimationFrame(host.chatScrollFrame);
    host.chatScrollFrame = null;
  }
  if (host.chatScrollGuardFrame != null) {
    cancelAnimationFrame(host.chatScrollGuardFrame);
    host.chatScrollGuardFrame = null;
  }
  host.chatIsProgrammaticScroll = false;
}

export function cancelChatScroll(host: ChatScrollHost): void {
  host.chatScrollGeneration += 1;
  host.chatScrollCommitCleanup?.();
  host.chatScrollCommitCleanup = null;
  cancelCommittedChatScroll(host);
}

function setNewMessagesBelow(host: ChatScrollHost, next: boolean): void {
  if (host.chatNewMessagesBelow === next) {
    return;
  }
  host.chatNewMessagesBelow = next;
  // Scroll effects run after the render that caused them. Publish the semantic
  // state transition so the indicator cannot wait for an unrelated update.
  host.renderLifecycle.invalidate();
}

function scheduleProgrammaticScrollGuardClear(
  host: ChatScrollHost,
  generation: number,
  target: HTMLElement,
  waitForTarget: boolean,
): void {
  if (host.chatScrollGuardFrame != null) {
    cancelAnimationFrame(host.chatScrollGuardFrame);
  }
  const check = () => {
    host.chatScrollGuardFrame = null;
    if (generation !== host.chatScrollGeneration) {
      return;
    }
    const distanceFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
    if (waitForTarget && distanceFromBottom > LATEST_MESSAGE_THRESHOLD) {
      host.chatScrollGuardFrame = requestAnimationFrame(check);
      return;
    }
    host.chatIsProgrammaticScroll = false;
  };
  host.chatScrollGuardFrame = requestAnimationFrame(check);
}

function pickScrollTarget(host: ChatScrollHost): HTMLElement | null {
  return queryHost(host, ".chat-thread") as HTMLElement | null;
}

/** Schedule layout work when the caller already runs after the DOM commit. */
export function scheduleCommittedChatScroll(
  host: ChatScrollHost,
  force = false,
  smooth = false,
  options: ChatScrollOptions = {},
): void {
  cancelCommittedChatScroll(host);
  const generation = host.chatScrollGeneration;
  host.chatScrollFrame = requestAnimationFrame(() => {
    host.chatScrollFrame = null;
    if (generation !== host.chatScrollGeneration) {
      return;
    }
    const target = pickScrollTarget(host);
    if (!target) {
      return;
    }
    const distanceFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
    const contentGrew = target.scrollHeight > (host.chatLastScrollHeight ?? 0) + 1;
    host.chatLastScrollHeight = target.scrollHeight;
    const contentChanged = options.contentChanged ?? options.source !== "resize";
    const manualScroll = options.source === "manual";

    // force=true only overrides when we haven't auto-scrolled yet (initial load).
    // After initial load, respect the user's scroll position.
    const effectiveForce = force && !host.chatHasAutoScrolled;
    const shouldStick =
      manualScroll ||
      effectiveForce ||
      (!host.chatFollowLocked &&
        (host.chatUserNearBottom || distanceFromBottom < NEAR_BOTTOM_THRESHOLD));

    if (!shouldStick) {
      if (contentChanged || (options.source === "resize" && contentGrew)) {
        setNewMessagesBelow(host, true);
      }
      return;
    }
    if (effectiveForce) {
      host.chatHasAutoScrolled = true;
    }
    host.chatFollowLocked = false;
    const smoothEnabled =
      smooth &&
      (typeof window === "undefined" ||
        typeof window.matchMedia !== "function" ||
        !window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    const scrollTop = target.scrollHeight;
    host.chatProgrammaticScrollTarget = scrollTop;
    host.chatIsProgrammaticScroll = true;
    if (host.chatScrollToEnd) {
      host.chatScrollToEnd({ behavior: smoothEnabled ? "smooth" : "auto" });
    } else if (typeof target.scrollTo === "function") {
      target.scrollTo({ top: scrollTop, behavior: smoothEnabled ? "smooth" : "auto" });
    } else {
      target.scrollTop = scrollTop;
    }
    scheduleProgrammaticScrollGuardClear(
      host,
      generation,
      target,
      smoothEnabled || Boolean(host.chatScrollToEnd),
    );
    host.chatUserNearBottom = true;
    setNewMessagesBelow(host, false);
  });
}

export function scheduleChatScroll(
  host: ChatScrollHost,
  force = false,
  smooth = false,
  options: ChatScrollOptions = {},
): void {
  cancelChatScroll(host);
  const generation = host.chatScrollGeneration;
  let committed = false;
  const cancelCommit = host.renderLifecycle.afterCommit(() => {
    committed = true;
    if (generation !== host.chatScrollGeneration) {
      return;
    }
    host.chatScrollCommitCleanup = null;
    scheduleCommittedChatScroll(host, force, smooth, options);
  });
  if (!committed) {
    host.chatScrollCommitCleanup = cancelCommit;
  }
}

export function handleChatScroll(host: ChatScrollHost, event: Event): void {
  const container = event.currentTarget as HTMLElement | null;
  if (!container) {
    return;
  }
  const scrollTop = Math.max(0, container.scrollTop);
  const delta = scrollTop - host.chatLastScrollTop;
  host.chatLastScrollTop = scrollTop;
  host.chatLastScrollHeight = container.scrollHeight;
  // Ignore downward scroll events that we triggered, including intermediate
  // smooth-scroll frames. A real user scroll-up must still pass through so
  // streaming stops pinning them back to the bottom.
  const isUserScrollUp = delta < 0;
  if (host.chatIsProgrammaticScroll) {
    if (!isUserScrollUp) {
      return;
    }
    if (host.chatScrollGuardFrame != null) {
      cancelAnimationFrame(host.chatScrollGuardFrame);
      host.chatScrollGuardFrame = null;
    }
    host.chatIsProgrammaticScroll = false;
  }
  const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
  if (isUserScrollUp && distanceFromBottom > FOLLOW_REACQUIRE_THRESHOLD) {
    host.chatFollowLocked = true;
  } else if (distanceFromBottom <= FOLLOW_REACQUIRE_THRESHOLD) {
    host.chatFollowLocked = false;
  }
  host.chatUserNearBottom = !host.chatFollowLocked && distanceFromBottom < NEAR_BOTTOM_THRESHOLD;

  setNewMessagesBelow(
    host,
    container.scrollHeight - container.clientHeight > LATEST_MESSAGE_THRESHOLD &&
      distanceFromBottom > LATEST_MESSAGE_THRESHOLD,
  );
}

export function resetChatScroll(host: ChatScrollHost): void {
  cancelChatScroll(host);
  host.chatHasAutoScrolled = false;
  host.chatUserNearBottom = true;
  host.chatFollowLocked = false;
  host.chatLastScrollTop = 0;
  host.chatLastScrollHeight = 0;
  host.chatNewMessagesBelow = false;
  host.chatIsProgrammaticScroll = false;
  host.chatProgrammaticScrollTarget = 0;
}
