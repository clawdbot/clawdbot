import { html, nothing, type TemplateResult } from "lit";
import {
  identityAvatarClass,
  renderIdentityAvatarImage,
  resolveIdentityAvatarView,
  type IdentityAvatarView,
} from "../../../components/identity-avatar-view.ts";
import { formatSenderLabel } from "../../../lib/chat/sender-label.ts";
import type { IdentityAvatarInput, ResolvedIdentityAvatar } from "../../../lib/identity-avatar.ts";

function renderInitialsAvatar(
  avatar: Extract<ResolvedIdentityAvatar, { kind: "initials" }>,
  fallback = false,
) {
  const hue = avatar.colorSeed % 360;
  return html`
    <span
      class="chat-author-avatar__initials ${fallback ? "chat-author-avatar__fallback" : ""}"
      style=${`--chat-author-avatar-hue: ${hue}`}
      aria-hidden="true"
    >
      ${avatar.initials}
    </span>
  `;
}

function renderResolvedAvatar(view: IdentityAvatarView): TemplateResult {
  if (!view.imageUrl) {
    return renderInitialsAvatar(view.fallback);
  }
  return html`
    ${renderIdentityAvatarImage({
      view,
      fallbackSelector: ".chat-author-avatar",
      className: "chat-author-avatar__image",
      ariaHidden: true,
    })}${renderInitialsAvatar(view.fallback, true)}
  `;
}

/** Small author marker shared by transcript bubbles and the pending-send queue. */
export function renderChatAuthorAvatar(
  sender: IdentityAvatarInput | null | undefined,
): TemplateResult | typeof nothing {
  const label = formatSenderLabel(sender);
  if (!sender || !label) {
    return nothing;
  }
  const view = resolveIdentityAvatarView(sender);
  const resolved = renderResolvedAvatar(view);
  return html`<span
    class=${identityAvatarClass("chat-author-avatar", view)}
    role="img"
    aria-label=${label}
    title=${label}
  >
    ${resolved}
  </span>`;
}
