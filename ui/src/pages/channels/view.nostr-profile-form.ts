/**
 * Nostr Profile Edit Form
 *
 * Provides UI for editing and publishing Nostr profile (kind:0).
 */

import { html, nothing, type TemplateResult } from "lit";
import type { NostrProfile as NostrProfileType } from "../../api/types.ts";
import { renderSettingsStatus } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";

// ============================================================================
// Types
// ============================================================================

export interface NostrProfileFormState {
  /** Current form values */
  values: NostrProfileType;
  /** Original values for dirty detection */
  original: NostrProfileType;
  /** Whether the form is currently submitting */
  saving: boolean;
  /** Whether import is in progress */
  importing: boolean;
  /** Last error message */
  error: string | null;
  /** Last success message */
  success: string | null;
  /** Validation errors per field */
  fieldErrors: Record<string, string>;
  /** Whether to show advanced fields */
  showAdvanced: boolean;
}

export interface NostrProfileFormCallbacks {
  /** Called when a field value changes */
  onFieldChange: (field: keyof NostrProfileType, value: string) => void;
  /** Called when save is clicked */
  onSave: () => void;
  /** Called when import is clicked */
  onImport: () => void;
  /** Called when cancel is clicked */
  onCancel: () => void;
  /** Called when toggle advanced is clicked */
  onToggleAdvanced: () => void;
}

// ============================================================================
// Helpers
// ============================================================================

function isFormDirty(state: NostrProfileFormState): boolean {
  const { values, original } = state;
  return (
    values.name !== original.name ||
    values.displayName !== original.displayName ||
    values.about !== original.about ||
    values.picture !== original.picture ||
    values.banner !== original.banner ||
    values.website !== original.website ||
    values.nip05 !== original.nip05 ||
    values.lud16 !== original.lud16
  );
}

// ============================================================================
// Form Rendering
// ============================================================================

