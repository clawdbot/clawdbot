/**
 * Quick Settings view — the default settings experience, built on the shared
 * settings design language (single column, sections of hairline-divided rows).
 * Replaces the raw schema-driven form as the default settings experience.
 */

import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { html, nothing, type TemplateResult } from "lit";
import type { SystemInfoResult } from "../../../../packages/gateway-protocol/src/index.js";
import { formatFastModeValue } from "../../../../src/shared/fast-mode.js";
import type { FastMode } from "../../api/types.ts";
import { controlUiPublicAssetPath } from "../../app/public-assets.ts";
import type { TextScaleStop } from "../../app/settings.ts";
import type { ThemeTransitionContext } from "../../app/theme-transition.ts";
import type { ThemeMode, ThemeName } from "../../app/theme.ts";
import {
  normalizeLocalUserIdentity,
  resolveLocalUserAvatarText,
  resolveLocalUserAvatarUrl,
} from "../../app/user-identity.ts";
import { icons } from "../../components/icons.ts";
import { getLobsterdex, getLobsterdexEntries } from "../../components/lobster-dex.ts";
import {
  LOBSTER_PET_PALETTES,
  canonicalLobsterLook,
  renderLobsterSvg,
} from "../../components/lobster-pet.ts";
import {
  renderSettingsEmpty,
  renderSettingsGroup,
  renderSettingsNavRow,
  renderSettingsPage,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsSegmented,
  renderSettingsStatus,
  renderSettingsToggleRow,
  renderSettingsValue,
  type SettingsSectionProps,
} from "../../components/settings-ui.ts";
import { t, type Locale } from "../../i18n/index.ts";
import { formatBytes } from "../../lib/agents/display.ts";
import { resolveAssistantTextAvatar, resolveChatAvatarRenderUrl } from "../../lib/avatar.ts";
import type { ConfigAutoSaveStatus } from "../../lib/config/index.ts";
import { formatDurationHuman } from "../../lib/format.ts";
import { normalizeOptionalString } from "../../lib/string-coerce.ts";
import { renderLanguageSelect } from "./language-select.ts";
import { GENERAL_SETTINGS_TARGET_IDS } from "./settings-targets.ts";
import { renderConfigApplyBanner, renderConfigAutoSaveStatus } from "./view.ts";

// ── Types ──

export type QuickSettingsChannel = {
  id: string;
  label: string;
  connected: boolean;
  detail?: string;
};

type QuickSettingsAutomation = {
  cronJobCount: number;
  skillCount: number;
  mcpServerCount: number;
};

export type QuickSettingsSecurity = {
  gatewayAuth: string;
  execPolicy: string;
  deviceAuth: boolean;
  browserEnabled: boolean;
  toolProfile: string;
};

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

  // Channels
  channels: QuickSettingsChannel[];
  onChannelConfigure?: (channelId: string) => void;

  // Automations
  automation: QuickSettingsAutomation;
  onManageCron?: () => void;
  onBrowseSkills?: () => void;
  onConfigureMcp?: () => void;

  // Security
  security: QuickSettingsSecurity;
  onSecurityConfigure?: () => void;
  canPairDevice?: boolean;
  onPairMobile?: () => void;
  onBrowserEnabledToggle?: (enabled: boolean) => void;
  onToolProfileChange?: (profile: string) => void;

  // Gateway host
  systemInfo?: SystemInfoResult | null;
  systemInfoUnavailable?: boolean;

  // Appearance
  theme: ThemeName;
  themeMode: ThemeMode;
  hasCustomTheme: boolean;
  customThemeLabel?: string | null;
  textScale: number;
  setTheme: (theme: ThemeName, context?: ThemeTransitionContext) => void;
  onOpenCustomThemeImport?: () => void;
  setThemeMode: (mode: ThemeMode, context?: ThemeTransitionContext) => void;
  setTextScale: (value: number) => void;
  lobsterPetVisits: boolean;
  setLobsterPetVisits: (enabled: boolean) => void;
  lobsterPetSounds: boolean;
  setLobsterPetSounds: (enabled: boolean) => void;
  userAvatar?: string | null;
  onUserAvatarChange?: (next: string | null) => void;

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
  gatewayUrl: string;
  assistantName: string;
  assistantAvatar?: string | null;
  assistantAvatarUrl?: string | null;
  assistantAvatarSource?: string | null;
  assistantAvatarStatus?: "none" | "local" | "remote" | "data" | null;
  assistantAvatarReason?: string | null;
  assistantAvatarOverride?: string | null;
  assistantAvatarUploadBusy?: boolean;
  assistantAvatarUploadError?: string | null;
  onAssistantAvatarOverrideChange?: (dataUrl: string) => void | Promise<void>;
  onAssistantAvatarClearOverride?: () => void | Promise<void>;
  basePath?: string | null;
  version: string;
};

