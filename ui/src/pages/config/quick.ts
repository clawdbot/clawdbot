/**
 * General settings — the curated settings hub, built on the shared settings
 * design language (single column, sections of hairline-divided rows). Owns
 * only genuinely global items: agent defaults and language.
 * Channels, security, automations, appearance, and identity each have their
 * own settings page.
 */

import { html, nothing, type TemplateResult } from "lit";
import { formatFastModeValue } from "../../../../src/shared/fast-mode.js";
import type { FastMode } from "../../api/types.ts";
import {
  renderSettingsNavRow,
  renderSettingsPage,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsSegmented,
  renderSettingsValue,
  type SettingsSectionProps,
} from "../../components/settings-ui.ts";
import { t, type Locale } from "../../i18n/index.ts";
import { BASE_THINKING_LEVELS } from "../../lib/chat/thinking.ts";
import type { ConfigAutoSaveStatus } from "../../lib/config/index.ts";
import { renderLanguageSelect } from "./language-select.ts";
import { GENERAL_SETTINGS_TARGET_IDS } from "./settings-targets.ts";
import { renderConfigApplyBanner, renderConfigAutoSaveStatus } from "./view.ts";

// ── Types ──

type QuickSettingsProps = {
  // General
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;

  // Model & Thinking
  currentModel: string;
  thinkingLevel: string;
  fastMode: FastMode | undefined;
  onModelChange?: () => void;
  onThinkingChange?: (level: string) => void;
  onFastModeChange?: (mode: FastMode) => void;

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

// The compact General hub intentionally omits "minimal"; the full list stays
// available on session-level pickers.
const THINKING_LEVELS = BASE_THINKING_LEVELS.filter((level) => level !== "minimal");

/** Section wrapper that keeps the stable settings-search scroll target ids. */
function renderTargetSection(
  id: string,
  props: SettingsSectionProps,
  rows: unknown,
): TemplateResult {
  return html`<div id=${id}>${renderSettingsSection(props, rows)}</div>`;
}

// ── Section renderers ──

function fastModeOptionValue(value: "auto" | "on" | "off"): FastMode {
  return value === "auto" ? "auto" : value === "on";
}

function isConfigBusy(props: QuickSettingsProps): boolean {
  return (
    props.configLoading === true ||
    props.configSaving === true ||
    props.configApplying === true ||
    props.configUpdating === true
  );
}

function renderGeneralSection(props: QuickSettingsProps) {
  return renderSettingsSection({ title: t("nav.settingsGeneral") }, [
    renderSettingsRow({
      title: t("quickSettings.language"),
      description: t("configView.syncedHint"),
      control: renderLanguageSelect(props.locale, props.onLocaleChange),
    }),
  ]);
}

function renderModelSection(props: QuickSettingsProps) {
  const fastMode = formatFastModeValue(props.fastMode);
  const configBusy = isConfigBusy(props);
  return renderTargetSection(
    GENERAL_SETTINGS_TARGET_IDS.model,
    { title: t("quickSettings.model.title") },
    [
      renderSettingsNavRow({
        title: t("quickSettings.model.model"),
        control: renderSettingsValue(props.currentModel || "default", { mono: true }),
        onClick: () => props.onModelChange?.(),
      }),
      renderSettingsRow({
        title: t("quickSettings.model.thinking"),
        control: renderSettingsSegmented({
          value: props.thinkingLevel,
          options: THINKING_LEVELS.map((level) => ({
            value: level,
            label: t(`quickSettings.model.thinkingLevels.${level}`),
          })),
          disabled: configBusy,
          onChange: (level) => props.onThinkingChange?.(level),
        }),
      }),
      renderSettingsRow({
        title: t("quickSettings.model.fastMode"),
        control: renderSettingsSegmented<"auto" | "on" | "off">({
          value: fastMode,
          options: [
            { value: "auto", label: t("quickSettings.model.fastModes.auto") },
            { value: "on", label: t("quickSettings.model.fastModes.fast") },
            { value: "off", label: t("quickSettings.model.fastModes.standard") },
          ],
          disabled: configBusy,
          onChange: (value) => {
            if (value !== fastMode) {
              props.onFastModeChange?.(fastModeOptionValue(value));
            }
          },
        }),
      }),
    ],
  );
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
    ${renderModelSection(props)} ${renderGeneralSection(props)}
  `);
}