export function renderNostrProfileForm(params: {
  state: NostrProfileFormState;
  callbacks: NostrProfileFormCallbacks;
  accountId: string;
}): TemplateResult {
  const { state, callbacks, accountId } = params;
  const isDirty = isFormDirty(state);

  const renderField = (
    field: keyof NostrProfileType,
    label: string,
    opts: {
      type?: "text" | "url" | "textarea";
      placeholder?: string;
      maxLength?: number;
      help?: string;
    } = {},
  ) => {
    const { type = "text", placeholder, maxLength, help } = opts;
    const value = state.values[field] ?? "";
    const error = state.fieldErrors[field];

    const inputId = `nostr-profile-${field}`;
    const control =
      type === "textarea"
        ? html`
            <textarea
              id="${inputId}"
              class="settings-input"
              .value=${value}
              placeholder=${placeholder ?? ""}
              maxlength=${maxLength ?? 2000}
              rows="3"
              @input=${(e: InputEvent) => {
                const target = e.target as HTMLTextAreaElement;
                callbacks.onFieldChange(field, target.value);
              }}
              ?disabled=${state.saving}
            ></textarea>
          `
        : html`
            <input
              id="${inputId}"
              class="settings-input"
              type=${type}
              .value=${value}
              placeholder=${placeholder ?? ""}
              maxlength=${maxLength ?? 256}
              @input=${(e: InputEvent) => {
                const target = e.target as HTMLInputElement;
                callbacks.onFieldChange(field, target.value);
              }}
              ?disabled=${state.saving}
            />
          `;

    return html`
      <div class="settings-row settings-row--stacked">
        <div class="settings-row__text">
          <label class="settings-row__title" for="${inputId}">${label}</label>
          ${help ? html`<span class="settings-row__desc">${help}</span>` : nothing}
          ${error
            ? html`<span class="settings-row__desc" style="color: var(--danger);">${error}</span>`
            : nothing}
        </div>
        <div class="settings-row__control">${control}</div>
      </div>
    `;
  };

  const renderPicturePreview = () => {
    const picture = state.values.picture;
    if (!picture) {
      return nothing;
    }

    return html`
      <div class="settings-row">
        <div class="settings-row__text">
          <span class="settings-row__title">${t("channels.nostr.profilePicturePreview")}</span>
        </div>
        <div class="settings-row__control">
          <img
            src=${picture}
            alt=${t("channels.nostr.profilePicturePreview")}
            style="max-width: 80px; max-height: 80px; border-radius: 50%; object-fit: cover;"
            @error=${(e: Event) => {
              const img = e.target as HTMLImageElement;
              img.style.display = "none";
            }}
            @load=${(e: Event) => {
              const img = e.target as HTMLImageElement;
              img.style.display = "block";
            }}
          />
        </div>
      </div>
    `;
  };

  return html`
    <div class="settings-row">
      <div class="settings-row__text">
        <span class="settings-row__title">${t("channels.nostr.editProfile")}</span>
        <span class="settings-row__desc">${t("channels.nostr.account")}: ${accountId}</span>
      </div>
    </div>

    ${state.error
      ? html`
          <div class="settings-row">
            <div class="settings-row__text">
              <span class="settings-row__title"
                >${renderSettingsStatus({ kind: "danger", label: t("channels.lastError") })}</span
              >
              <span class="settings-row__desc">${state.error}</span>
            </div>
          </div>
        `
      : nothing}
    ${state.success
      ? html`
          <div class="settings-row">
            <div class="settings-row__text">
              <span class="settings-row__desc">${state.success}</span>
            </div>
          </div>
        `
      : nothing}
    ${renderPicturePreview()}
    ${renderField("name", t("channels.nostr.username"), {
      placeholder: t("channels.nostr.placeholders.username"),
      maxLength: 256,
      help: t("channels.nostr.usernameHelp"),
    })}
    ${renderField("displayName", t("channels.nostr.displayName"), {
      placeholder: t("channels.nostr.placeholders.displayName"),
      maxLength: 256,
      help: t("channels.nostr.displayNameHelp"),
    })}
    ${renderField("about", t("channels.nostr.bio"), {
      type: "textarea",
      placeholder: t("channels.nostr.bioPlaceholder"),
      maxLength: 2000,
      help: t("channels.nostr.bioHelp"),
    })}
    ${renderField("picture", t("channels.nostr.avatarUrl"), {
      type: "url",
      placeholder: t("channels.nostr.placeholders.avatarUrl"),
      help: t("channels.nostr.avatarHelp"),
    })}
    ${state.showAdvanced
      ? html`
          <div class="settings-row">
            <div class="settings-row__text">
              <span class="settings-row__title">${t("channels.nostr.advanced")}</span>
            </div>
          </div>

          ${renderField("banner", t("channels.nostr.bannerUrl"), {
            type: "url",
            placeholder: t("channels.nostr.placeholders.bannerUrl"),
            help: t("channels.nostr.bannerHelp"),
          })}
          ${renderField("website", t("channels.nostr.website"), {
            type: "url",
            placeholder: t("channels.nostr.placeholders.website"),
            help: t("channels.nostr.websiteHelp"),
          })}
          ${renderField("nip05", t("channels.nostr.nip05Identifier"), {
            placeholder: t("channels.nostr.placeholders.nip05"),
            help: t("channels.nostr.nip05Help"),
          })}
          ${renderField("lud16", t("channels.nostr.lightningAddress"), {
            placeholder: t("channels.nostr.placeholders.lightningAddress"),
            help: t("channels.nostr.lightningHelp"),
          })}
        `
      : nothing}

    <div class="settings-row">
      <div class="settings-row__text">
        ${isDirty
          ? html`<span class="settings-row__desc">${t("common.unsavedChanges")}</span>`
          : nothing}
      </div>
      <div class="settings-row__control">
        <button
          class="btn primary"
          @click=${callbacks.onSave}
          ?disabled=${state.saving || !isDirty}
        >
          ${state.saving ? t("common.saving") : t("common.saveAndPublish")}
        </button>

        <button
          class="btn"
          @click=${callbacks.onImport}
          ?disabled=${state.importing || state.saving}
        >
          ${state.importing ? t("common.importing") : t("common.importFromRelays")}
        </button>

        <button class="btn" @click=${callbacks.onToggleAdvanced}>
          ${state.showAdvanced ? t("common.hideAdvanced") : t("common.showAdvanced")}
        </button>

        <button class="btn" @click=${callbacks.onCancel} ?disabled=${state.saving}>
          ${t("common.cancel")}
        </button>
      </div>
    </div>
  `;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create initial form state from existing profile
 */
export function createNostrProfileFormState(
  profile: NostrProfileType | undefined,
): NostrProfileFormState {
  const values: NostrProfileType = {
    name: profile?.name ?? "",
    displayName: profile?.displayName ?? "",
    about: profile?.about ?? "",
    picture: profile?.picture ?? "",
    banner: profile?.banner ?? "",
    website: profile?.website ?? "",
    nip05: profile?.nip05 ?? "",
    lud16: profile?.lud16 ?? "",
  };

  return {
    values,
    original: { ...values },
    saving: false,
    importing: false,
    error: null,
    success: null,
    fieldErrors: {},
    showAdvanced: Boolean(profile?.banner || profile?.website || profile?.nip05 || profile?.lud16),
  };
}
