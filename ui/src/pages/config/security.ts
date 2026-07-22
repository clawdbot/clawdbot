// Control UI Privacy & Security settings page presentation. Curated rows for
// the highest-impact policies sit above the schema-backed security/approvals
// section editor (same composition pattern as mcp.ts).
import { html, type TemplateResult } from "lit";
import { icons } from "../../components/icons.ts";
import {
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsSegmented,
  renderSettingsStatus,
  renderSettingsToggleRow,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { PROFILE_OPTIONS } from "../../lib/agents/display.ts";

export type SecurityOverview = {
  gatewayAuth: string;
  execPolicy: string;
  deviceAuth: boolean;
  browserEnabled: boolean;
  toolProfile: string;
};

type SecurityViewProps = {
  security: SecurityOverview;
  toolProfiles: string[];
  configBusy: boolean;
  canPairDevice: boolean;
  onPairMobile?: () => void;
  onBrowserEnabledToggle?: (enabled: boolean) => void;
  onToolProfileChange?: (profile: string) => void;
  /** Embedded schema editor; it owns autosave status and the restart banner. */
  editor: TemplateResult;
};

function renderSecurityOverview(props: SecurityViewProps) {
  const { gatewayAuth, execPolicy, deviceAuth, browserEnabled, toolProfile } = props.security;
  const normalizedToolProfile = toolProfile.trim() || "full";
  const profileOptions = PROFILE_OPTIONS.map((profile) => ({
    value: profile.id as string,
    label: t(profile.labelKey),
  }));
  for (const profile of props.toolProfiles.toSorted((a, b) => a.localeCompare(b))) {
    if (!profileOptions.some((option) => option.value === profile)) {
      profileOptions.push({ value: profile, label: profile });
    }
  }
  if (!profileOptions.some((option) => option.value === normalizedToolProfile)) {
    profileOptions.push({ value: normalizedToolProfile, label: normalizedToolProfile });
  }
  return renderSettingsSection({ title: t("quickSettings.security.title") }, [
    renderSettingsRow({
      title: t("quickSettings.security.gatewayAuth"),
      control: renderSettingsStatus({
        // "unknown" is a pre-hello placeholder, not a healthy auth mode.
        kind: gatewayAuth === "none" ? "warn" : gatewayAuth === "unknown" ? "muted" : "ok",
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
      disabled: props.configBusy,
      onChange: (enabled) => props.onBrowserEnabledToggle?.(enabled),
    }),
    renderSettingsRow({
      title: t("quickSettings.security.toolProfile"),
      stacked: true,
      control: renderSettingsSegmented({
        value: normalizedToolProfile,
        options: profileOptions,
        disabled: props.configBusy,
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
  ]);
}

export function renderSecurity(props: SecurityViewProps) {
  return html`
    <section class="security-page">
      <div class="settings-page">${renderSecurityOverview(props)}</div>
      ${props.editor}
    </section>
  `;
}
