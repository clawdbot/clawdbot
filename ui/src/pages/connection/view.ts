// Control UI view renders the gateway connection settings content.
import { html, nothing } from "lit";
import type { SystemInfoResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayHelloOk } from "../../api/gateway.ts";
import type { UiSettings } from "../../app/settings.ts";
import {
  renderSettingsPage,
  renderSettingsRow,
  renderSettingsSecretInput,
  renderSettingsSection,
  renderSettingsStatus,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { formatGatewayHost } from "../../lib/gateway-host.ts";
import { classifyGatewaySecret } from "../../lib/gateway-secret-shape.ts";
import { renderSystemSection } from "./system-section.ts";

registerSettingsEnglish();

type GatewayAuthMode = "none" | "token" | "password" | "trusted-proxy";

type ConnectionProps = {
  connected: boolean;
  hello: GatewayHelloOk | null;
  settings: UiSettings;
  /** URL of the live connection; the draft in `settings` may differ until Connect. */
  liveGatewayUrl: string;
  secret: string;
  lastError: string | null;
  systemInfo: SystemInfoResult | null;
  systemInfoUnavailable: boolean;
  /** True when the draft differs from the live connection. */
  dirty: boolean;
  showGatewaySecret: boolean;
  onConnectionChange: (patch: Partial<Pick<UiSettings, "gatewayUrl" | "token">>) => void;
  onSecretChange: (next: string) => void;
  onSessionKeyChange: (next: string) => void;
  onToggleGatewaySecretVisibility: () => void;
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

function renderSecretRow(props: ConnectionProps, authMode: GatewayAuthMode | undefined) {
  const hintKey =
    authMode === "password"
      ? "connection.access.passwordHint"
      : authMode === "token"
        ? "connection.access.tokenHint"
        : "connection.access.secretHint";
  return renderSettingsRow({
    title: t("connection.access.secret"),
    description: t(hintKey),
    control: html`<div class="settings-input-with-hint">
      ${renderSettingsSecretInput({
        ariaLabel: t("connection.access.secret"),
        value: props.secret,
        placeholder: t("connection.access.secretPlaceholder"),
        visible: props.showGatewaySecret,
        showLabel: t("connection.access.showSecret"),
        hideLabel: t("connection.access.hideSecret"),
        toggleLabel: t("connection.access.toggleSecretVisibility"),
        onInput: props.onSecretChange,
        onToggle: props.onToggleGatewaySecretVisibility,
      })}
      ${
        classifyGatewaySecret(props.secret) === "setup-code"
          ? html`<p class="settings-row__desc" role="status">
              ${t("connection.access.setupCodeHint")}
            </p>`
          : nothing
      }
    </div>`,
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
            title: t("connection.access.secret"),
            description: t("connection.access.trustedProxy"),
            control: renderSettingsStatus({
              kind: "ok",
              label: t("connection.access.trustedProxyStatus"),
            }),
          })
        : renderSecretRow(props, authMode)
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
