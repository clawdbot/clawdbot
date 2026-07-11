// Control UI view renders overview screen content.
import { html } from "lit";
import type { EventLogEntry } from "../../api/event-log.ts";
import type { GatewayHelloOk } from "../../api/gateway.ts";
import type {
  AttentionItem,
  CronJob,
  CronStatus,
  ModelAuthStatusResult,
  SessionsListResult,
  SessionsUsageResult,
  SkillStatusReport,
} from "../../api/types.ts";
import type { NavigationRouteId } from "../../app-navigation.ts";
import { resolveGatewayTokenForUrlEdit, type UiSettings } from "../../app/settings.ts";
import "../../components/tooltip.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp, formatDurationHuman } from "../../lib/format.ts";
import { renderOverviewAttention } from "./attention.ts";
import { renderOverviewCards } from "./cards.ts";
import { renderOverviewEventLog } from "./event-log.ts";
import { renderOverviewLogTail } from "./log-tail.ts";

type OverviewProps = {
  connected: boolean;
  hello: GatewayHelloOk | null;
  settings: UiSettings;
  password: string;
  lastError: string | null;
  lastChannelsRefresh: number | null;
  modelAuthStatus: ModelAuthStatusResult | null;
  usageResult: SessionsUsageResult | null;
  sessionsResult: SessionsListResult | null;
  skillsReport: SkillStatusReport | null;
  cronJobs: CronJob[];
  cronStatus: CronStatus | null;
  attentionItems: AttentionItem[];
  eventLog: readonly EventLogEntry[];
  overviewLogLines: string[];
  showGatewayToken: boolean;
  showGatewayPassword: boolean;
  onConnectionChange: (patch: Partial<Pick<UiSettings, "gatewayUrl" | "token">>) => void;
  onPasswordChange: (next: string) => void;
  onSessionKeyChange: (next: string) => void;
  onToggleGatewayTokenVisibility: () => void;
  onToggleGatewayPasswordVisibility: () => void;
  onConnect: () => void;
  onRefresh: () => void;
  onNavigate: (routeId: NavigationRouteId) => void;
  canNavigate: (routeId: NavigationRouteId) => boolean;
  onRefreshLogs: () => void;
};

