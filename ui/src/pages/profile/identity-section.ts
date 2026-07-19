// Profile identity section: local user avatar plus the assistant's configured
// avatar. Moved from the General settings page so identity has one home.
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { html, nothing } from "lit";
import {
  normalizeLocalUserIdentity,
  resolveLocalUserAvatarText,
  resolveLocalUserAvatarUrl,
} from "../../app/user-identity.ts";
import { renderSettingsSection, renderSettingsStatus } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import {
  assistantAvatarFallbackUrl,
  resolveAssistantTextAvatar,
  resolveChatAvatarRenderUrl,
} from "../../lib/avatar.ts";
import { normalizeOptionalString } from "../../lib/string-coerce.ts";
import { PROFILE_SETTINGS_TARGET_IDS } from "../config/settings-targets.ts";

type IdentitySectionProps = {
  userAvatar: string | null;
  onUserAvatarChange: (next: string | null) => void;
  assistantName: string | null;
  assistantAvatar: string | null;
  assistantAvatarUrl: string | null;
  assistantAvatarSource: string | null;
  assistantAvatarStatus: "none" | "local" | "remote" | "data" | null;
  assistantAvatarReason: string | null;
  basePath: string;
};

// Keep raw uploads comfortably below the 2 MB persisted data URL limit after
// base64 expansion and a small MIME/header prefix are added.
const MAX_LOCAL_USER_AVATAR_FILE_BYTES = 1_500_000;

function renderDefaultUserAvatar() {
  return html`
    <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
      <circle cx="12" cy="8" r="4" />
      <path d="M20 21a8 8 0 1 0-16 0" />
    </svg>
  `;
}

function renderLocalUserAvatarPreview(avatar: string | null | undefined) {
  const identity = normalizeLocalUserIdentity({ name: null, avatar });
  const avatarUrl = resolveLocalUserAvatarUrl(identity);
  const avatarText = resolveLocalUserAvatarText(identity);
  const userLabel = t("quickSettings.personal.you");
  if (avatarUrl) {
    return html`<img class="config-identity__avatar" src=${avatarUrl} alt=${userLabel} />`;
  }
  if (avatarText) {
    return html`<div
      class="config-identity__avatar config-identity__avatar--text"
      aria-label=${userLabel}
    >
      ${avatarText}
    </div>`;
  }
  return html`
    <div class="config-identity__avatar config-identity__avatar--default" aria-label=${userLabel}>
      ${renderDefaultUserAvatar()}
    </div>
  `;
}

function resolveAssistantPreviewAvatarUrl(props: IdentitySectionProps): string | null {
  if (props.assistantAvatarStatus === "none" && props.assistantAvatarReason === "missing") {
    return null;
  }
  return resolveChatAvatarRenderUrl(props.assistantAvatarUrl, {
    identity: {
      avatar: props.assistantAvatar ?? undefined,
      avatarUrl: props.assistantAvatarUrl ?? undefined,
    },
  });
}

function formatAssistantAvatarSource(value: string | null | undefined): string | null {
  const source = normalizeOptionalString(value);
  if (!source) {
    return null;
  }
  if (/^data:image\//i.test(source)) {
    const commaIndex = source.indexOf(",");
    const header = sliceUtf16Safe(source, 0, commaIndex > 0 ? commaIndex : 32);
    return `${header},...`;
  }
  return source.length > 72
    ? `${sliceUtf16Safe(source, 0, 34)}...${sliceUtf16Safe(source, -24)}`
    : source;
}

function formatAssistantAvatarIssue(
  status: IdentitySectionProps["assistantAvatarStatus"],
  reason: string | null | undefined,
): string | null {
  if (status === "remote") {
    return t("quickSettings.personal.avatarIssues.remoteBlocked");
  }
  if (reason === "missing") {
    return t("quickSettings.personal.avatarIssues.missing");
  }
  if (reason === "unsupported_extension") {
    return t("quickSettings.personal.avatarIssues.unsupported");
  }
  if (reason === "outside_workspace") {
    return t("quickSettings.personal.avatarIssues.outsideWorkspace");
  }
  if (reason === "too_large") {
    return t("quickSettings.personal.avatarIssues.tooLarge");
  }
  return reason ? t("quickSettings.personal.avatarIssues.cannotRender") : null;
}

function handleAssistantAvatarPreviewError(event: Event, props: IdentitySectionProps) {
  const image = event.currentTarget;
  if (!(image instanceof HTMLImageElement)) {
    return;
  }
  const fallbackUrl = assistantAvatarFallbackUrl(props.basePath);
  if (image.getAttribute("src") === fallbackUrl) {
    return;
  }
  image.src = fallbackUrl;
  image.classList.add("config-identity__avatar--fallback");
}

function handleAssistantAvatarPreviewLoad(event: Event, props: IdentitySectionProps) {
  const image = event.currentTarget;
  if (!(image instanceof HTMLImageElement)) {
    return;
  }
  // Lit reuses this image across URL rerenders, including classes added after an earlier failure.
  if (image.getAttribute("src") !== assistantAvatarFallbackUrl(props.basePath)) {
    image.classList.remove("config-identity__avatar--fallback");
  }
}

