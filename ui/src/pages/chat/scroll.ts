import { resolveScrollBehavior } from "../../lib/scroll-behavior.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import type { RenderLifecycle } from "./render-lifecycle.ts";
import { getSessionCacheValue, setSessionCacheValue } from "./session-cache.ts";

/** Distance (px) from the bottom within which we consider the user "near bottom". */
const NEAR_BOTTOM_THRESHOLD = 450;
/** Shared semantic boundary for treating the transcript as settled at its end. */
export const CHAT_TRANSCRIPT_END_THRESHOLD_PX = 8;
// Route navigation may replace a pane element while retaining its logical id.
// Bound both dimensions so those short-lived owners cannot leak scroll state.
const MAX_CACHED_TRANSCRIPT_SCROLL_PANES = 8;
export type ChatSessionScrollPosition = {
  scrollTop: number;
  anchorToEnd: boolean;
};

const transcriptScrollTopByPane = new Map<string, Map<string, ChatSessionScrollPosition>>();

function getPaneScrollTops(paneId: string): Map<string, ChatSessionScrollPosition> {
  const existing = transcriptScrollTopByPane.get(paneId);
  if (existing) {
    transcriptScrollTopByPane.delete(paneId);
    transcriptScrollTopByPane.set(paneId, existing);
    return existing;
  }
  const created = new Map<string, ChatSessionScrollPosition>();
  transcriptScrollTopByPane.set(paneId, created);
  while (transcriptScrollTopByPane.size > MAX_CACHED_TRANSCRIPT_SCROLL_PANES) {
    const oldest = transcriptScrollTopByPane.keys().next().value;
    if (typeof oldest !== "string") {
      break;
    }
    transcriptScrollTopByPane.delete(oldest);
  }
  return created;
}

export function getChatSessionScrollPosition(
  paneId: string,
  sessionKey: string,
): ChatSessionScrollPosition | undefined {
  const scrollTops = getPaneScrollTops(paneId);
  const exact = getSessionCacheValue(scrollTops, sessionKey);
  if (exact !== undefined) {
    return exact;
  }
  for (const [cachedKey, position] of scrollTops) {
    if (!areUiSessionKeysEquivalent(cachedKey, sessionKey)) {
      continue;
    }
    scrollTops.delete(cachedKey);
    setSessionCacheValue(scrollTops, sessionKey, position);
    return position;
  }
  return undefined;
}

export function saveChatSessionScrollPosition(
  paneId: string,
  sessionKey: string,
  position: ChatSessionScrollPosition,
): void {
  const scrollTops = getPaneScrollTops(paneId);
  for (const cachedKey of scrollTops.keys()) {
    if (areUiSessionKeysEquivalent(cachedKey, sessionKey)) {
      scrollTops.delete(cachedKey);
    }
  }
  setSessionCacheValue(scrollTops, sessionKey, {
    scrollTop: Math.max(0, position.scrollTop),
    anchorToEnd: position.anchorToEnd,
  });
}

export function captureChatSessionScrollPosition(target: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}): ChatSessionScrollPosition {
  const maxScrollTop = Math.max(0, target.scrollHeight - target.clientHeight);
  const scrollTop = Math.min(Math.max(0, target.scrollTop), maxScrollTop);
  return {
    scrollTop,
    anchorToEnd: maxScrollTop - scrollTop <= CHAT_TRANSCRIPT_END_THRESHOLD_PX,
  };
}

export type ChatScrollHost = {
  renderLifecycle: RenderLifecycle;
  chatLastScrollTop: number;
  chatLastScrollHeight?: number;
  chatHasAutoScrolled: boolean;
  chatUserNearBottom: boolean;
  chatFollowLocked: boolean;
  chatNewMessagesBelow: boolean;
  chatIsProgrammaticScroll?: () => boolean;
  chatScrollElement?: () => HTMLElement | null;
  chatScrollToEnd?: (options: ChatScrollToEndOptions) => boolean;
};

export type ChatScrollToEndOptions = {
  behavior?: ScrollBehavior;
  source?: "auto" | "manual";
};

type ChatScrollOptions = {
  contentChanged?: boolean;
  source?: "auto" | "manual" | "resize";
};

type PendingChatScroll = { manual: boolean; cancel: () => void };
const pendingChatScrolls = new WeakMap<ChatScrollHost, PendingChatScroll>();