// ── Theme options ──

type ThemeOption = { id: ThemeName; labelKey: string };
const BUILTIN_THEME_OPTIONS: ThemeOption[] = [
  { id: "claw", labelKey: "quickSettings.appearance.themes.claw" },
  { id: "knot", labelKey: "quickSettings.appearance.themes.knot" },
  { id: "dash", labelKey: "quickSettings.appearance.themes.dash" },
];

const TEXT_SCALE_OPTIONS: Array<{ value: TextScaleStop; labelKey: string }> = [
  { value: 90, labelKey: "quickSettings.appearance.textSizes.small" },
  { value: 100, labelKey: "quickSettings.appearance.textSizes.medium" },
  { value: 110, labelKey: "quickSettings.appearance.textSizes.large" },
  { value: 125, labelKey: "quickSettings.appearance.textSizes.xl" },
  { value: 140, labelKey: "quickSettings.appearance.textSizes.xxl" },
];

const THINKING_LEVELS = ["off", "low", "medium", "high"];
const TOOL_PROFILES = ["minimal", "coding", "messaging", "full"];
// Keep raw uploads comfortably below the 2 MB persisted data URL limit after
// base64 expansion and a small MIME/header prefix are added.
const MAX_LOCAL_USER_AVATAR_FILE_BYTES = 1_500_000;
const MAX_ASSISTANT_AVATAR_UPLOAD_BYTES = MAX_LOCAL_USER_AVATAR_FILE_BYTES;

/** Section wrapper that keeps the stable settings-search scroll target ids. */
function renderTargetSection(
  id: string,
  props: SettingsSectionProps,
  rows: unknown,
): TemplateResult {
  return html`<div id=${id}>${renderSettingsSection(props, rows)}</div>`;
}

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

