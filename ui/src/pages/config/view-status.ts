import { html, nothing } from "lit";
import { icons } from "../../components/icons.ts";
import { renderSettingsStatus } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import type { ConfigAutoSaveStatus } from "../../lib/config/index.ts";

export const renderBusyButtonContent = (busy: boolean, label: string, busyLabel: string) =>
  busy
    ? html`<span class="config-action-spinner" aria-hidden="true">${icons.loader}</span
        >${busyLabel}`
    : label;

type ConfigApplyBannerProps = {
  needsApply: boolean;
  applying: boolean;
  /** Any config write in flight or config load pending; gates the action. */
  busy: boolean;
  connected: boolean;
  onApply: () => void;
};

/** Slim restart affordance shown after config.set until config.apply runs. */
export function renderConfigApplyBanner(props: ConfigApplyBannerProps) {
  if (!props.needsApply) {
    return nothing;
  }
  return html`
    <div class="config-apply-banner" role="status">
      <span class="config-apply-banner__text">${t("configView.applyBannerText")}</span>
      <button
        class="btn btn--sm"
        ?disabled=${props.busy || props.applying || !props.connected}
        aria-busy=${props.applying ? "true" : "false"}
        @click=${props.onApply}
      >
        ${renderBusyButtonContent(
          props.applying,
          t("configView.applyBannerAction"),
          t("configView.applying"),
        )}
      </button>
    </div>
  `;
}

/**
 * Inline autosave status shared by the schema editor and Quick Settings:
 * Saving…/Saved plus the failure recoveries (Retry re-submits, conflict only
 * offers a discarding reload so the draft cannot clobber another writer).
 */
export function renderConfigAutoSaveStatus(props: {
  status: ConfigAutoSaveStatus;
  onRetry: () => void;
  onReload: () => void;
}) {
  switch (props.status) {
    case "saving":
      return renderSettingsStatus({ kind: "accent", label: t("configView.autoSaveSaving") });
    case "saved":
      return renderSettingsStatus({ kind: "ok", label: t("configView.autoSaveSaved") });
    case "error":
      return html`
        ${renderSettingsStatus({ kind: "danger", label: t("configView.autoSaveFailed") })}
        <button class="btn btn--sm" @click=${props.onRetry}>${t("configView.retry")}</button>
      `;
    case "conflict":
      // Another writer changed openclaw.json; retrying this whole-form draft
      // would clobber their edit, so the only offered recovery is a reload.
      return html`
        ${renderSettingsStatus({ kind: "danger", label: t("configView.autoSaveConflict") })}
        <button class="btn btn--sm" @click=${props.onReload}>${t("common.reload")}</button>
      `;
    default:
      return nothing;
  }
}
