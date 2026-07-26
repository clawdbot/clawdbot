import { html, nothing, type TemplateResult } from "lit";
import { formatSenderLabel } from "../../../lib/chat/sender-label.ts";
import {
  resolveAvatar,
  resolveAvatarInitials,
  type IdentityAvatarInput,
  type ResolvedIdentityAvatar,
} from "../../../lib/identity-avatar.ts";

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

function renderResolvedAvatar(
  avatar: ResolvedIdentityAvatar,
  fallback: Extract<ResolvedIdentityAvatar, { kind: "initials" }>,
): TemplateResult {
  if (avatar.kind === "initials") {
    return renderInitialsAvatar(avatar);
  }
  return html`
    <img
      class="chat-author-avatar__image"
      src=${avatar.url}
      alt=""
      aria-hidden="true"
      @error=${(event: Event) => {
        const image = event.currentTarget;
        if (image instanceof HTMLImageElement) {
          image.closest<HTMLElement>(".chat-author-avatar")?.classList.add("is-fallback");
        }
      }}
      @load=${(event: Event) => {
        // Lit reuses DOM parts across renders; a prior sender's error state
        // must not hide a successfully loaded avatar for the next source.
        const image = event.currentTarget;
        if (image instanceof HTMLImageElement) {
          image.closest<HTMLElement>(".chat-author-avatar")?.classList.remove("is-fallback");
        }
      }}
    />
    ${renderInitialsAvatar(fallback, true)}
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
  const fallback = resolveAvatarInitials(sender);
  const avatar = resolveAvatar(sender);
  const resolved =
    avatar.kind === "initials"
      ? renderInitialsAvatar(avatar)
      : renderResolvedAvatar(avatar, fallback);
  return html`
    <span class="chat-author-avatar" role="img" aria-label=${label} title=${label}>
      ${resolved}
    </span>
  `;
}
