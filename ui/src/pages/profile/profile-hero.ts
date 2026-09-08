import { html, nothing } from "lit";
import type { AgentIdentityResult, AgentsListResult } from "../../api/types.ts";
import type { AuthenticatedUser } from "../../app/user-profile.ts";
import { icons } from "../../components/icons.ts";
import { renderSettingsGroup } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { resolveAgentAvatarUrl, resolveAssistantTextAvatar } from "../../lib/avatar.ts";
import "../../components/viewer-facepile.ts";

export type ProfileHeroProps = {
  user?: AuthenticatedUser | null;
  row: AgentsListResult["agents"][number];
  identity: AgentIdentityResult | null | undefined;
  resolveImageUrl: (avatarUrl: string) => string | null;
  failedAvatarUrl: string | null;
  onAvatarError: (avatarUrl: string) => void;
};

function renderHeroAvatar(props: ProfileHeroProps, name: string) {
  if (props.user) {
    return html`<openclaw-viewer-avatar
      .user=${{ ...props.user, name, watchedSessions: [] }}
      variant="profile"
    ></openclaw-viewer-avatar>`;
  }
  const avatarUrl = resolveAgentAvatarUrl(props.row, props.identity);
  const textAvatar =
    resolveAssistantTextAvatar(props.identity?.avatar) ??
    resolveAssistantTextAvatar(props.row.identity?.emoji) ??
    resolveAssistantTextAvatar(props.row.identity?.avatar);
  const imageUrl = avatarUrl?.startsWith("/") ? props.resolveImageUrl(avatarUrl) : avatarUrl;
  if (avatarUrl && avatarUrl !== props.failedAvatarUrl && imageUrl) {
    return html`<img
      class="profile-hero__avatar-image"
      src=${imageUrl}
      alt=${name}
      @error=${() => props.onAvatarError(avatarUrl)}
    />`;
  }
  if (textAvatar) {
    return html`<span class="profile-hero__avatar-text">${textAvatar}</span>`;
  }
  return html`<span class="profile-hero__avatar-mascot" aria-hidden="true">${icons.lobster}</span>`;
}

export function renderProfileHero(props: ProfileHeroProps) {
  // An absent live name is authoritative; the editor's fetched profile may be stale.
  const name = props.user
    ? props.user.name?.trim() || props.user.email || t("nav.owner")
    : props.identity?.name?.trim() ||
      props.row.identity?.name?.trim() ||
      props.row.name?.trim() ||
      props.row.id;
  const handle = props.user ? props.user.email : `@${props.row.id}`;
  return renderSettingsGroup(html`
    <section class="profile-hero">
      <div class="profile-hero__avatar">${renderHeroAvatar(props, name)}</div>
      <div class="profile-hero__name">${name}</div>
      <div class="profile-hero__handle">
        ${handle ? html`<span class="profile-hero__email">${handle}</span>` : nothing}
        <span class="profile-hero__badge">OpenClaw</span>
      </div>
    </section>
  `);
}
