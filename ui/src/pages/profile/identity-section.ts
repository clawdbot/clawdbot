import { html, nothing } from "lit";
import type { UserProfile } from "../../../../packages/gateway-protocol/src/index.ts";
import {
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import "../../components/viewer-facepile.ts";
import type { PresenceViewer } from "../../lib/presence-users.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../lib/external-link.ts";
import { PROFILE_SETTINGS_TARGET_IDS } from "../config/settings-targets.ts";

type IdentitySectionProps = {
  profile: UserProfile;
  avatarUrl: string | null;
  displayName: string;
  githubUsername: string;
  busy: "display-name" | "avatar" | "github" | "loading" | null;
  error: string | null;
  onDisplayNameInput: (value: string) => void;
  onSaveDisplayName: () => void;
  onAvatarSelect: (file: File) => void;
  onGitHubUsernameInput: (value: string) => void;
  onSaveGitHubIdentity: () => void;
  onClearGitHubIdentity: () => void;
};

function avatarViewer(profile: UserProfile, avatarUrl: string | null): PresenceViewer {
  return {
    id: profile.id,
    name: profile.displayName ?? undefined,
    email: profile.emails[0],
    avatarUrl: avatarUrl ?? undefined,
    watchedSessions: [],
  };
}

export function renderIdentitySection(props: IdentitySectionProps) {
  const savedName = props.profile.displayName ?? "";
  const nameChanged = props.displayName.trim() !== savedName;
  const emails = props.profile.emails.join(", ");
  const githubIdentity = props.profile.githubIdentity;
  const githubLoginChanged =
    props.githubUsername.trim().toLowerCase() !== (githubIdentity?.login.toLowerCase() ?? "");
  return html`<div id=${PROFILE_SETTINGS_TARGET_IDS.identity}>
    ${renderSettingsSection(
      {
        title: t("profilePage.identity.title"),
        description: t("profilePage.identity.description"),
      },
      html`
        ${renderSettingsRow({
          title: t("profilePage.identity.avatar"),
          description: t("profilePage.identity.avatarDescription"),
          control: html`
            <span class="identity-avatar-control">
              <openclaw-viewer-avatar
                .user=${avatarViewer(props.profile, props.avatarUrl)}
                variant="profile"
              ></openclaw-viewer-avatar>
              <label class="btn btn--sm">
                ${props.busy === "avatar"
                  ? t("profilePage.identity.processingAvatar")
                  : t("profilePage.identity.chooseAvatar")}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  hidden
                  ?disabled=${props.busy !== null}
                  @change=${(event: Event) => {
                    const input = event.currentTarget as HTMLInputElement;
                    const file = input.files?.[0];
                    input.value = "";
                    if (file) {
                      props.onAvatarSelect(file);
                    }
                  }}
                />
              </label>
            </span>
          `,
        })}
        ${renderSettingsRow({
          title: t("profilePage.identity.displayName"),
          description: t("profilePage.identity.displayNameDescription"),
          control: html`
            <form
              class="identity-name-control"
              @submit=${(event: SubmitEvent) => {
                event.preventDefault();
                props.onSaveDisplayName();
              }}
            >
              <input
                class="settings-input"
                type="text"
                maxlength="256"
                aria-label=${t("profilePage.identity.displayName")}
                .value=${props.displayName}
                ?disabled=${props.busy !== null}
                @input=${(event: Event) =>
                  props.onDisplayNameInput((event.currentTarget as HTMLInputElement).value)}
              />
              <button
                type="submit"
                class="btn btn--sm"
                ?disabled=${props.busy !== null || !nameChanged}
              >
                ${props.busy === "display-name" ? t("common.saving") : t("common.save")}
              </button>
            </form>
          `,
        })}
        ${renderSettingsRow({
          title: t("profilePage.identity.linkedEmails"),
          description: t("profilePage.identity.linkedEmailsDescription"),
          control: emails ? renderSettingsValue(emails) : nothing,
        })}
        ${renderSettingsRow({
          title: t("profilePage.identity.github"),
          description: t("profilePage.identity.githubDescription"),
          control: html`
            <div class="identity-github-control">
              ${githubIdentity
                ? html`<a
                    class="settings-account"
                    href=${githubIdentity.profileUrl}
                    target=${EXTERNAL_LINK_TARGET}
                    rel=${buildExternalLinkRel()}
                  >
                    <img class="settings-account__avatar" src=${githubIdentity.avatarUrl} alt="" />
                    <span class="settings-row__value settings-row__value--mono"
                      >@${githubIdentity.login}</span
                    >
                  </a>`
                : nothing}
              <form
                class="identity-github-form"
                @submit=${(event: SubmitEvent) => {
                  event.preventDefault();
                  props.onSaveGitHubIdentity();
                }}
              >
                <input
                  class="settings-input"
                  type="text"
                  maxlength="39"
                  autocomplete="off"
                  spellcheck="false"
                  aria-label=${t("profilePage.identity.githubUsername")}
                  placeholder=${t("profilePage.identity.githubPlaceholder")}
                  .value=${props.githubUsername}
                  ?disabled=${props.busy !== null}
                  @input=${(event: Event) => {
                    if (event.currentTarget instanceof HTMLInputElement) {
                      props.onGitHubUsernameInput(event.currentTarget.value);
                    }
                  }}
                />
                <button
                  type="submit"
                  class="btn btn--sm"
                  ?disabled=${props.busy !== null ||
                  !props.githubUsername.trim() ||
                  !githubLoginChanged}
                >
                  ${props.busy === "github"
                    ? t("profilePage.identity.githubLinking")
                    : githubIdentity
                      ? t("profilePage.identity.githubChange")
                      : t("profilePage.identity.githubLink")}
                </button>
                ${githubIdentity
                  ? html`<button
                      type="button"
                      class="btn btn--sm"
                      ?disabled=${props.busy !== null}
                      @click=${props.onClearGitHubIdentity}
                    >
                      ${t("profilePage.identity.githubDisconnect")}
                    </button>`
                  : nothing}
              </form>
              <span class="settings-row__desc">${t("profilePage.identity.githubPrivacy")}</span>
              <span class="settings-row__desc">${t("profilePage.identity.githubOwnership")}</span>
            </div>
          `,
        })}
        ${props.error
          ? html`<div class="settings-row identity-error" role="alert">
              <span class="settings-row__desc">${props.error}</span>
            </div>`
          : nothing}
      `,
    )}
  </div>`;
}
