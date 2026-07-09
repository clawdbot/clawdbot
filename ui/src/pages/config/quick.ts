/**
 * Quick Settings view — opinionated card layout for the most common settings.
 * Replaces the raw schema-driven form as the default settings experience.
 *
 * Each card answers a "what do I want to do?" question with status + actions.
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
import { t } from "../../i18n/index.ts";
import { formatBytes } from "../../lib/agents/display.ts";
import { resolveAssistantTextAvatar, resolveChatAvatarRenderUrl } from "../../lib/avatar.ts";
import { formatDurationHuman } from "../../lib/format.ts";
import { normalizeOptionalString } from "../../lib/string-coerce.ts";

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

export type QuickSettingsProps = {
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
  userAvatar?: string | null;
  onUserAvatarChange?: (next: string | null) => void;

  // Pending config changes
  configDirty?: boolean;
  configSaving?: boolean;
  configApplying?: boolean;
  configReady?: boolean;
  onResetConfig?: () => void;
  onSaveConfig?: () => void;
  onApplyConfig?: () => void;

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

type ThemeOption = { id: ThemeName; label: string };
const BUILTIN_THEME_OPTIONS: ThemeOption[] = [
  { id: "claw", label: "Claw" },
  { id: "knot", label: "Knot" },
  { id: "dash", label: "Dash" },
];

const TEXT_SCALE_OPTIONS: Array<{ value: TextScaleStop; label: string }> = [
  { value: 90, label: "S" },
  { value: 100, label: "M" },
  { value: 110, label: "L" },
  { value: 125, label: "XL" },
  { value: 140, label: "XXL" },
];

const THINKING_LEVELS = ["off", "low", "medium", "high"];
const TOOL_PROFILES = ["minimal", "coding", "messaging", "full"];
const LOCAL_USER_LABEL = "You";
// Keep raw uploads comfortably below the 2 MB persisted data URL limit after
// base64 expansion and a small MIME/header prefix are added.
const MAX_LOCAL_USER_AVATAR_FILE_BYTES = 1_500_000;
const MAX_ASSISTANT_AVATAR_UPLOAD_BYTES = MAX_LOCAL_USER_AVATAR_FILE_BYTES;

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
  if (avatarUrl) {
    return html`<img class="qs-user-avatar" src=${avatarUrl} alt=${LOCAL_USER_LABEL} />`;
  }
  if (avatarText) {
    return html`<div class="qs-user-avatar qs-user-avatar--text" aria-label=${LOCAL_USER_LABEL}>
      ${avatarText}
    </div>`;
  }
  return html`
    <div class="qs-user-avatar qs-user-avatar--default" aria-label=${LOCAL_USER_LABEL}>
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
    return "Remote URLs are blocked by Control UI image policy";
  }
  if (reason === "missing") {
    return "File not found";
  }
  if (reason === "unsupported_extension") {
    return "Unsupported image type";
  }
  if (reason === "outside_workspace") {
    return "Outside workspace";
  }
  if (reason === "too_large") {
    return "Image is too large";
  }
  return reason ? "Cannot render avatar" : null;
}

function renderAssistantAvatarPreview(props: QuickSettingsProps) {
  const assistantName = normalizeOptionalString(props.assistantName) ?? "Assistant";
  const assistantAvatarOverride = normalizeOptionalString(props.assistantAvatarOverride);
  const assistantAvatarUrl = resolveAssistantPreviewAvatarUrl(props);
  if (assistantAvatarUrl) {
    return html`<img class="qs-assistant-avatar" src=${assistantAvatarUrl} alt=${assistantName} />`;
  }
  const assistantAvatarText = resolveAssistantTextAvatar(
    assistantAvatarOverride ?? props.assistantAvatar,
  );
  if (assistantAvatarText) {
    return html`<div
      class="qs-assistant-avatar qs-assistant-avatar--text"
      aria-label=${assistantName}
    >
      ${assistantAvatarText}
    </div>`;
  }
  return html`
    <img
      class="qs-assistant-avatar qs-assistant-avatar--fallback"
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

// ── Card renderers ──

function renderCardHeader(icon: TemplateResult, title: string, action?: TemplateResult) {
  return html`
    <div class="qs-card__header">
      <div class="qs-card__header-left">
        <span class="qs-card__icon">${icon}</span>
        <h3 class="qs-card__title">${title}</h3>
      </div>
      ${action ? action : nothing}
    </div>
  `;
}

function fastModeOptionValue(value: "auto" | "on" | "off"): FastMode {
  return value === "auto" ? "auto" : value === "on";
}

function renderModelCard(props: QuickSettingsProps) {
  const fastMode = formatFastModeValue(props.fastMode);
  return html`
    <div class="qs-card qs-card--model">
      ${renderCardHeader(icons.brain, "Model & Thinking")}
      <div class="qs-card__body">
        <div class="qs-row">
          <span class="qs-row__label">Model</span>
          <button class="qs-row__value qs-row__value--action" @click=${props.onModelChange}>
            <code>${props.currentModel || "default"}</code>
            <span class="qs-row__chevron">${icons.chevronRight}</span>
          </button>
        </div>
        <div class="qs-row">
          <span class="qs-row__label">Thinking</span>
          <div class="qs-segmented">
            ${THINKING_LEVELS.map(
              (level) => html`
                <button
                  class="qs-segmented__btn ${level === props.thinkingLevel
                    ? "qs-segmented__btn--active"
                    : ""}"
                  @click=${() => props.onThinkingChange?.(level)}
                >
                  ${level.charAt(0).toUpperCase() + level.slice(1)}
                </button>
              `,
            )}
          </div>
        </div>
        <div class="qs-row">
          <span class="qs-row__label">Fast mode</span>
          <div class="qs-segmented">
            ${(
              [
                ["auto", "Auto"],
                ["on", "Fast"],
                ["off", "Standard"],
              ] as const
            ).map(
              ([value, label]) => html`
                <button
                  class="qs-segmented__btn ${fastMode === value ? "qs-segmented__btn--active" : ""}"
                  @click=${() =>
                    fastMode === value
                      ? undefined
                      : props.onFastModeChange?.(fastModeOptionValue(value))}
                >
                  ${label}
                </button>
              `,
            )}
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderChannelsCard(props: QuickSettingsProps) {
  const connectedCount = props.channels.filter((c) => c.connected).length;
  const badge =
    connectedCount > 0
      ? html`<span class="qs-badge qs-badge--ok">${connectedCount} connected</span>`
      : undefined;

  return html`
    <div class="qs-card qs-card--channels">
      ${renderCardHeader(icons.send, "Channels", badge)}
      <div class="qs-card__body">
        ${props.channels.length === 0
          ? html`<div class="qs-empty muted">No channels configured</div>`
          : props.channels.map(
              (ch) => html`
                <div class="qs-row">
                  <span class="qs-row__label">
                    <span class="qs-status-dot ${ch.connected ? "qs-status-dot--ok" : ""}"></span>
                    ${ch.label}
                  </span>
                  <span class="qs-row__value">
                    ${ch.connected
                      ? html`<span class="muted">${ch.detail ?? "Connected"}</span>`
                      : html`<button
                          class="qs-link-btn"
                          @click=${() => props.onChannelConfigure?.(ch.id)}
                        >
                          Connect →
                        </button>`}
                  </span>
                </div>
              `,
            )}
      </div>
    </div>
  `;
}

function renderAutomationsCard(props: QuickSettingsProps) {
  const { cronJobCount, skillCount, mcpServerCount } = props.automation;

  return html`
    <div class="qs-card qs-card--automations">
      ${renderCardHeader(icons.zap, "Automations")}
      <div class="qs-card__body">
        <div class="qs-row">
          <span class="qs-row__label">
            ${cronJobCount} scheduled task${cronJobCount !== 1 ? "s" : ""}
          </span>
          <button class="qs-link-btn" @click=${props.onManageCron}>Manage →</button>
        </div>
        <div class="qs-row">
          <span class="qs-row__label">
            ${skillCount} skill${skillCount !== 1 ? "s" : ""} installed
          </span>
          <button class="qs-link-btn" @click=${props.onBrowseSkills}>Browse →</button>
        </div>
        <div class="qs-row">
          <span class="qs-row__label">
            ${mcpServerCount} MCP server${mcpServerCount !== 1 ? "s" : ""}
          </span>
          <button class="qs-link-btn" @click=${props.onConfigureMcp}>Configure →</button>
        </div>
      </div>
    </div>
  `;
}

function renderSecurityCard(props: QuickSettingsProps) {
  const { gatewayAuth, execPolicy, deviceAuth, browserEnabled, toolProfile } = props.security;
  const normalizedToolProfile = toolProfile.trim() || "full";
  const toolProfiles = TOOL_PROFILES.includes(normalizedToolProfile)
    ? TOOL_PROFILES
    : [...TOOL_PROFILES, normalizedToolProfile];

  return html`
    <div class="qs-card qs-card--security">
      ${renderCardHeader(
        icons.eye,
        "Security",
        html`<button class="qs-link-btn" @click=${props.onSecurityConfigure}>Configure →</button>`,
      )}
      <div class="qs-card__body">
        <div class="qs-row">
          <span class="qs-row__label">Gateway auth</span>
          <span class="qs-row__value">
            <span class="qs-badge ${gatewayAuth !== "none" ? "qs-badge--ok" : "qs-badge--warn"}"
              >${gatewayAuth}</span
            >
          </span>
        </div>
        <div class="qs-row">
          <span class="qs-row__label">Exec policy</span>
          <span class="qs-row__value"><span class="qs-badge">${execPolicy}</span></span>
        </div>
        <div class="qs-row">
          <span class="qs-row__label">${t("quickSettings.security.browserEnabled")}</span>
          <label class="qs-toggle">
            <input
              type="checkbox"
              .checked=${browserEnabled}
              @change=${(event: Event) =>
                props.onBrowserEnabledToggle?.((event.currentTarget as HTMLInputElement).checked)}
            />
            <span class="qs-toggle__track"></span>
            <span class="qs-toggle__hint muted">${browserEnabled ? "Enabled" : "Disabled"}</span>
          </label>
        </div>
        <div class="qs-row qs-row--stacked">
          <span class="qs-row__label">${t("quickSettings.security.toolProfile")}</span>
          <div class="qs-segmented">
            ${toolProfiles.map(
              (profile) => html`
                <button
                  class="qs-segmented__btn qs-segmented__btn--compact ${profile ===
                  normalizedToolProfile
                    ? "qs-segmented__btn--active"
                    : ""}"
                  @click=${() => props.onToolProfileChange?.(profile)}
                >
                  ${profile}
                </button>
              `,
            )}
          </div>
        </div>
        <div class="qs-row">
          <span class="qs-row__label">Device auth</span>
          <span class="qs-row__value">
            <span class="qs-badge ${deviceAuth ? "qs-badge--ok" : "qs-badge--warn"}"
              >${deviceAuth ? "Enabled" : "Disabled"}</span
            >
          </span>
        </div>
        <div class="qs-row">
          <span class="qs-row__label">${t("nodes.pairing.title")}</span>
          <button
            class="qs-row__value qs-row__value--action"
            title=${props.canPairDevice ? "" : t("nodes.pairing.adminRequired")}
            ?disabled=${!props.canPairDevice}
            @click=${props.onPairMobile}
          >
            ${icons.smartphone} ${t("nodes.pairing.button")}
          </button>
        </div>
      </div>
    </div>
  `;
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

// Meter tones reuse the badge palette: calm until 75%, warn to 92%, critical beyond.
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
      class="qs-meter"
      role="meter"
      aria-label="${label} usage"
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow=${percent}
    >
      <div
        class="qs-meter__fill qs-meter__fill--${systemMeterTone(clamped)}"
        style="--qs-meter-fill: ${percent}%"
      ></div>
    </div>
  `;
}

function renderSystemStat(stat: SystemStat) {
  return html`
    <div class="qs-stat" title=${stat.title ?? ""}>
      <div class="qs-stat__label">${stat.label}</div>
      <div class="qs-stat__value">
        ${stat.value}${stat.unit ? html` <span class="qs-stat__unit">${stat.unit}</span>` : nothing}
      </div>
      ${stat.usedFraction == null ? nothing : renderSystemMeter(stat.label, stat.usedFraction)}
      ${stat.detail ? html`<div class="qs-stat__detail">${stat.detail}</div>` : nothing}
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
    ? `Load average: ${info.loadAverage.map((value) => value.toFixed(1)).join(" · ")}`
    : undefined;
  const cpuTitle = [info.cpuModel, loadTitle].filter(Boolean).join(" · ") || undefined;
  const coresLabel = `${info.cpuCount} core${info.cpuCount === 1 ? "" : "s"}`;
  const cpu: SystemStat =
    load == null
      ? { label: "CPU", value: coresLabel, detail: info.cpuModel, title: cpuTitle }
      : {
          label: "CPU",
          value: load.toFixed(1),
          unit: "load",
          detail: coresLabel,
          // 1-minute load over core count approximates saturation; >100% clamps full.
          usedFraction: info.cpuCount > 0 ? load / info.cpuCount : undefined,
          title: cpuTitle,
        };
  const memoryUsed = usedFraction(info.memoryTotalBytes, info.memoryFreeBytes);
  const memory: SystemStat = {
    label: "Memory",
    value: memoryUsed == null ? "—" : formatUsedPercent(memoryUsed),
    unit: memoryUsed == null ? undefined : "used",
    detail: `${formatBytes(info.memoryFreeBytes)} free of ${formatBytes(info.memoryTotalBytes)}`,
    usedFraction: memoryUsed,
  };
  const stats = [cpu, memory];
  const diskUsed = usedFraction(info.diskTotalBytes, info.diskAvailableBytes);
  // Disk info is optional in the protocol; skip the tile instead of showing an empty gauge.
  if (diskUsed != null) {
    stats.push({
      label: "Disk",
      value: formatUsedPercent(diskUsed),
      unit: "used",
      detail: `${formatBytes(info.diskAvailableBytes)} free of ${formatBytes(info.diskTotalBytes)}`,
      usedFraction: diskUsed,
      title: info.diskPath,
    });
  }
  return stats;
}

const SYSTEM_STATS_PLACEHOLDER: SystemStat[] = [
  { label: "CPU", value: "—" },
  { label: "Memory", value: "—" },
  { label: "Disk", value: "—" },
];

function renderSystemCard(props: QuickSettingsProps) {
  if (props.systemInfoUnavailable) {
    return nothing;
  }
  const info = props.systemInfo;
  const placeholder = "—";
  const hostTitle = info && info.hostname !== info.machineName ? info.hostname : undefined;
  const address = info?.lanAddress
    ? `${info.lanAddress}${info.port == null ? "" : `:${info.port}`}`
    : undefined;
  const stats = info ? buildSystemStats(info) : SYSTEM_STATS_PLACEHOLDER;

  return html`
    <div class="qs-card qs-card--system">
      ${renderCardHeader(
        icons.monitor,
        "Gateway Host",
        info
          ? html`<span class="qs-badge qs-badge--ok"
              >Up ${formatDurationHuman(info.uptimeMs)}</span
            >`
          : undefined,
      )}
      <div class="qs-card__body qs-system">
        <div class="qs-system__identity">
          <div class="qs-system__name" title=${hostTitle ?? ""}>
            ${info?.machineName ?? placeholder}
          </div>
          <div class="qs-system__meta">
            ${info ? `${info.osLabel} · ${info.arch}` : placeholder}
          </div>
          <div class="qs-system__meta">
            ${info ? `Node ${info.nodeVersion} · PID ${info.pid}` : placeholder}
          </div>
          ${address ? html`<code class="qs-system__address">${address}</code>` : nothing}
        </div>
        <div class="qs-system__stats">${stats.map(renderSystemStat)}</div>
      </div>
    </div>
  `;
}

function renderAppearanceCard(props: QuickSettingsProps) {
  const importedThemeName = props.hasCustomTheme
    ? (props.customThemeLabel ?? "Imported theme")
    : "Import";
  const themeOptions: ThemeOption[] = [
    ...BUILTIN_THEME_OPTIONS,
    { id: "custom", label: importedThemeName },
  ];
  return html`
    <div class="qs-card qs-card--appearance">
      ${renderCardHeader(icons.spark, "Appearance")}
      <div class="qs-card__body qs-appearance">
        <div class="qs-row qs-row--stacked">
          <span class="qs-row__label">Theme</span>
          <div class="qs-segmented">
            ${themeOptions.map(
              (opt) => html`
                <button
                  class="qs-segmented__btn ${opt.id === props.theme
                    ? "qs-segmented__btn--active"
                    : ""}"
                  @click=${(e: Event) => {
                    if (opt.id === "custom" && !props.hasCustomTheme) {
                      props.onOpenCustomThemeImport?.();
                      return;
                    }
                    if (opt.id !== props.theme) {
                      props.setTheme(opt.id, {
                        element: (e.currentTarget as HTMLElement) ?? undefined,
                      });
                    }
                  }}
                >
                  ${opt.label}
                </button>
              `,
            )}
          </div>
        </div>
        <div class="qs-row qs-row--stacked">
          <span class="qs-row__label">Mode</span>
          <div class="qs-segmented">
            ${(["light", "dark", "system"] as ThemeMode[]).map(
              (mode) => html`
                <button
                  class="qs-segmented__btn ${mode === props.themeMode
                    ? "qs-segmented__btn--active"
                    : ""}"
                  @click=${(e: Event) => {
                    if (mode !== props.themeMode) {
                      props.setThemeMode(mode, {
                        element: (e.currentTarget as HTMLElement) ?? undefined,
                      });
                    }
                  }}
                >
                  ${mode.charAt(0).toUpperCase() + mode.slice(1)}
                </button>
              `,
            )}
          </div>
        </div>
        <div class="qs-row qs-row--stacked">
          <span class="qs-row__label">Text size</span>
          <div class="qs-segmented">
            ${TEXT_SCALE_OPTIONS.map(
              (stop) => html`
                <button
                  class="qs-segmented__btn ${stop.value === props.textScale
                    ? "qs-segmented__btn--active"
                    : ""}"
                  title=${`${stop.value}%`}
                  @click=${() => props.setTextScale(stop.value)}
                >
                  ${stop.label}
                </button>
              `,
            )}
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderPersonalCard(props: QuickSettingsProps) {
  const identity = normalizeLocalUserIdentity({
    name: null,
    avatar: props.userAvatar ?? null,
  });
  const avatarText = resolveLocalUserAvatarText(identity) ?? "";
  const assistantName = normalizeOptionalString(props.assistantName) ?? "Assistant";
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
  const assistantAvatarSourceLabel = assistantAvatarOverride ? "UI override" : "IDENTITY.md";
  const canOverrideAssistantAvatar = Boolean(props.onAssistantAvatarOverrideChange);
  const assistantAvatarSubtitle = assistantAvatarOverride
    ? "Override from settings"
    : assistantAvatarIssue
      ? "Fallback avatar"
      : assistantAvatarRendered
        ? "From IDENTITY.md"
        : "Fallback logo";
  return html`
    <div class="qs-card qs-card--personal">
      ${renderCardHeader(icons.image, "Personal")}
      <div class="qs-card__body">
        <div class="qs-identity-grid">
          <section class="qs-identity-card" aria-label="Your local chat identity">
            ${renderLocalUserAvatarPreview(props.userAvatar)}
            <div class="qs-identity-card__copy">
              <div class="qs-identity-card__eyebrow">User</div>
              <div class="qs-identity-card__title">${LOCAL_USER_LABEL}</div>
              <div class="qs-identity-card__repair">
                <label class="qs-field">
                  <span class="qs-row__label">Avatar text / emoji</span>
                  <input
                    class="qs-field__input"
                    type="text"
                    maxlength="16"
                    .value=${avatarText}
                    placeholder="JD or 🦞"
                    @input=${(e: Event) => {
                      const value = (e.target as HTMLInputElement).value;
                      props.onUserAvatarChange?.(value.trim() ? value : null);
                    }}
                  />
                </label>
                <div class="qs-identity-card__actions">
                  <label class="btn btn--sm">
                    Choose image
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
                    Clear avatar
                  </button>
                </div>
                <div class="muted">Stored in this browser only.</div>
              </div>
            </div>
          </section>
          <section
            class="qs-identity-card qs-identity-card--assistant"
            aria-label="Assistant identity"
          >
            ${renderAssistantAvatarPreview(props)}
            <div class="qs-identity-card__copy">
              <div class="qs-identity-card__eyebrow">Assistant</div>
              <div class="qs-identity-card__title">${assistantName}</div>
              <div class="qs-identity-card__sub">${assistantAvatarSubtitle}</div>
              ${assistantAvatarSource
                ? html`
                    <div
                      class="qs-identity-card__source"
                      title=${props.assistantAvatarSource ?? ""}
                    >
                      <span>${assistantAvatarSourceLabel}</span>
                      <code>${assistantAvatarSource}</code>
                    </div>
                  `
                : nothing}
              ${assistantAvatarIssue
                ? html`<div class="qs-identity-card__issue">${assistantAvatarIssue}</div>`
                : nothing}
              ${canOverrideAssistantAvatar
                ? html`
                    <div class="qs-identity-card__repair">
                      <div class="qs-identity-card__actions">
                        <label class="btn btn--sm">
                          ${props.assistantAvatarUploadBusy
                            ? "Saving..."
                            : assistantAvatarOverride
                              ? "Replace image"
                              : "Choose image"}
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
                                Clear override
                              </button>
                            `
                          : nothing}
                      </div>
                      <div class="muted">
                        Stores a Control UI override. Clear it to return to IDENTITY.md.
                      </div>
                    </div>
                  `
                : nothing}
              ${props.assistantAvatarUploadError
                ? html`<div class="qs-identity-card__error">
                    ${props.assistantAvatarUploadError}
                  </div>`
                : nothing}
            </div>
          </section>
        </div>
      </div>
    </div>
  `;
}

function renderPendingChangesBar(props: QuickSettingsProps) {
  if (props.configDirty !== true) {
    return nothing;
  }
  const canCommit =
    props.connected &&
    props.configReady === true &&
    props.configSaving !== true &&
    props.configApplying !== true;

  return html`
    <div class="qs-card qs-card--span-all qs-pending" aria-live="polite">
      <div class="qs-pending__copy">
        <span class="qs-pending__label">Unsaved changes</span>
        <span class="qs-pending__hint muted"
          >Save stores your changes. Apply Now also reloads the current session.</span
        >
      </div>
      <div class="qs-pending__actions">
        <button
          class="btn btn--sm"
          ?disabled=${props.configSaving === true || props.configApplying === true}
          @click=${props.onResetConfig}
        >
          Discard
        </button>
        <button class="btn btn--sm primary" ?disabled=${!canCommit} @click=${props.onSaveConfig}>
          ${props.configSaving === true ? "Saving…" : "Save"}
        </button>
        <button class="btn btn--sm" ?disabled=${!canCommit} @click=${props.onApplyConfig}>
          ${props.configApplying === true ? "Applying…" : "Apply Now"}
        </button>
      </div>
    </div>
  `;
}

function renderConnectionFooter(props: QuickSettingsProps) {
  return html`
    <div class="qs-footer">
      <div class="qs-footer__row">
        <span class="qs-status-dot ${props.connected ? "qs-status-dot--ok" : ""}"></span>
        <span class="muted">${props.connected ? "Connected" : "Offline"}</span>
        ${props.assistantName ? html`<span class="muted">· ${props.assistantName}</span>` : nothing}
        ${props.version ? html`<span class="muted">· v${props.version}</span>` : nothing}
      </div>
    </div>
  `;
}

// ── Main render ──

export function renderQuickSettings(props: QuickSettingsProps) {
  return html`
    <div class="qs-container">
      <div class="qs-grid">
        ${renderModelCard(props)} ${renderChannelsCard(props)} ${renderSecurityCard(props)}
        ${renderSystemCard(props)} ${renderAppearanceCard(props)} ${renderPersonalCard(props)}
        ${renderAutomationsCard(props)} ${renderPendingChangesBar(props)}
      </div>

      ${renderConnectionFooter(props)}
    </div>
  `;
}
