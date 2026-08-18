export const SESSION_HOVERCARD_OPEN_DELAY_MS = 250;

export function sessionLinkAnchorFromEvent(event: Event): HTMLAnchorElement | null {
  for (const candidate of event.composedPath()) {
    if (candidate instanceof HTMLAnchorElement) {
      return candidate;
    }
    if (candidate === event.currentTarget) {
      break;
    }
  }
  return null;
}

export function isPotentialSessionLink(anchor: HTMLAnchorElement, basePath = ""): boolean {
  if (anchor.matches("a.markdown-session-link[data-session-key]")) {
    return true;
  }
  try {
    const url = new URL(anchor.href, globalThis.location?.href ?? "http://localhost/");
    const normalizedBasePath = basePath.replace(/\/+$/u, "");
    return (
      url.origin === globalThis.location?.origin &&
      ["chat", "dashboard"].some((namespace) =>
        url.pathname.startsWith(`${normalizedBasePath}/${namespace}/`),
      )
    );
  } catch {
    return false;
  }
}
