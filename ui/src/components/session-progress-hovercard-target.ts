export const SESSION_PROGRESS_HOVER_LINK_SELECTOR = "a.markdown-session-link, [data-session-href]";
const SESSION_PROGRESS_HOVER_SIDEBAR_SELECTOR = ".sidebar-recent-session[data-session-key]";
export const SESSION_MENU_OPEN_EVENT = "openclaw-session-menu-open";
const SESSION_PROGRESS_HOVER_TARGET_SELECTOR = `${SESSION_PROGRESS_HOVER_LINK_SELECTOR}, ${SESSION_PROGRESS_HOVER_SIDEBAR_SELECTOR}`;

export function sessionProgressHoverTargetFromEvent(event: Event): HTMLElement | null {
  if (event instanceof PointerEvent && event.pointerType === "touch") {
    return null;
  }
  for (const candidate of event.composedPath()) {
    if (
      candidate instanceof HTMLElement &&
      candidate.matches(SESSION_PROGRESS_HOVER_TARGET_SELECTOR)
    ) {
      return candidate;
    }
    if (candidate === event.currentTarget) {
      break;
    }
  }
  return null;
}

export function sessionProgressHoverPlacementForTarget(
  target: HTMLElement,
): "horizontal" | "vertical" {
  return target.matches(SESSION_PROGRESS_HOVER_SIDEBAR_SELECTOR) ? "horizontal" : "vertical";
}
