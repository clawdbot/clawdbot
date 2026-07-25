/**
 * General settings — the curated settings hub, built on the shared settings
 * design language (single column, sections of hairline-divided rows). Owns
 * only genuinely global items: agent defaults, language, and gateway host.
 * Channels, security, automations, appearance, and identity each have their
 * own settings page.
 */

import { html, nothing, type TemplateResult } from "lit";
import type { SystemInfoResult } from "../../../../packages/gateway-protocol/src/index.js";
import { formatFastModeValue } from "../../../../src/shared/fast-mode.js";
import type { FastMode } from "../../api/types.ts";
import {
  renderSettingsGroup,
  renderSettingsNavRow,
  renderSettingsPage,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsSegmented,
  renderSettingsStatus,
  renderSettingsValue,
  type SettingsSectionProps,
} from "../../components/settings-ui.ts";
import { t, type Locale } from "../../i18n/index.ts";
import { formatBytes } from "../../lib/agents/display.ts";
import { BASE_THINKING_LEVELS } from "../../lib/chat/thinking.ts";
import type { ConfigAutoSaveStatus } from "../../lib/config/index.ts";
import { formatDurationHuman } from "../../lib/format.ts";
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

  // Gateway host
  systemInfo?: SystemInfoResult | null;
  systemInfoUnavailable?: boolean;

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

  // Connection
  connected: boolean;
  assistantName: string;
  version: string;
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

type SystemStat = {
  label: string;
  value: string;
  unit?: string;
  detail?: string;
  /** Used share of the resource (0..1); renders the meter bar when present. */
  usedFraction?: number;
  title?: string;
};

// Meter tones reuse the status palette: calm until 75%, warn to 92%, critical beyond.
function systemMeterTone(fraction: number): "ok" | "warn" | "critical" {
  if (fraction >= 0.92) {
    return "critical";
  }
  if (fraction >= 0.75) {
    return "warn";
  }
  return "ok";
}

function renderSystemMeter(label: string, fraction: number) {
  const clamped = Math.min(Math.max(fraction, 0), 1);
  const percent = Math.round(clamped * 100);
  return html`
    <div
      class="config-host__meter"
      role="meter"
      aria-label=${t("quickSettings.system.usage", { label })}
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow=${percent}
    >
      <div
        class="config-host__meter-fill config-host__meter-fill--${systemMeterTone(clamped)}"
        style="--config-host-meter-fill: ${percent}%"
      ></div>
    </div>
  `;
}

function renderSystemStat(stat: SystemStat) {
  return html`
    <div class="config-host__stat" title=${stat.title ?? ""}>
      <div class="config-host__stat-label">${stat.label}</div>
      <div class="config-host__stat-value">
        ${stat.value}${stat.unit
          ? html` <span class="config-host__stat-unit">${stat.unit}</span>`
          : nothing}
      </div>
      ${stat.usedFraction == null ? nothing : renderSystemMeter(stat.label, stat.usedFraction)}
      ${stat.detail ? html`<div class="config-host__stat-detail">${stat.detail}</div>` : nothing}
    </div>
  `;
}

function usedFraction(totalBytes: number | undefined, freeBytes: number | undefined) {
  if (totalBytes == null || freeBytes == null || totalBytes <= 0) {
    return undefined;
  }
  return (totalBytes - freeBytes) / totalBytes;
}

function formatUsedPercent(fraction: number) {
  return `${Math.round(Math.min(Math.max(fraction, 0), 1) * 100)}%`;
}

