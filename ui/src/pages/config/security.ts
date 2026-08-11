// Control UI Privacy & Security settings page presentation. Curated rows for
// the highest-impact policies sit above the schema-backed security/approvals
// section editor (same composition pattern as mcp.ts).
import { html, type TemplateResult } from "lit";
import { icons } from "../../components/icons.ts";
import {
  renderDocsLink,
  renderSettingsDefaultState,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsSegmented,
  renderSettingsStatus,
  renderSettingsToggleRow,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { PROFILE_OPTIONS } from "../../lib/agents/display.ts";

const SECURITY_DOCS_URL = "https://docs.openclaw.ai/gateway/security";

export type SecurityOverview = {
  gatewayAuth: string;
  execPolicy: string;
  deviceAuth: boolean;
  browserEnabled: boolean;
  browserEnabledOverridden: boolean;
  toolProfile: string;
  toolProfileOverridden: boolean;
};

type SecurityViewProps = {
  security: SecurityOverview;
  configBusy: boolean;
  canPairDevice: boolean;
  onPairMobile?: () => void;
  onBrowserEnabledToggle?: (enabled: boolean) => void;
  onBrowserEnabledReset?: () => void;
  onToolProfileChange?: (profile: string) => void;
  onToolProfileReset?: () => void;
  /** Embedded schema editor; it owns autosave status and the restart banner. */
  editor: TemplateResult;
};

function renderSecurityOverview(props: SecurityViewProps) {
  const {
    gatewayAuth,
    execPolicy,
    deviceAuth,
    browserEnabled,
    browserEnabledOverridden,
    toolProfile,
    toolProfileOverridden,
  } = props.security;
  const normalizedToolProfile = toolProfile.trim() || "full";
  const browserDefaultState = renderSettingsDefaultState({
    value: t("common.enabled"),
    overridden: browserEnabledOverridden,
    disabled: props.configBusy,
    onReset: () => props.onBrowserEnabledReset?.(),
  });
  const toolProfileDefaultState = renderSettingsDefaultState({
    value: t("agents.toolCatalog.profiles.full"),
    overridden: toolProfileOverridden,
    disabled: props.configBusy,
    onReset: () => props.onToolProfileReset?.(),
  });
  const profileOptions = PROFILE_OPTIONS.map((profile) => ({
    value: profile.id as string,
    label: t(profile.labelKey),
  }));
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
      description: browserDefaultState.description,
      checked: browserEnabled,
      disabled: props.configBusy,
      actions: browserDefaultState.action,
      onChange: (enabled) => props.onBrowserEnabledToggle?.(enabled),
    }),
    renderSettingsRow({
      title: t("quickSettings.security.toolProfile"),
      description: toolProfileDefaultState.description,
      stacked: true,
      control: html`
        ${toolProfileDefaultState.action}
        ${renderSettingsSegmented({
          value: normalizedToolProfile,
          options: profileOptions,
          disabled: props.configBusy,
          onChange: (profile) => props.onToolProfileChange?.(profile),
        })}
      `,
    }),
    renderSettingsRow({
      title: t("quickSettings.security.deviceAuth"),
      control: renderSettingsStatus({
        kind: deviceAuth ? "ok" : "warn",
        label: deviceAuth ? t("common.enabled") : t("common.disabled"),
      }),
    }),
    renderSettingsRow({
      title: t("devices.pairing.title"),
      control: html`
        <button
          class="btn"
          title=${props.canPairDevice ? "" : t("devices.pairing.adminRequired")}
          ?disabled=${!props.canPairDevice}
          @click=${props.onPairMobile}
        >
          ${icons.smartphone} ${t("devices.pairing.button")}
        </button>
      `,
    }),
  ]);
}

export function renderSecurity(props: SecurityViewProps) {
  return html`
    <section class="security-page">
      <div class="settings-page">
        <p class="settings-page__intro">
          ${t("quickSettings.security.intro")}
          ${renderDocsLink(SECURITY_DOCS_URL, t("common.learnMore"))}
        </p>
        ${renderSecurityOverview(props)}
      </div>
      ${props.editor}
    </section>
  `;
}