export function cancelChatScroll(host: ChatScrollHost): void {
  pendingChatScrolls.get(host)?.cancel();
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

function applyChatScroll(
  host: ChatScrollHost,
  force: boolean,
  smooth: boolean,
  options: ChatScrollOptions,
): void {
  const target = host.chatScrollElement?.();
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
      (options.source === "resize" ||
        host.chatUserNearBottom ||
        distanceFromBottom < NEAR_BOTTOM_THRESHOLD));

  if (!shouldStick) {
    if (contentChanged || (options.source === "resize" && contentGrew)) {
      setNewMessagesBelow(host, true);
    }
    return;
  }
  const behavior = resolveScrollBehavior(smooth ? "smooth" : "auto");
  // Restoration owns the viewport until it settles or an explicit command
  // replaces it. Automatic follow must not change policy when it is declined.
  if (
    !host.chatScrollToEnd?.({
      behavior,
      source: manualScroll ? "manual" : "auto",
    })
  ) {
    return;
  }
  if (effectiveForce) {
    host.chatHasAutoScrolled = true;
  }
  host.chatFollowLocked = false;
  host.chatUserNearBottom = true;
  setNewMessagesBelow(host, false);
}

function queueChatScroll(
  host: ChatScrollHost,
  force: boolean,
  smooth: boolean,
  options: ChatScrollOptions,
  committed: boolean,
): void {
  // A send/latest command keeps its place through incidental render and resize
  // requests. Reader takeover and lifecycle cancellation retire the whole request.
  if (options.source !== "manual" && pendingChatScrolls.get(host)?.manual) {
    return;
  }
  cancelChatScroll(host);
  let frame: number | null = null;
  let cancelCommit: (() => void) | undefined;
  const request: PendingChatScroll = {
    manual: options.source === "manual",
    cancel: () => {
      if (pendingChatScrolls.get(host) !== request) {
        return;
      }
      pendingChatScrolls.delete(host);
      cancelCommit?.();
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
    },
  };
  pendingChatScrolls.set(host, request);
  const enqueue = (complete?: () => void) => {
    frame = requestAnimationFrame(() => {
      if (pendingChatScrolls.get(host) !== request) {
        return;
      }
      pendingChatScrolls.delete(host);
      complete?.();
      applyChatScroll(host, force, smooth, options);
    });
    return request.cancel;
  };
  if (committed) {
    enqueue();
  } else {
    cancelCommit = host.renderLifecycle.afterCommit(enqueue, request.cancel);
  }
}

/** Schedule layout work when the caller already runs after the DOM commit. */
export function scheduleCommittedChatScroll(
  host: ChatScrollHost,
  force = false,
  smooth = false,
  options: ChatScrollOptions = {},
): void {
  queueChatScroll(host, force, smooth, options, true);
}

export function scheduleChatScroll(
  host: ChatScrollHost,
  force = false,
  smooth = false,
  options: ChatScrollOptions = {},
): void {
  queueChatScroll(host, force, smooth, options, false);
}

export function handleChatScroll(host: ChatScrollHost, event: Event): void {
  const container = event.currentTarget as HTMLElement | null;
  if (!container) {
    return;
  }
  updateChatScrollPosition(host, container);
}

export function handleChatScrollTakeover(host: ChatScrollHost): void {
  cancelChatScroll(host);
  const container = host.chatScrollElement?.();
  if (container) {
    // Intent can stop a smooth scroll without moving a pixel. Retire queued
    // follow work and publish reader policy even without a native scroll event.
    updateChatScrollPosition(host, container, true);
  }
}

function updateChatScrollPosition(
  host: ChatScrollHost,
  container: HTMLElement,
  takeover = false,
): void {
  const scrollTop = Math.max(0, container.scrollTop);
  const delta = scrollTop - host.chatLastScrollTop;
  host.chatLastScrollTop = scrollTop;
  host.chatLastScrollHeight = container.scrollHeight;
  // Ignore downward scroll events that we triggered, including intermediate
  // smooth-scroll frames. A real user scroll-up must still pass through so
  // streaming stops pinning them back to the bottom.
  const isUserScrollUp = takeover || delta < 0;
  if (host.chatIsProgrammaticScroll?.() && !isUserScrollUp) {
    return;
  }
  const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
  if (isUserScrollUp && distanceFromBottom > CHAT_TRANSCRIPT_END_THRESHOLD_PX) {
    // Taking control before initial history settles must retire its queued
    // force-scroll. Otherwise that delayed commit can overwrite the viewport.
    host.chatHasAutoScrolled = true;
    host.chatFollowLocked = true;
  } else if (distanceFromBottom <= CHAT_TRANSCRIPT_END_THRESHOLD_PX) {
    host.chatFollowLocked = false;
  }
  host.chatUserNearBottom = !host.chatFollowLocked && distanceFromBottom < NEAR_BOTTOM_THRESHOLD;

  setNewMessagesBelow(
    host,
    container.scrollHeight - container.clientHeight > CHAT_TRANSCRIPT_END_THRESHOLD_PX &&
      distanceFromBottom > CHAT_TRANSCRIPT_END_THRESHOLD_PX,
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
}
