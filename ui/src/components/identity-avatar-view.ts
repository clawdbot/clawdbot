import { html, nothing } from "lit";
import { guard } from "lit/directives/guard.js";
import { live } from "lit/directives/live.js";
import { until } from "lit/directives/until.js";
import {
  resolveAvatar,
  resolveAvatarImageUrl,
  resolveAvatarInitials,
  settleAvatarImageUrl,
  type IdentityAvatarInput,
  type ResolvedIdentityAvatar,
} from "../lib/identity-avatar.ts";

type IdentityAvatarFallback = Extract<ResolvedIdentityAvatar, { kind: "initials" }>;

export type IdentityAvatarView = {
  fallback: IdentityAvatarFallback;
  imageUrl: string | Promise<string | null> | null;
  pending: boolean;
};

/** Resolve one user identity consistently across the roster, profile, and chat. */
export function resolveIdentityAvatarView(identity: IdentityAvatarInput): IdentityAvatarView {
  const avatar = resolveAvatar(identity);
  const fallback = avatar.kind === "initials" ? avatar : resolveAvatarInitials(identity);
  const imageUrl = avatar.kind === "profile" ? resolveAvatarImageUrl(avatar.url) : null;
  return {
    fallback,
    imageUrl,
    pending: imageUrl !== null && typeof imageUrl !== "string",
  };
}

/** Reconcile changed images without overwriting event fallback on unchanged rerenders. */
export function identityAvatarClass(className: string, view: IdentityAvatarView) {
  return guard([className, view.imageUrl, view.pending], () =>
    live(`${className}${view.pending ? " is-fallback" : ""}`),
  );
}

function settleIdentityAvatarImage(event: Event, fallbackSelector: string, failed: boolean): void {
  const image = event.currentTarget;
  if (!(image instanceof HTMLImageElement)) {
    return;
  }
  // All user-avatar surfaces share blob settlement and fallback transitions;
  // revoking a pending image or retaining a previous error breaks reused DOM.
  settleAvatarImageUrl(image.getAttribute("src"));
  image.closest<HTMLElement>(fallbackSelector)?.classList.toggle("is-fallback", failed);
}

/** Render the shared authenticated user image with its canonical event lifecycle. */
export function renderIdentityAvatarImage({
  view,
  fallbackSelector,
  className,
  alt = "",
  ariaHidden = false,
}: {
  view: IdentityAvatarView;
  fallbackSelector: string;
  className?: string;
  alt?: string;
  ariaHidden?: boolean;
}) {
  if (!view.imageUrl) {
    return nothing;
  }
  return html`<img
    class=${className ?? nothing}
    src=${typeof view.imageUrl === "string"
      ? view.imageUrl
      : until(
          view.imageUrl.then((url) => url ?? nothing),
          nothing,
        )}
    alt=${alt}
    aria-hidden=${ariaHidden ? "true" : nothing}
    referrerpolicy="no-referrer"
    @error=${(event: Event) => settleIdentityAvatarImage(event, fallbackSelector, true)}
    @load=${(event: Event) => settleIdentityAvatarImage(event, fallbackSelector, false)}
  />`;
}
