/**
 * General settings — the curated settings hub, built on the shared settings
 * design language (single column, sections of hairline-divided rows). Owns
 * only genuinely global items: navigation to model defaults and language.
 * Channels, security, automations, appearance, and identity each have their
 * own settings page.
 */

import { html, nothing } from "lit";
import {
  renderSettingsNavRow,
  renderSettingsPage,
  renderSettingsRow,
  renderSettingsSection,
} from "../../components/settings-ui.ts";
import { t, type Locale } from "../../i18n/index.ts";
import type { ConfigAutoSaveStatus } from "../../lib/config/index.ts";
import { renderLanguageSelect } from "./language-select.ts";
import { renderConfigApplyBanner, renderConfigAutoSaveStatus } from "./view.ts";

// ── Types ──

type QuickSettingsProps = {
  // General
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;

  onModelsClick: () => void;

  // Config staging state (quick edits auto-save through the shared draft)
  configLoading?: boolean;
  configSaving?: boolean;
  configApplying?: boolean;
  configUpdating?: boolean;
  configNeedsApply?: boolean;
  /** Capability-authoritative unsaved raw draft; apply() refuses while set. */
  configRawDraftPending?: boolean;
  configAutoSaveStatus?: ConfigAutoSaveStatus;
  onApplyConfig?: () => void;
  onRetrySaveConfig?: () => void;
  onDiscardConfig?: () => void;

  // The apply action is unavailable while the Gateway is offline.
  connected: boolean;
};

// ── Section renderers ──

function renderGeneralSection(props: QuickSettingsProps) {
  return renderSettingsSection({ title: t("nav.settingsGeneral") }, [
    renderSettingsNavRow({
      title: t("routeTitles.modelProviders"),
      description: t("subtitles.modelProviders"),
      onClick: props.onModelsClick,
    }),
    renderSettingsRow({
      title: t("quickSettings.language"),
      description: t("configView.syncedHint"),
      control: renderLanguageSelect(props.locale, props.onLocaleChange),
    }),
  ]);
}

// ── Main render ──

function renderQuickAutoSaveStatus(props: QuickSettingsProps) {
  const status = renderConfigAutoSaveStatus({
    status: props.configAutoSaveStatus ?? "idle",
    onRetry: () => props.onRetrySaveConfig?.(),
    onReload: () => props.onDiscardConfig?.(),
  });
  if (status === nothing) {
    return nothing;
  }
  return html`
    <div class="config-toolbar__status" role="status" aria-live="polite">${status}</div>
  `;
}

export function renderQuickSettings(props: QuickSettingsProps) {
  return renderSettingsPage(html`
    ${renderQuickAutoSaveStatus(props)}
    ${renderConfigApplyBanner({
      needsApply: props.configNeedsApply === true,
      applying: props.configApplying === true,
      // Mirrors the schema editor's banner gating: a dirty raw draft blocks
      // apply outright, so an enabled action here would always fail.
      busy:
        props.configSaving === true ||
        props.configLoading === true ||
        props.configUpdating === true ||
        props.configAutoSaveStatus === "saving" ||
        props.configRawDraftPending === true,
      connected: props.connected,
      onApply: () => props.onApplyConfig?.(),
    })}
    ${renderGeneralSection(props)}
  `);
}
