// Profile hero card: featured agent identity with an authenticated avatar.
import { html } from "lit";
import type { AgentIdentityResult } from "../../api/types.ts";
import { icons } from "../../components/icons.ts";
import { renderSettingsGroup } from "../../components/settings-ui.ts";
import { resolveAgentAvatarUrl, resolveAssistantTextAvatar } from "../../lib/avatar.ts";

type HeroAgentRow = {
  id: string;
  name?: string;
  identity?: { name?: string; emoji?: string; avatar?: string; avatarUrl?: string };
};

type HeroAgentIdentity = AgentIdentityResult | null | undefined;

export type ProfileHeroProps = {
  agentId: string;
  row: HeroAgentRow;
  identity: HeroAgentIdentity;
  resolveImageUrl: (avatarUrl: string) => string | null;
  failedAvatarUrl: string | null;
  onAvatarError: (avatarUrl: string) => void;
};

function renderHeroAvatar(props: ProfileHeroProps) {
  const avatarUrl = resolveAgentAvatarUrl(props.row, props.identity);
  const textAvatar =
    resolveAssistantTextAvatar(props.identity?.avatar) ??
    resolveAssistantTextAvatar(props.row.identity?.emoji) ??
    resolveAssistantTextAvatar(props.row.identity?.avatar);
  const name = heroName(props);
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

function heroName(props: ProfileHeroProps): string {
  return (
    props.identity?.name?.trim() ||
    props.row.identity?.name?.trim() ||
    props.row.name?.trim() ||
    props.agentId
  );
}

export function renderProfileHero(props: ProfileHeroProps) {
  return renderSettingsGroup(html`
    <section class="profile-hero">
      <div class="profile-hero__avatar">${renderHeroAvatar(props)}</div>
      <div class="profile-hero__name">${heroName(props)}</div>
      <div class="profile-hero__handle">
        <span>@${props.agentId}</span>
        <span class="profile-hero__badge">OpenClaw</span>
      </div>
    </section>
  `);
}