function buildSystemStats(info: SystemInfoResult): SystemStat[] {
  const load = info.loadAverage?.[0];
  const loadTitle = info.loadAverage
    ? t("quickSettings.system.loadAverage", {
        values: info.loadAverage.map((value) => value.toFixed(1)).join(" · "),
      })
    : undefined;
  const cpuTitle = [info.cpuModel, loadTitle].filter(Boolean).join(" · ") || undefined;
  const coresLabel = t(
    info.cpuCount === 1 ? "quickSettings.system.core" : "quickSettings.system.cores",
    { count: String(info.cpuCount) },
  );
  const cpu: SystemStat =
    load == null
      ? {
          label: t("quickSettings.system.cpu"),
          value: coresLabel,
          detail: info.cpuModel,
          title: cpuTitle,
        }
      : {
          label: t("quickSettings.system.cpu"),
          value: load.toFixed(1),
          unit: t("quickSettings.system.load"),
          detail: coresLabel,
          // 1-minute load over core count approximates saturation; >100% clamps full.
          usedFraction: info.cpuCount > 0 ? load / info.cpuCount : undefined,
          title: cpuTitle,
        };
  const memoryUsed = usedFraction(info.memoryTotalBytes, info.memoryFreeBytes);
  const memory: SystemStat = {
    label: t("quickSettings.system.memory"),
    value: memoryUsed == null ? "—" : formatUsedPercent(memoryUsed),
    unit: memoryUsed == null ? undefined : t("quickSettings.system.used"),
    detail: t("quickSettings.system.freeOf", {
      free: formatBytes(info.memoryFreeBytes),
      total: formatBytes(info.memoryTotalBytes),
    }),
    usedFraction: memoryUsed,
  };
  const stats = [cpu, memory];
  const diskUsed = usedFraction(info.diskTotalBytes, info.diskAvailableBytes);
  // Disk info is optional in the protocol; skip the tile instead of showing an empty gauge.
  if (diskUsed != null) {
    stats.push({
      label: t("quickSettings.system.disk"),
      value: formatUsedPercent(diskUsed),
      unit: t("quickSettings.system.used"),
      detail: t("quickSettings.system.freeOf", {
        free: formatBytes(info.diskAvailableBytes),
        total: formatBytes(info.diskTotalBytes),
      }),
      usedFraction: diskUsed,
      title: info.diskPath,
    });
  }
  return stats;
}

function buildSystemStatsPlaceholder(): SystemStat[] {
  return [
    { label: t("quickSettings.system.cpu"), value: "—" },
    { label: t("quickSettings.system.memory"), value: "—" },
    { label: t("quickSettings.system.disk"), value: "—" },
  ];
}

function renderSystemSection(props: QuickSettingsProps) {
  if (props.systemInfoUnavailable) {
    return nothing;
  }
  const info = props.systemInfo;
  const placeholder = "—";
  const hostTitle = info && info.hostname !== info.machineName ? info.hostname : undefined;
  const address = info?.lanAddress
    ? `${info.lanAddress}${info.port == null ? "" : `:${info.port}`}`
    : undefined;
  const stats = info ? buildSystemStats(info) : buildSystemStatsPlaceholder();

  // Escape hatch: host identity + metered stats are a genuine two-column grid,
  // kept as custom markup inside the single group with row-matched paddings.
  return renderTargetSection(
    GENERAL_SETTINGS_TARGET_IDS.system,
    {
      title: t("quickSettings.system.gatewayHost"),
      actions: info
        ? renderSettingsStatus({
            kind: "ok",
            label: t("quickSettings.system.up", { duration: formatDurationHuman(info.uptimeMs) }),
          })
        : undefined,
    },
    html`
      <div class="config-host">
        <div class="config-host__identity">
          <div class="config-host__name" title=${hostTitle ?? ""}>
            ${info?.machineName ?? placeholder}
          </div>
          <div class="config-host__meta">
            ${info ? `${info.osLabel} · ${info.arch}` : placeholder}
          </div>
          <div class="config-host__meta">
            ${info
              ? t("quickSettings.system.runtime", {
                  version: info.nodeVersion,
                  pid: String(info.pid),
                })
              : placeholder}
          </div>
          ${address ? html`<code class="config-host__address">${address}</code>` : nothing}
        </div>
        <div class="config-host__stats">${stats.map(renderSystemStat)}</div>
      </div>
    `,
  );
}

function renderConnectionFooter(props: QuickSettingsProps) {
  const detail = [props.assistantName, props.version ? `v${props.version}` : ""]
    .filter(Boolean)
    .join(" · ");
  return renderSettingsGroup(
    renderSettingsRow({
      title: renderSettingsStatus({
        kind: props.connected ? "ok" : "muted",
        label: props.connected ? t("common.connected") : t("common.offline"),
      }),
      control: detail ? renderSettingsValue(detail) : nothing,
    }),
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
    ${renderModelSection(props)} ${renderGeneralSection(props)} ${renderSystemSection(props)}
    ${renderConnectionFooter(props)}
  `);
}
