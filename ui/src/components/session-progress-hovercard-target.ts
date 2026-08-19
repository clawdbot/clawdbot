export const SESSION_PROGRESS_HOVER_LINK_SELECTOR = "a.markdown-session-link[data-session-key]";

export function sessionProgressHoverAnchorFromEvent(event: Event): HTMLAnchorElement | null {
  for (const candidate of event.composedPath()) {
    if (
      candidate instanceof HTMLAnchorElement &&
      candidate.matches(SESSION_PROGRESS_HOVER_LINK_SELECTOR)
    ) {
      return candidate;
    }
    if (candidate === event.currentTarget) {
      break;
    }
  }
  return null;
}
