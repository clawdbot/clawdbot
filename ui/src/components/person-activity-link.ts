import { html } from "lit";
import { activityPersonLocation } from "../app-route-paths.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";

/**
 * Routing an identity surface needs to open one person's Activity feed. Hosts pass it
 * explicitly because some surfaces (the portaled session hovercard) render outside the
 * application context tree and cannot consume it.
 */
export type PersonActivityRouting = {
  basePath: string;
  navigate: (personId: string) => void;
};

type PersonActivityLink = { href: string; open: (event: MouseEvent) => void };

/** Structural view of the application context, so identity chrome stays out of app/ imports. */
type PersonActivityNavigator = {
  readonly basePath: string;
  navigate: (routeId: "activity", options: { pathname: string; search: string }) => void;
};

/** `beforeNavigate` lets transient hosts (hovercards, popovers) dismiss themselves first. */
export function personActivityRouting(
  context: PersonActivityNavigator,
  beforeNavigate?: () => void,
): PersonActivityRouting {
  return {
    basePath: context.basePath,
    navigate: (personId: string) => {
      beforeNavigate?.();
      context.navigate("activity", activityPersonLocation(personId, context.basePath));
    },
  };
}

/** Null when the host supplied no routing, or the actor carries no usable person id. */
export function personActivityLink(
  personId: string | null | undefined,
  routing: PersonActivityRouting | undefined,
): PersonActivityLink | null {
  const id = personId?.trim();
  if (!id || !routing) {
    return null;
  }
  return {
    href: activityPersonLocation(id, routing.basePath).href,
    open: (event: MouseEvent) => {
      if (!shouldHandleNavigationClick(event)) {
        return;
      }
      event.preventDefault();
      routing.navigate(id);
    },
  };
}

/** The person's name as the accessible link target; plain text when there is nowhere to go. */
export function renderPersonName(
  label: string,
  link: PersonActivityLink | null,
  className: string,
) {
  return link
    ? html`<a class="${className} person-activity-link" href=${link.href} @click=${link.open}
        >${label}</a
      >`
    : html`<span class=${className}>${label}</span>`;
}

/**
 * Wraps an avatar that already sits beside its own labelled name link. The twin is hidden
 * from assistive tech and the tab order so one identity never yields two targets; see the
 * focusable filter in session-progress-hovercard.runtime.ts.
 */
export function renderPersonAvatarLink(avatar: unknown, link: PersonActivityLink | null) {
  return link
    ? html`<a
        class="person-activity-avatar-link"
        href=${link.href}
        tabindex="-1"
        aria-hidden="true"
        @click=${link.open}
        >${avatar}</a
      >`
    : avatar;
}

/**
 * Wraps an avatar that stands alone (facepiles, the header owner chip). The avatar keeps its
 * own aria-label, which becomes the link's accessible name, so it stays a real tab stop.
 */
export function renderStandalonePersonLink(avatar: unknown, link: PersonActivityLink | null) {
  return link
    ? html`<a class="person-activity-avatar-link" href=${link.href} @click=${link.open}
        >${avatar}</a
      >`
    : avatar;
}