function resolveAssistantPreviewAvatarUrl(props: QuickSettingsProps): string | null {
  const override = normalizeOptionalString(props.assistantAvatarOverride);
  if (override) {
    return resolveChatAvatarRenderUrl(override, {
      identity: {
        avatar: override,
        avatarUrl: override,
      },
    });
  }
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
  status: QuickSettingsProps["assistantAvatarStatus"],
  reason: string | null | undefined,
  _rendered: boolean,
  hasOverride = false,
): string | null {
  if (hasOverride) {
    return null;
  }
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

function renderAssistantAvatarPreview(props: QuickSettingsProps) {
  const assistantName =
    normalizeOptionalString(props.assistantName) ?? t("quickSettings.personal.assistant");
  const assistantAvatarOverride = normalizeOptionalString(props.assistantAvatarOverride);
  const assistantAvatarUrl = resolveAssistantPreviewAvatarUrl(props);
  if (assistantAvatarUrl) {
    return html`<img
      class="config-identity__avatar"
      src=${assistantAvatarUrl}
      alt=${assistantName}
    />`;
  }
  const assistantAvatarText = resolveAssistantTextAvatar(
    assistantAvatarOverride ?? props.assistantAvatar,
  );
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
      src=${controlUiPublicAssetPath("apple-touch-icon.png", props.basePath ?? "")}
      alt=${assistantName}
    />
  `;
}

function handleLocalUserAvatarFileSelect(e: Event, props: QuickSettingsProps) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  const onUserAvatarChange = props.onUserAvatarChange;
  if (!file || !onUserAvatarChange) {
    input.value = "";
    return;
  }
  if (!file.type.startsWith("image/")) {
    input.value = "";
    return;
  }
  if (file.size > MAX_LOCAL_USER_AVATAR_FILE_BYTES) {
    input.value = "";
    return;
  }
  const reader = new FileReader();
  reader.addEventListener("load", () => {
    onUserAvatarChange(typeof reader.result === "string" ? reader.result : null);
  });
  reader.readAsDataURL(file);
  input.value = "";
}

function handleAssistantAvatarFileSelect(e: Event, props: QuickSettingsProps) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  const onAssistantAvatarOverrideChange = props.onAssistantAvatarOverrideChange;
  if (!file || !onAssistantAvatarOverrideChange) {
    input.value = "";
    return;
  }
  if (file.size > MAX_ASSISTANT_AVATAR_UPLOAD_BYTES) {
    input.value = "";
    return;
  }
  const reader = new FileReader();
  reader.addEventListener("load", () => {
    const result = typeof reader.result === "string" ? reader.result : "";
    if (result) {
      void onAssistantAvatarOverrideChange(result);
    }
  });
  reader.readAsDataURL(file);
  input.value = "";
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

function renderChannelsSection(props: QuickSettingsProps) {
  const rows =
    props.channels.length === 0
      ? renderSettingsEmpty(t("quickSettings.channels.empty"))
      : props.channels.map((ch) =>
          renderSettingsRow({
            title: ch.label,
            control: ch.connected
              ? renderSettingsStatus({ kind: "ok", label: ch.detail ?? t("common.connected") })
              : html`
                  <button class="btn" @click=${() => props.onChannelConfigure?.(ch.id)}>
                    ${t("quickSettings.channels.connect")}
                  </button>
                `,
          }),
        );
  return renderTargetSection(
    GENERAL_SETTINGS_TARGET_IDS.channels,
    { title: t("quickSettings.channels.title") },
    rows,
  );
}

function renderAutomationsSection(props: QuickSettingsProps) {
  const { cronJobCount, skillCount, mcpServerCount } = props.automation;
  const automationRow = (title: string, actionLabel: string, onClick?: () => void) =>
    renderSettingsRow({
      title,
      control: html`<button class="btn" @click=${onClick}>${actionLabel}</button>`,
    });
  return renderTargetSection(
    GENERAL_SETTINGS_TARGET_IDS.automations,
    { title: t("quickSettings.automation.title") },
    [
      automationRow(
        t(
          cronJobCount === 1
            ? "quickSettings.automation.scheduledTask"
            : "quickSettings.automation.scheduledTasks",
          { count: String(cronJobCount) },
        ),
        t("quickSettings.automation.manage"),
        props.onManageCron,
      ),
      automationRow(
        t(
          skillCount === 1
            ? "quickSettings.automation.installedSkill"
            : "quickSettings.automation.installedSkills",
          { count: String(skillCount) },
        ),
        t("quickSettings.automation.browse"),
        props.onBrowseSkills,
      ),
      automationRow(
        t(
          mcpServerCount === 1
            ? "quickSettings.automation.mcpServer"
            : "quickSettings.automation.mcpServers",
          { count: String(mcpServerCount) },
        ),
        t("quickSettings.automation.configure"),
        props.onConfigureMcp,
      ),
    ],
  );
}

function renderSecuritySection(props: QuickSettingsProps) {
  const { gatewayAuth, execPolicy, deviceAuth, browserEnabled, toolProfile } = props.security;
  const normalizedToolProfile = toolProfile.trim() || "full";
  const toolProfiles = TOOL_PROFILES.includes(normalizedToolProfile)
    ? TOOL_PROFILES
    : [...TOOL_PROFILES, normalizedToolProfile];
  const configBusy = isConfigBusy(props);

  return renderTargetSection(
    GENERAL_SETTINGS_TARGET_IDS.security,
    {
      title: t("quickSettings.security.title"),
      actions: html`
        <button class="btn" @click=${props.onSecurityConfigure}>
          ${t("quickSettings.security.configure")}
        </button>
      `,
    },
    [
      renderSettingsRow({
        title: t("quickSettings.security.gatewayAuth"),
        control: renderSettingsStatus({
          kind: gatewayAuth !== "none" ? "ok" : "warn",
          label: gatewayAuth,
        }),
      }),
      renderSettingsRow({
        title: t("quickSettings.security.execPolicy"),
        control: renderSettingsValue(execPolicy),
      }),
      renderSettingsToggleRow({
        title: t("quickSettings.security.browserEnabled"),
        checked: browserEnabled,
        disabled: configBusy,
        onChange: (enabled) => props.onBrowserEnabledToggle?.(enabled),
      }),
      renderSettingsRow({
        title: t("quickSettings.security.toolProfile"),
        stacked: true,
        control: renderSettingsSegmented({
          value: normalizedToolProfile,
          options: toolProfiles.map((profile) => ({ value: profile, label: profile })),
          disabled: configBusy,
          onChange: (profile) => props.onToolProfileChange?.(profile),
        }),
      }),
      renderSettingsRow({
        title: t("quickSettings.security.deviceAuth"),
        control: renderSettingsStatus({
          kind: deviceAuth ? "ok" : "warn",
          label: deviceAuth ? t("common.enabled") : t("common.disabled"),
        }),
      }),
      renderSettingsRow({
        title: t("nodes.pairing.title"),
        control: html`
          <button
            class="btn"
            title=${props.canPairDevice ? "" : t("nodes.pairing.adminRequired")}
            ?disabled=${!props.canPairDevice}
            @click=${props.onPairMobile}
          >
            ${icons.smartphone} ${t("nodes.pairing.button")}
          </button>
        `,
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

function renderAppearanceSection(props: QuickSettingsProps) {
  const importedThemeName = props.hasCustomTheme
    ? (props.customThemeLabel ?? t("quickSettings.appearance.importedTheme"))
    : t("quickSettings.appearance.import");
  const themeOptions: Array<{ value: ThemeName; label: string }> = [
    ...BUILTIN_THEME_OPTIONS.map((option) => ({ value: option.id, label: t(option.labelKey) })),
    ...(props.hasCustomTheme ? [{ value: "custom" as const, label: importedThemeName }] : []),
  ];
  return renderTargetSection(
    GENERAL_SETTINGS_TARGET_IDS.appearance,
    { title: t("quickSettings.appearance.title") },
    [
      renderSettingsRow({
        title: t("quickSettings.appearance.theme"),
        stacked: true,
        control: html`
          ${renderSettingsSegmented<ThemeName>({
            value: props.theme,
            options: themeOptions,
            onChange: (theme, element) => {
              if (theme !== props.theme) {
                props.setTheme(theme, { element });
              }
            },
          })}
          ${props.hasCustomTheme
            ? nothing
            : html`<button
                type="button"
                class="btn btn--sm"
                @click=${() => props.onOpenCustomThemeImport?.()}
              >
                ${importedThemeName}
              </button>`}
        `,
      }),
      renderSettingsRow({
        title: t("common.mode"),
        control: renderSettingsSegmented<ThemeMode>({
          value: props.themeMode,
          options: (["light", "dark", "system"] as ThemeMode[]).map((mode) => ({
            value: mode,
            label: t(`common.${mode}`),
          })),
          onChange: (mode, element) => {
            if (mode !== props.themeMode) {
              props.setThemeMode(mode, {
                element,
              });
            }
          },
        }),
      }),
      renderSettingsRow({
        title: t("quickSettings.appearance.textSize"),
        control: renderSettingsSegmented({
          value: String(props.textScale),
          options: TEXT_SCALE_OPTIONS.map((stop) => ({
            value: String(stop.value),
            label: t(stop.labelKey),
            title: `${stop.value}%`,
          })),
          onChange: (value) => props.setTextScale(Number(value)),
        }),
      }),
      renderSettingsToggleRow({
        title: t("quickSettings.appearance.lobsterVisits"),
        description: props.lobsterPetVisits
          ? t("quickSettings.appearance.lobsterVisitsOn")
          : t("quickSettings.appearance.lobsterVisitsOff"),
        checked: props.lobsterPetVisits,
        onChange: (enabled) => props.setLobsterPetVisits(enabled),
      }),
      renderSettingsToggleRow({
        title: t("quickSettings.appearance.lobsterSounds"),
        description: props.lobsterPetSounds
          ? t("quickSettings.appearance.lobsterSoundsOn")
          : t("quickSettings.appearance.lobsterSoundsOff"),
        checked: props.lobsterPetSounds,
        onChange: (enabled) => props.setLobsterPetSounds(enabled),
      }),
      renderSettingsRow({
        title: t("quickSettings.appearance.lobsterdex"),
        description: t("quickSettings.appearance.lobsterdexSeen", {
          seen: String(LOBSTER_PET_PALETTES.filter((p) => getLobsterdex().has(p.id)).length),
          total: String(LOBSTER_PET_PALETTES.length),
        }),
        stacked: true,
        control: html`
          <div class="lobsterdex">
            ${LOBSTER_PET_PALETTES.map((palette) => {
              const entry = getLobsterdexEntries().get(palette.id);
              const seen = entry !== undefined;
              const title = !seen
                ? "?"
                : entry.firstSeenAt !== null
                  ? t("quickSettings.appearance.lobsterdexFirstVisited", {
                      name: entry.name ?? palette.id,
                      date: new Date(entry.firstSeenAt).toLocaleDateString(),
                    })
                  : (entry.name ?? palette.id);
              return html`
                <span
                  class="lobsterdex__mini lobster-pet--palette-${palette.id} ${seen
                    ? ""
                    : "lobsterdex__mini--unseen"}"
                  style="--lob-shell:${palette.shell};--lob-claw:${palette.claw}"
                  title=${title}
                >
                  ${renderLobsterSvg(canonicalLobsterLook(palette), { standalone: true })}
                </span>
              `;
            })}
          </div>
        `,
      }),
    ],
  );
}

function renderPersonalSection(props: QuickSettingsProps) {
  const identity = normalizeLocalUserIdentity({
    name: null,
    avatar: props.userAvatar ?? null,
  });
  const avatarText = resolveLocalUserAvatarText(identity) ?? "";
  const assistantName =
    normalizeOptionalString(props.assistantName) ?? t("quickSettings.personal.assistant");
  const assistantAvatarUrl = resolveAssistantPreviewAvatarUrl(props);
  const assistantAvatarRendered = Boolean(
    assistantAvatarUrl ||
    resolveAssistantTextAvatar(props.assistantAvatarOverride ?? props.assistantAvatar),
  );
  const assistantAvatarOverride = normalizeOptionalString(props.assistantAvatarOverride);
  const assistantAvatarSource = formatAssistantAvatarSource(
    assistantAvatarOverride ?? props.assistantAvatarSource,
  );
  const assistantAvatarIssue = formatAssistantAvatarIssue(
    props.assistantAvatarStatus ?? null,
    props.assistantAvatarReason,
    assistantAvatarRendered,
    Boolean(assistantAvatarOverride),
  );
  const assistantAvatarSourceLabel = assistantAvatarOverride
    ? t("quickSettings.personal.uiOverride")
    : t("quickSettings.personal.configuredAvatar");
  const canOverrideAssistantAvatar = Boolean(props.onAssistantAvatarOverrideChange);
  const assistantAvatarSubtitle = assistantAvatarOverride
    ? t("quickSettings.personal.overrideFromSettings")
    : assistantAvatarIssue
      ? t("quickSettings.personal.fallbackAvatar")
      : assistantAvatarRendered
        ? t("quickSettings.personal.configuredAvatar")
        : t("quickSettings.personal.fallbackLogo");
  // Escape hatch: identity blocks lead with an avatar preview, which the
  // standard row anatomy (text left, one control right) cannot express.
  return renderTargetSection(
    GENERAL_SETTINGS_TARGET_IDS.personal,
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
                  props.onUserAvatarChange?.(value.trim() ? value : null);
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
                  props.onUserAvatarChange?.(null);
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
                  <span>${assistantAvatarSourceLabel}</span>
                  <code>${assistantAvatarSource}</code>
                </div>
              `
            : nothing}
          ${assistantAvatarIssue
            ? html`<div class="config-identity__issue">
                ${renderSettingsStatus({ kind: "warn", label: assistantAvatarIssue })}
              </div>`
            : nothing}
          ${canOverrideAssistantAvatar
            ? html`
                <div class="config-identity__repair">
                  <div class="config-identity__actions">
                    <label class="btn btn--sm">
                      ${props.assistantAvatarUploadBusy
                        ? t("common.saving")
                        : assistantAvatarOverride
                          ? t("quickSettings.personal.replaceImage")
                          : t("quickSettings.personal.chooseImage")}
                      <input
                        type="file"
                        accept="image/*"
                        hidden
                        ?disabled=${props.assistantAvatarUploadBusy === true}
                        @change=${(e: Event) => handleAssistantAvatarFileSelect(e, props)}
                      />
                    </label>
                    ${assistantAvatarOverride
                      ? html`
                          <button
                            type="button"
                            class="btn btn--sm btn--ghost"
                            ?disabled=${props.assistantAvatarUploadBusy === true}
                            @click=${() => {
                              void props.onAssistantAvatarClearOverride?.();
                            }}
                          >
                            ${t("quickSettings.personal.clearOverride")}
                          </button>
                        `
                      : nothing}
                  </div>
                  <div class="config-identity__hint muted">
                    ${t("quickSettings.personal.overrideHint")}
                  </div>
                </div>
              `
            : nothing}
          ${props.assistantAvatarUploadError
            ? html`<div class="config-identity__error">${props.assistantAvatarUploadError}</div>`
            : nothing}
        </div>
      </section>
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
    ${renderModelSection(props)} ${renderChannelsSection(props)} ${renderSecuritySection(props)}
    ${renderAutomationsSection(props)} ${renderGeneralSection(props)}
    ${renderAppearanceSection(props)} ${renderPersonalSection(props)} ${renderSystemSection(props)}
    ${renderConnectionFooter(props)}
  `);
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
