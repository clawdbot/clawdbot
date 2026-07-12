/**
 * Nostr Profile Edit Form
 *
 * Provides UI for editing and publishing Nostr profile (kind:0).
 */

import { html, nothing, type TemplateResult } from "lit";
import type { NostrProfile as NostrProfileType } from "../../api/types.ts";
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

    if (type === "textarea") {
      return html`
        <div class="form-field" style="margin-bottom: 12px;">
          <label for="${inputId}" style="display: block; margin-bottom: 4px; font-weight: 500;">
            ${label}
          </label>
          <textarea
            id="${inputId}"
            .value=${value}
            placeholder=${placeholder ?? ""}
            maxlength=${maxLength ?? 2000}
            rows="3"
            style="width: 100%; padding: 8px; border: 1px solid var(--border-color); border-radius: var(--radius-sm); resize: vertical; font-family: inherit;"
            @input=${(e: InputEvent) => {
              const target = e.target as HTMLTextAreaElement;
              callbacks.onFieldChange(field, target.value);
            }}
            ?disabled=${state.saving}
          ></textarea>
          ${help
            ? html`<div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">
                ${help}
              </div>`
            : nothing}
          ${error
            ? html`<div style="font-size: 12px; color: var(--danger-color); margin-top: 2px;">
                ${error}
              </div>`
            : nothing}
        </div>
      `;
    }

    return html`
      <div class="form-field" style="margin-bottom: 12px;">
        <label for="${inputId}" style="display: block; margin-bottom: 4px; font-weight: 500;">
          ${label}
        </label>
        <input
          id="${inputId}"
          type=${type}
          .value=${value}
          placeholder=${placeholder ?? ""}
          maxlength=${maxLength ?? 256}
          style="width: 100%; padding: 8px; border: 1px solid var(--border-color); border-radius: var(--radius-sm);"
          @input=${(e: InputEvent) => {
            const target = e.target as HTMLInputElement;
            callbacks.onFieldChange(field, target.value);
          }}
          ?disabled=${state.saving}
        />
        ${help
          ? html`<div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">
              ${help}
            </div>`
          : nothing}
        ${error
          ? html`<div style="font-size: 12px; color: var(--danger-color); margin-top: 2px;">
              ${error}
            </div>`
          : nothing}
      </div>
    `;
  };

  const renderPicturePreview = () => {
    const picture = state.values.picture;
    if (!picture) {
      return nothing;
    }

    return html`
      <div style="margin-bottom: 12px;">
        <img
          src=${picture}
          alt=${t("channels.nostr.profilePicturePreview")}
          style="max-width: 80px; max-height: 80px; border-radius: 50%; object-fit: cover; border: 2px solid var(--border-color);"
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
    `;
  };

  return html`
    <div
      class="nostr-profile-form"
      style="padding: 16px; background: var(--bg-secondary); border-radius: var(--radius-md); margin-top: 12px;"
    >
      <div
        style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;"
      >
        <div style="font-weight: 600; font-size: 16px;">${t("channels.nostr.editProfile")}</div>
        <div style="font-size: 12px; color: var(--text-muted);">
          ${t("channels.nostr.account")}: ${accountId}
        </div>
      </div>

      ${state.error
        ? html`<div class="callout danger" style="margin-bottom: 12px;">${state.error}</div>`
        : nothing}
      ${state.success
        ? html`<div class="callout success" style="margin-bottom: 12px;">${state.success}</div>`
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
            <div
              style="border-top: 1px solid var(--border-color); padding-top: 12px; margin-top: 12px;"
            >
              <div style="font-weight: 500; margin-bottom: 12px; color: var(--text-muted);">
                ${t("channels.nostr.advanced")}
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
            </div>
          `
        : nothing}

      <div style="display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap;">
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

      ${isDirty
        ? html`
            <div style="font-size: 12px; color: var(--warning-color); margin-top: 8px">
              ${t("common.unsavedChanges")}
            </div>
          `
        : nothing}
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