function renderAssistantAvatarPreview(props: IdentitySectionProps) {
  const assistantName =
    normalizeOptionalString(props.assistantName) ?? t("quickSettings.personal.assistant");
  const assistantAvatarUrl = resolveAssistantPreviewAvatarUrl(props);
  if (assistantAvatarUrl) {
    return html`<img
      class="config-identity__avatar"
      src=${assistantAvatarUrl}
      alt=${assistantName}
      @error=${(event: Event) => handleAssistantAvatarPreviewError(event, props)}
      @load=${(event: Event) => handleAssistantAvatarPreviewLoad(event, props)}
    />`;
  }
  const assistantAvatarText = resolveAssistantTextAvatar(props.assistantAvatar);
  if (assistantAvatarText) {
    return html`<div
      class="config-identity__avatar config-identity__avatar--text"
      aria-label=${assistantName}
    >
      ${assistantAvatarText}
    </div>`;
  }
  return html`
    <img
      class="config-identity__avatar config-identity__avatar--fallback"
      src=${assistantAvatarFallbackUrl(props.basePath)}
      alt=${assistantName}
    />
  `;
}

function handleLocalUserAvatarFileSelect(e: Event, props: IdentitySectionProps) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file || !file.type.startsWith("image/") || file.size > MAX_LOCAL_USER_AVATAR_FILE_BYTES) {
    input.value = "";
    return;
  }
  const reader = new FileReader();
  reader.addEventListener("load", () => {
    props.onUserAvatarChange(typeof reader.result === "string" ? reader.result : null);
  });
  reader.readAsDataURL(file);
  input.value = "";
}

export function renderIdentitySection(props: IdentitySectionProps) {
  const identity = normalizeLocalUserIdentity({ name: null, avatar: props.userAvatar });
  const avatarText = resolveLocalUserAvatarText(identity) ?? "";
  const assistantName =
    normalizeOptionalString(props.assistantName) ?? t("quickSettings.personal.assistant");
  const assistantAvatarUrl = resolveAssistantPreviewAvatarUrl(props);
  const assistantAvatarRendered = Boolean(
    assistantAvatarUrl || resolveAssistantTextAvatar(props.assistantAvatar),
  );
  const assistantAvatarSource = formatAssistantAvatarSource(props.assistantAvatarSource);
  const assistantAvatarIssue = formatAssistantAvatarIssue(
    props.assistantAvatarStatus,
    props.assistantAvatarReason,
  );
  const assistantAvatarSubtitle = assistantAvatarIssue
    ? t("quickSettings.personal.fallbackAvatar")
    : assistantAvatarRendered
      ? t("quickSettings.personal.configuredAvatar")
      : t("quickSettings.personal.fallbackLogo");
  // Escape hatch: identity blocks lead with an avatar preview, which the
  // standard row anatomy (text left, one control right) cannot express.
  return html`<div id=${PROFILE_SETTINGS_TARGET_IDS.identity}>
    ${renderSettingsSection(
      { title: t("quickSettings.personal.title") },
      html`
        <section class="config-identity" aria-label=${t("quickSettings.personal.localIdentity")}>
          ${renderLocalUserAvatarPreview(props.userAvatar)}
          <div class="config-identity__copy">
            <div class="config-identity__eyebrow">${t("quickSettings.personal.user")}</div>
            <div class="config-identity__title">${t("quickSettings.personal.you")}</div>
            <div class="config-identity__repair">
              <label class="config-identity__field">
                <span class="config-identity__field-label">
                  ${t("quickSettings.personal.avatarText")}
                </span>
                <input
                  class="settings-input"
                  type="text"
                  maxlength="16"
                  .value=${avatarText}
                  placeholder=${t("quickSettings.personal.avatarPlaceholder")}
                  @input=${(e: Event) => {
                    const value = (e.target as HTMLInputElement).value;
                    props.onUserAvatarChange(value.trim() ? value : null);
                  }}
                />
              </label>
              <div class="config-identity__actions">
                <label class="btn btn--sm">
                  ${t("quickSettings.personal.chooseImage")}
                  <input
                    type="file"
                    accept="image/*"
                    hidden
                    @change=${(e: Event) => handleLocalUserAvatarFileSelect(e, props)}
                  />
                </label>
                <button
                  type="button"
                  class="btn btn--sm btn--ghost"
                  ?disabled=${!identity.avatar}
                  @click=${() => {
                    props.onUserAvatarChange(null);
                  }}
                >
                  ${t("quickSettings.personal.clearAvatar")}
                </button>
              </div>
              <div class="config-identity__hint muted">
                ${t("quickSettings.personal.browserOnly")}
              </div>
            </div>
          </div>
        </section>
        <section
          class="config-identity config-identity--assistant"
          aria-label=${t("quickSettings.personal.assistantIdentity")}
        >
          ${renderAssistantAvatarPreview(props)}
          <div class="config-identity__copy">
            <div class="config-identity__eyebrow">${t("quickSettings.personal.assistant")}</div>
            <div class="config-identity__title">${assistantName}</div>
            <div class="config-identity__sub">${assistantAvatarSubtitle}</div>
            ${assistantAvatarSource
              ? html`
                  <div class="config-identity__source" title=${props.assistantAvatarSource ?? ""}>
                    <span>${t("quickSettings.personal.configuredAvatar")}</span>
                    <code>${assistantAvatarSource}</code>
                  </div>
                `
              : nothing}
            ${assistantAvatarIssue
              ? html`<div class="config-identity__issue">
                  ${renderSettingsStatus({ kind: "warn", label: assistantAvatarIssue })}
                </div>`
              : nothing}
          </div>
        </section>
      `,
    )}
  </div>`;
}
