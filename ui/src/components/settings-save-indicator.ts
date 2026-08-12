import { LitElement, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { t } from "../i18n/index.ts";
import type { ConfigAutoSaveStatus } from "../lib/config/config-state-model.ts";
import { icons } from "./icons.ts";

const SAVED_VISIBLE_MS = 2_000;

export type SettingsSaveIndicatorProps = {
  status: ConfigAutoSaveStatus;
  lastError: string | null;
  needsApply: boolean;
  applying: boolean;
  applyDisabled: boolean;
  onRetry: () => void;
  onReload: () => void;
  onApply: () => void;
};

class SettingsSaveIndicator extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) props?: SettingsSaveIndicatorProps;
  @state() private savedVisible = false;
  private previousStatus: ConfigAutoSaveStatus | undefined;
  private savedTimer: ReturnType<typeof globalThis.setTimeout> | undefined;

  override willUpdate(): void {
    const status = this.props?.status;
    if (this.previousStatus === "saving" && status === "saved") {
      this.clearSavedTimer();
      this.savedVisible = true;
      this.savedTimer = globalThis.setTimeout(() => {
        this.savedTimer = undefined;
        this.savedVisible = false;
      }, SAVED_VISIBLE_MS);
    } else if (status !== "saved") {
      this.clearSavedTimer();
      this.savedVisible = false;
    }
    this.previousStatus = status;
  }

  override disconnectedCallback(): void {
    this.clearSavedTimer();
    super.disconnectedCallback();
  }

  private clearSavedTimer(): void {
    globalThis.clearTimeout(this.savedTimer);
    this.savedTimer = undefined;
  }

  private renderClaw(modifier: string) {
    return html`<span class="settings-save-indicator__claw ${modifier}" aria-hidden="true"
      >${icons.claw}</span
    >`;
  }

  override render() {
    const props = this.props;
    if (!props) {
      return nothing;
    }
    let content: unknown;
    let modifier = "";
    let label = "";
    let title = "";
    if (props.applying) {
      content = html` <span class="settings-save-indicator__spinner" aria-hidden="true"
          >${icons.loader}</span
        >
        <span>${t("configView.applying")}</span>`;
    } else if (props.status === "saving") {
      content = html` ${this.renderClaw("settings-save-indicator__claw--saving")}
        <span>${t("configView.autoSaveSaving")}</span>`;
    } else if (props.status === "error") {
      title = props.lastError?.trim() ?? "";
      label = title ? `${t("configView.autoSaveFailed")}: ${title}` : "";
      modifier = " settings-save-indicator--danger";
      content = html` <span>${t("configView.autoSaveFailed")}</span>
        <button
          class="btn btn--xs settings-save-indicator__action"
          type="button"
          @click=${props.onRetry}
        >
          ${t("configView.retry")}
        </button>`;
    } else if (props.status === "conflict") {
      modifier = " settings-save-indicator--danger";
      content = html` <span>${t("configView.autoSaveConflict")}</span>
        <button
          class="btn btn--xs settings-save-indicator__action"
          type="button"
          @click=${props.onReload}
        >
          ${t("common.reload")}
        </button>`;
    } else if (this.savedVisible) {
      modifier = " settings-save-indicator--saved";
      content = html` ${this.renderClaw("settings-save-indicator__claw--saved")}
        <span class="settings-save-indicator__check" aria-hidden="true">${icons.check}</span>
        <span>${t("configView.autoSaveSaved")}</span>`;
    } else if (props.needsApply) {
      content = html` <button
        class="btn btn--xs settings-save-indicator__apply"
        type="button"
        ?disabled=${props.applyDisabled}
        @click=${props.onApply}
      >
        ${t("configView.applyChanges")}
      </button>`;
    } else {
      return nothing;
    }
    return html`<div
      class="settings-save-indicator${modifier}"
      role="status"
      aria-live="polite"
      aria-label=${label || nothing}
      title=${title || nothing}
    >
      ${content}
    </div>`;
  }
}

if (!customElements.get("openclaw-settings-save-indicator")) {
  customElements.define("openclaw-settings-save-indicator", SettingsSaveIndicator);
}
