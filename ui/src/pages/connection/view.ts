// Control UI view renders the gateway connection settings content.
import { html } from "lit";
import type { GatewayHelloOk } from "../../api/gateway.ts";
import { resolveGatewayTokenForUrlEdit, type UiSettings } from "../../app/settings.ts";
import "../../components/tooltip.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { formatDurationHuman, formatRelativeTimestamp } from "../../lib/format.ts";

export type ConnectionProps = {
  connected: boolean;
  hello: GatewayHelloOk | null;
  settings: UiSettings;
  password: string;
  lastError: string | null;
  lastChannelsRefresh: number | null;
  showGatewayToken: boolean;
  showGatewayPassword: boolean;
  onConnectionChange: (patch: Partial<Pick<UiSettings, "gatewayUrl" | "token">>) => void;
  onPasswordChange: (next: string) => void;
  onSessionKeyChange: (next: string) => void;
  onToggleGatewayTokenVisibility: () => void;
  onToggleGatewayPasswordVisibility: () => void;
  onConnect: () => void;
  onRefresh: () => void;
};

function renderSecretField(params: {
  label: string;
  value: string;
  placeholder: string;
  visible: boolean;
  showLabel: string;
  hideLabel: string;
  toggleLabel: string;
  onInput: (next: string) => void;
  onToggle: () => void;
}) {
  return html`
    <label class="field">
      <span>${params.label}</span>
      <div class="connection-secret-row">
        <input
          type=${params.visible ? "text" : "password"}
          autocomplete="off"
          spellcheck="false"
          .value=${params.value}
          @input=${(e: Event) => params.onInput((e.target as HTMLInputElement).value)}
          placeholder=${params.placeholder}
        />
        <openclaw-tooltip .content=${params.visible ? params.hideLabel : params.showLabel}>
          <button
            type="button"
            class="btn btn--icon ${params.visible ? "active" : ""}"
            aria-label=${params.toggleLabel}
            aria-pressed=${params.visible}
            @click=${params.onToggle}
          >
            ${params.visible ? icons.eye : icons.eyeOff}
          </button>
        </openclaw-tooltip>
      </div>
    </label>
  `;
}

export function renderConnection(props: ConnectionProps) {
  const snapshot = props.hello?.snapshot as
    | {
        uptimeMs?: number;
        authMode?: "none" | "token" | "password" | "trusted-proxy";
      }
    | undefined;
  const uptime = snapshot?.uptimeMs ? formatDurationHuman(snapshot.uptimeMs) : t("common.na");
  const tickIntervalMs = props.hello?.policy?.tickIntervalMs;
  const tick = tickIntervalMs
    ? `${(tickIntervalMs / 1000).toFixed(tickIntervalMs % 1000 === 0 ? 0 : 1)}s`
    : t("common.na");
  const isTrustedProxy = snapshot?.authMode === "trusted-proxy";

  return html`
    <div class="card">
      <div class="card-title">${t("connection.access.title")}</div>
      <div class="card-sub">${t("connection.access.subtitle")}</div>
      <div class="connection-form-grid" style="margin-top: 16px;">
        <label class="field connection-form-grid__full">
          <span>${t("connection.access.wsUrl")}</span>
          <input
            .value=${props.settings.gatewayUrl}
            @input=${(e: Event) => {
              const settings = props.settings;
              const v = (e.target as HTMLInputElement).value;
              props.onConnectionChange({
                gatewayUrl: v,
                token: resolveGatewayTokenForUrlEdit(settings.gatewayUrl, v, settings.token),
              });
            }}
            placeholder="ws://100.x.y.z:18789"
          />
        </label>
        ${isTrustedProxy
          ? ""
          : html`
              ${renderSecretField({
                label: t("connection.access.token"),
                value: props.settings.token,
                placeholder: "OPENCLAW_GATEWAY_TOKEN",
                visible: props.showGatewayToken,
                showLabel: t("connection.access.showToken"),
                hideLabel: t("connection.access.hideToken"),
                toggleLabel: t("connection.access.toggleTokenVisibility"),
                onInput: (next) => props.onConnectionChange({ token: next }),
                onToggle: props.onToggleGatewayTokenVisibility,
              })}
              ${renderSecretField({
                label: t("connection.access.password"),
                value: props.password,
                placeholder: t("connection.access.passwordPlaceholder"),
                visible: props.showGatewayPassword,
                showLabel: t("connection.access.showPassword"),
                hideLabel: t("connection.access.hidePassword"),
                toggleLabel: t("connection.access.togglePasswordVisibility"),
                onInput: props.onPasswordChange,
                onToggle: props.onToggleGatewayPasswordVisibility,
              })}
            `}
        <label class="field">
          <span>${t("connection.access.sessionKey")}</span>
          <input
            .value=${props.settings.sessionKey}
            @input=${(e: Event) => props.onSessionKeyChange((e.target as HTMLInputElement).value)}
          />
        </label>
      </div>
      <div class="row" style="margin-top: 14px;">
        <button class="btn" @click=${() => props.onConnect()}>${t("common.connect")}</button>
        <button class="btn" @click=${() => props.onRefresh()}>${t("common.refresh")}</button>
        <span class="muted"
          >${isTrustedProxy
            ? t("connection.access.trustedProxy")
            : t("connection.access.connectHint")}</span
        >
      </div>
    </div>

    <div class="card" style="margin-top: 16px;">
      <div class="card-title">${t("connection.snapshot.title")}</div>
      <div class="card-sub">${t("connection.snapshot.subtitle")}</div>
      <div class="stat-grid" style="margin-top: 16px;">
        <div class="stat">
          <div class="stat-label">${t("connection.snapshot.status")}</div>
          <div class="stat-value ${props.connected ? "ok" : "warn"}">
            ${props.connected ? t("common.ok") : t("common.offline")}
          </div>
        </div>
        <div class="stat">
          <div class="stat-label">${t("connection.snapshot.uptime")}</div>
          <div class="stat-value">${uptime}</div>
        </div>
        <div class="stat">
          <div class="stat-label">${t("connection.snapshot.tickInterval")}</div>
          <div class="stat-value">${tick}</div>
        </div>
        <div class="stat">
          <div class="stat-label">${t("connection.snapshot.lastChannelsRefresh")}</div>
          <div class="stat-value">
            ${props.lastChannelsRefresh
              ? formatRelativeTimestamp(props.lastChannelsRefresh)
              : t("common.na")}
          </div>
        </div>
      </div>
      ${props.lastError
        ? html`<div class="callout danger" style="margin-top: 14px;">
            <div>${props.lastError}</div>
          </div>`
        : ""}
    </div>
  `;
}