export function renderOverview(props: OverviewProps) {
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
  const authMode = snapshot?.authMode;
  const isTrustedProxy = authMode === "trusted-proxy";

  return html`
    <section class="grid">
      <div class="card">
        <div class="card-title">${t("overview.access.title")}</div>
        <div class="card-sub">${t("overview.access.subtitle")}</div>
        <div class="ov-access-grid" style="margin-top: 16px;">
          <label class="field ov-access-grid__full">
            <span>${t("overview.access.wsUrl")}</span>
            <input
              .value=${props.settings.gatewayUrl}
              @input=${(e: Event) => {
                const v = (e.target as HTMLInputElement).value;
                props.onConnectionChange({
                  gatewayUrl: v,
                  token: resolveGatewayTokenForUrlEdit(
                    props.settings.gatewayUrl,
                    v,
                    props.settings.token,
                  ),
                });
              }}
              placeholder="ws://100.x.y.z:18789"
            />
          </label>
          ${isTrustedProxy
            ? ""
            : html`
                <label class="field">
                  <span>${t("overview.access.token")}</span>
                  <div style="display: flex; align-items: center; gap: 8px; min-width: 0;">
                    <input
                      type=${props.showGatewayToken ? "text" : "password"}
                      autocomplete="off"
                      style="flex: 1 1 0%; min-width: 0; box-sizing: border-box;"
                      .value=${props.settings.token}
                      @input=${(e: Event) => {
                        const v = (e.target as HTMLInputElement).value;
                        props.onConnectionChange({ token: v });
                      }}
                      placeholder="OPENCLAW_GATEWAY_TOKEN"
                    />
                    <openclaw-tooltip
                      .content=${props.showGatewayToken
                        ? t("overview.access.hideToken")
                        : t("overview.access.showToken")}
                    >
                      <button
                        type="button"
                        class="btn btn--icon ${props.showGatewayToken ? "active" : ""}"
                        style="flex-shrink: 0; width: 36px; height: 36px; box-sizing: border-box;"
                        aria-label=${t("overview.access.toggleTokenVisibility")}
                        aria-pressed=${props.showGatewayToken}
                        @click=${props.onToggleGatewayTokenVisibility}
                      >
                        ${props.showGatewayToken ? icons.eye : icons.eyeOff}
                      </button>
                    </openclaw-tooltip>
                  </div>
                </label>
                <label class="field">
                  <span>${t("overview.access.password")}</span>
                  <div style="display: flex; align-items: center; gap: 8px; min-width: 0;">
                    <input
                      type=${props.showGatewayPassword ? "text" : "password"}
                      autocomplete="off"
                      style="flex: 1 1 0%; min-width: 0; width: 100%; box-sizing: border-box;"
                      .value=${props.password}
                      @input=${(e: Event) => {
                        const v = (e.target as HTMLInputElement).value;
                        props.onPasswordChange(v);
                      }}
                      placeholder=${t("overview.access.passwordPlaceholder")}
                    />
                    <openclaw-tooltip
                      .content=${props.showGatewayPassword
                        ? t("overview.access.hidePassword")
                        : t("overview.access.showPassword")}
                    >
                      <button
                        type="button"
                        class="btn btn--icon ${props.showGatewayPassword ? "active" : ""}"
                        style="flex-shrink: 0; width: 36px; height: 36px; box-sizing: border-box;"
                        aria-label=${t("overview.access.togglePasswordVisibility")}
                        aria-pressed=${props.showGatewayPassword}
                        @click=${props.onToggleGatewayPasswordVisibility}
                      >
                        ${props.showGatewayPassword ? icons.eye : icons.eyeOff}
                      </button>
                    </openclaw-tooltip>
                  </div>
                </label>
              `}
          <label class="field">
            <span>${t("overview.access.sessionKey")}</span>
            <input
              .value=${props.settings.sessionKey}
              @input=${(e: Event) => {
                const v = (e.target as HTMLInputElement).value;
                props.onSessionKeyChange(v);
              }}
            />
          </label>
        </div>
        <div class="row" style="margin-top: 14px;">
          <button class="btn" @click=${() => props.onConnect()}>${t("common.connect")}</button>
          <button class="btn" @click=${() => props.onRefresh()}>${t("common.refresh")}</button>
          <span class="muted"
            >${isTrustedProxy
              ? t("overview.access.trustedProxy")
              : t("overview.access.connectHint")}</span
          >
        </div>
      </div>

      <div class="card">
        <div class="card-title">${t("overview.snapshot.title")}</div>
        <div class="card-sub">${t("overview.snapshot.subtitle")}</div>
        <div class="stat-grid" style="margin-top: 16px;">
          <div class="stat">
            <div class="stat-label">${t("overview.snapshot.status")}</div>
            <div class="stat-value ${props.connected ? "ok" : "warn"}">
              ${props.connected ? t("common.ok") : t("common.offline")}
            </div>
          </div>
          <div class="stat">
            <div class="stat-label">${t("overview.snapshot.uptime")}</div>
            <div class="stat-value">${uptime}</div>
          </div>
          <div class="stat">
            <div class="stat-label">${t("overview.snapshot.tickInterval")}</div>
            <div class="stat-value">${tick}</div>
          </div>
          <div class="stat">
            <div class="stat-label">${t("overview.snapshot.lastChannelsRefresh")}</div>
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
          : html`
              <div class="callout" style="margin-top: 14px">
                ${t("overview.snapshot.channelsHint")}
              </div>
            `}
      </div>
    </section>

    <div class="ov-section-divider"></div>

    ${renderOverviewCards({
      usageResult: props.usageResult,
      sessionsResult: props.sessionsResult,
      skillsReport: props.skillsReport,
      cronJobs: props.cronJobs,
      cronStatus: props.cronStatus,
      modelAuthStatus: props.modelAuthStatus,
      onNavigate: props.onNavigate,
      canNavigate: props.canNavigate,
    })}
    ${renderOverviewAttention({ items: props.attentionItems })}

    <div class="ov-section-divider"></div>

    <div class="ov-bottom-grid">
      ${renderOverviewEventLog({
        events: props.eventLog,
      })}
      ${renderOverviewLogTail({
        lines: props.overviewLogLines,
        onRefreshLogs: props.onRefreshLogs,
      })}
    </div>
  `;
}
