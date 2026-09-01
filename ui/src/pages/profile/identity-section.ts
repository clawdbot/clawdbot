import { html, nothing } from "lit";
import type { UserProfile } from "../../../../packages/gateway-protocol/src/index.ts";
import {
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsStatus,
  renderSettingsToggleRow,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import "../../components/viewer-facepile.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../lib/external-link.ts";
import type { PresenceViewer } from "../../lib/presence-users.ts";
import { PROFILE_SETTINGS_TARGET_IDS } from "../config/settings-targets.ts";

type IdentitySectionProps = {
  profile: UserProfile;
  avatarUrl: string | null;
  displayName: string;
  gitCoauthorEnabled: boolean;
  busy: "display-name" | "avatar" | "git-coauthor" | "loading" | null;
  error: string | null;
  onDisplayNameInput: (value: string) => void;
  onSaveDisplayName: () => void;
  onAvatarSelect: (file: File) => void;
  onGitCoauthorChange: (enabled: boolean) => void;
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
              <button
                type="button"
                class="btn btn--sm"
                ?disabled=${props.busy !== null}
                @click=${(event: Event) => {
                  const button = event.currentTarget;
                  const input =
                    button instanceof HTMLButtonElement ? button.nextElementSibling : null;
                  if (input instanceof HTMLInputElement) {
                    input.click();
                  }
                }}
              >
                ${props.busy === "avatar"
                  ? t("profilePage.identity.processingAvatar")
                  : t("profilePage.identity.chooseAvatar")}
              </button>
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
          title: t("profilePage.identity.githubAccount"),
          description: githubIdentity
            ? t("profilePage.identity.githubAccountDescription")
            : t("profilePage.identity.githubUnavailableDescription"),
          control: githubIdentity
            ? html`
                <a
                  class="settings-account"
                  href=${githubIdentity.profileUrl}
                  target=${EXTERNAL_LINK_TARGET}
                  rel=${buildExternalLinkRel()}
                >
                  <img class="settings-account__avatar" src=${githubIdentity.avatarUrl} alt="" />
                  <span class="settings-row__value settings-row__value--mono"
                    >@${githubIdentity.login}</span
                  >
                </a>
                ${renderSettingsStatus({
                  kind: "ok",
                  label: t("profilePage.identity.githubVerified"),
                })}
              `
            : renderSettingsStatus({
                kind: "muted",
                label: t("profilePage.identity.githubUnavailable"),
              }),
        })}
        ${renderSettingsToggleRow({
          title: t("profilePage.identity.gitCoauthor"),
          description: githubIdentity
            ? t("profilePage.identity.gitCoauthorDescription")
            : t("profilePage.identity.gitCoauthorUnavailable"),
          checked: Boolean(githubIdentity && props.gitCoauthorEnabled),
          disabled: props.busy !== null || !githubIdentity,
          onChange: props.onGitCoauthorChange,
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
