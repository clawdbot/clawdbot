// Control UI view renders the gateway connection settings content.
import { html, nothing } from "lit";
import type { SystemInfoResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayHelloOk } from "../../api/gateway.ts";
import type { UiSettings } from "../../app/settings.ts";
import {
  type CredentialMode,
  renderCredentialModeSwitch,
} from "../../components/credential-mode.ts";
import { formatGatewayHost } from "../../components/login-gate-feedback.ts";
import {
  renderSettingsPage,
  renderSettingsRow,
  renderSettingsSecretInput,
  renderSettingsSection,
  renderSettingsStatus,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { renderSystemSection } from "./system-section.ts";

type GatewayAuthMode = "none" | "token" | "password" | "trusted-proxy";

type ConnectionProps = {
  connected: boolean;
  hello: GatewayHelloOk | null;
  settings: UiSettings;
  /** URL of the live connection; the draft in `settings` may differ until Connect. */
  liveGatewayUrl: string;
  password: string;
  lastError: string | null;
  systemInfo: SystemInfoResult | null;
  systemInfoUnavailable: boolean;
  credentialMode: CredentialMode;
  /** True when the draft differs from the live connection. */
  dirty: boolean;
  showGatewayToken: boolean;
  showGatewayPassword: boolean;
  onConnectionChange: (patch: Partial<Pick<UiSettings, "gatewayUrl" | "token">>) => void;
  onPasswordChange: (next: string) => void;
  onCredentialModeChange: (mode: CredentialMode) => void;
  onSessionKeyChange: (next: string) => void;
  onToggleGatewayTokenVisibility: () => void;
  onToggleGatewayPasswordVisibility: () => void;
  onConnect: () => void;
};

const AUTH_MODE_KEYS: Record<GatewayAuthMode, string> = {
  none: "connection.access.auth.none",
  token: "connection.access.auth.token",
  password: "connection.access.auth.password",
  "trusted-proxy": "connection.access.auth.trustedProxy",
};

function formatTick(tickIntervalMs: number | undefined): string | null {
  if (!tickIntervalMs) {
    return null;
  }
  const seconds = tickIntervalMs / 1000;
  return `${seconds.toFixed(tickIntervalMs % 1000 === 0 ? 0 : 1)}s`;
}

/** Folds the old handshake "Snapshot" table into one line under the section heading. */
function describeConnection(props: ConnectionProps, authMode: GatewayAuthMode | undefined) {
  if (!props.connected) {
    return t("connection.access.descriptionOffline");
  }
  const facts = [
    t("connection.access.connectedTo", { host: formatGatewayHost(props.liveGatewayUrl) }),
    authMode ? t(AUTH_MODE_KEYS[authMode]) : null,
  ];
  const tick = formatTick(props.hello?.policy?.tickIntervalMs);
  if (tick) {
    facts.push(t("connection.access.tick", { tick }));
  }
  return facts.filter(Boolean).join(" · ");
}

function renderCredentialRow(props: ConnectionProps) {
  const isPassword = props.credentialMode === "password";
  const control = html`
    <div class="connection-credential">
      ${renderCredentialModeSwitch({
        mode: props.credentialMode,
        onChange: props.onCredentialModeChange,
        variant: "settings",
      })}
      ${renderSettingsSecretInput({
        ariaLabel: t("connection.access.credential"),
        value: isPassword ? props.password : props.settings.token,
        placeholder: isPassword ? t("login.passwordFieldPlaceholder") : t("login.tokenPlaceholder"),
        visible: isPassword ? props.showGatewayPassword : props.showGatewayToken,
        showLabel: t(isPassword ? "connection.access.showPassword" : "connection.access.showToken"),
        hideLabel: t(isPassword ? "connection.access.hidePassword" : "connection.access.hideToken"),
        toggleLabel: t(
          isPassword
            ? "connection.access.togglePasswordVisibility"
            : "connection.access.toggleTokenVisibility",
        ),
        onInput: (next) => {
          // Editing pins the visible mode so a cleared token cannot flip the field.
          props.onCredentialModeChange(props.credentialMode);
          if (isPassword) {
            props.onPasswordChange(next);
          } else {
            props.onConnectionChange({ token: next });
          }
        },
        onToggle: isPassword
          ? props.onToggleGatewayPasswordVisibility
          : props.onToggleGatewayTokenVisibility,
      })}
    </div>
  `;
  return renderSettingsRow({
    title: t("connection.access.credential"),
    description: t(isPassword ? "connection.access.passwordHint" : "connection.access.tokenHint"),
    control,
    stackedOnNarrow: true,
  });
}

export function renderConnection(props: ConnectionProps) {
  const snapshot = props.hello?.snapshot as { authMode?: GatewayAuthMode } | undefined;
  const authMode = snapshot?.authMode;
  const isTrustedProxy = authMode === "trusted-proxy";

  const rows = html`
    ${renderSettingsRow({
      title: t("connection.access.gatewayUrl"),
      description: t("connection.access.gatewayUrlHint"),
      control: html`
        <input
          class="settings-input"
          aria-label=${t("connection.access.gatewayUrl")}
          inputmode="url"
          autocapitalize="none"
          autocorrect="off"
          autocomplete="off"
          spellcheck="false"
          .value=${props.settings.gatewayUrl}
          @input=${(e: Event) => {
            props.onConnectionChange({ gatewayUrl: (e.target as HTMLInputElement).value });
          }}
          placeholder="wss://gateway.example:443"
        />
      `,
    })}
    ${
      isTrustedProxy
        ? renderSettingsRow({
            title: t("connection.access.credential"),
            description: t("connection.access.trustedProxy"),
            control: renderSettingsStatus({
              kind: "ok",
              label: t("connection.access.trustedProxyStatus"),
            }),
          })
        : renderCredentialRow(props)
    }
    ${renderSettingsRow({
      title: t("connection.access.sessionKey"),
      description: t("connection.access.sessionKeyHint"),
      control: html`
        <input
          class="settings-input"
          aria-label=${t("connection.access.sessionKey")}
          .value=${props.settings.sessionKey}
          @input=${(e: Event) => props.onSessionKeyChange((e.target as HTMLInputElement).value)}
        />
      `,
    })}
    ${
      !props.connected && props.lastError
        ? renderSettingsRow({
            title: renderSettingsStatus({
              kind: "danger",
              label: t("connection.access.lastError"),
            }),
            description: props.lastError,
          })
        : nothing
    }
    <div class="settings-row">
      <div class="settings-row__text">
        <span class="settings-row__desc">
          ${props.dirty ? t("connection.access.unsavedHint") : nothing}
        </span>
      </div>
      <div class="settings-row__control">
        <button class=${props.dirty ? "btn primary" : "btn"} @click=${() => props.onConnect()}>
          ${t("common.connect")}
        </button>
      </div>
    </div>
  `;

  return renderSettingsPage([
    renderSettingsSection(
      {
        title: t("connection.access.title"),
        description: describeConnection(props, authMode),
        actions: renderSettingsStatus({
          kind: props.connected ? "ok" : "warn",
          label: props.connected
            ? t("connection.access.status.connected")
            : t("connection.access.status.offline"),
        }),
      },
      rows,
    ),
    renderSystemSection(props),
  ]);
}
