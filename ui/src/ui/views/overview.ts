import { html, nothing } from "lit";
import { t, i18n, SUPPORTED_LOCALES, type Locale, isSupportedLocale } from "../../i18n/index.ts";
import type { EventLogEntry } from "../app-events.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../external-link.ts";
import { formatRelativeTimestamp, formatDurationHuman } from "../format.ts";
import type { GatewayHelloOk } from "../gateway.ts";
import { icons } from "../icons.ts";
import type { UiSettings } from "../storage.ts";
import { normalizeLowercaseStringOrEmpty } from "../string-coerce.ts";
import type {
  AttentionItem,
  CronJob,
  CronStatus,
  ModelAuthStatusResult,
  SessionsListResult,
  SessionsUsageResult,
  SkillStatusReport,
} from "../types.ts";
import { renderConnectCommand } from "./connect-command.ts";
import { renderOverviewAttention } from "./overview-attention.ts";
import { renderOverviewCards } from "./overview-cards.ts";
import { renderOverviewEventLog } from "./overview-event-log.ts";
import {
  resolveAuthHintKind,
  shouldShowInsecureContextHint,
  shouldShowPairingHint,
} from "./overview-hints.ts";
import { renderOverviewLogTail } from "./overview-log-tail.ts";

export type OverviewProps = {
  connected: boolean;
  hello: GatewayHelloOk | null;
  settings: UiSettings;
  password: string;
  lastError: string | null;
  lastErrorCode: string | null;
  presenceCount: number;
  sessionsCount: number | null;
  cronEnabled: boolean | null;
  cronNext: number | null;
  lastChannelsRefresh: number | null;
  warnQueryToken: boolean;
  // New dashboard data
  modelAuthStatus: ModelAuthStatusResult | null;
  usageResult: SessionsUsageResult | null;
  sessionsResult: SessionsListResult | null;
  skillsReport: SkillStatusReport | null;
  cronJobs: CronJob[];
  cronStatus: CronStatus | null;
  attentionItems: AttentionItem[];
  eventLog: EventLogEntry[];
  overviewLogLines: string[];
  showGatewayToken: boolean;
  showGatewayPassword: boolean;
  onSettingsChange: (next: UiSettings) => void;
  onPasswordChange: (next: string) => void;
  onSessionKeyChange: (next: string) => void;
  onToggleGatewayTokenVisibility: () => void;
  onToggleGatewayPasswordVisibility: () => void;
  onConnect: () => void;
  onRefresh: () => void;
  onNavigate: (tab: string) => void;
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

  const pairingHint = (() => {
    if (!shouldShowPairingHint(props.connected, props.lastError, props.lastErrorCode)) {
      return null;
    }
    return html`
      <div class="muted" style="margin-top: 8px">
        ${t("overview.pairing.hint")}
        <div style="margin-top: 6px">
          <span class="mono">openclaw devices list</span><br />
          <span class="mono">openclaw devices approve &lt;requestId&gt;</span>
        </div>
        <div style="margin-top: 6px; font-size: 12px;">${t("overview.pairing.mobileHint")}</div>
        <div style="margin-top: 6px">
          <a
            class="session-link"
            href="https://docs.openclaw.ai/web/control-ui#device-pairing-first-connection"
            target=${EXTERNAL_LINK_TARGET}
            rel=${buildExternalLinkRel()}
            title="Device pairing docs (opens in new tab)"
            >Docs: Device pairing</a
          >
        </div>
      </div>
    `;
  })();

  const authHint = (() => {
    const authHintKind = resolveAuthHintKind({
      connected: props.connected,
      lastError: props.lastError,
      lastErrorCode: props.lastErrorCode,
      hasToken: Boolean(props.settings.token.trim()),
      hasPassword: Boolean(props.password.trim()),
    });
    if (authHintKind == null) {
      return null;
    }
    if (authHintKind === "required") {
      return html`
        <div class="muted" style="margin-top: 8px">
          ${t("overview.auth.required")}
          <div style="margin-top: 6px">
            <span class="mono">openclaw dashboard --no-open</span> → tokenized URL<br />
            <span class="mono">openclaw doctor --generate-gateway-token</span> → set token
          </div>
          <div style="margin-top: 6px">
            <a
              class="session-link"
              href="https://docs.openclaw.ai/web/dashboard"
              target=${EXTERNAL_LINK_TARGET}
              rel=${buildExternalLinkRel()}
              title="Control UI auth docs (opens in new tab)"
              >Docs: Control UI auth</a
            >
          </div>
        </div>
      `;
    }
    return html`
      <div class="muted" style="margin-top: 8px">
        ${t("overview.auth.failed", { command: "openclaw dashboard --no-open" })}
        <div style="margin-top: 6px">
          <a
            class="session-link"
            href="https://docs.openclaw.ai/web/dashboard"
            target=${EXTERNAL_LINK_TARGET}
            rel=${buildExternalLinkRel()}
            title="Control UI auth docs (opens in new tab)"
            >Docs: Control UI auth</a
          >
        </div>
      </div>
    `;
  })();

  const insecureContextHint = (() => {
    if (props.connected || !props.lastError) {
      return null;
    }
    const isSecureContext = typeof window !== "undefined" ? window.isSecureContext : true;
    if (isSecureContext) {
      return null;
    }
    if (!shouldShowInsecureContextHint(props.connected, props.lastError, props.lastErrorCode)) {
      return null;
    }
    return html`
      <div class="muted" style="margin-top: 8px">
        ${t("overview.insecure.hint", { url: "http://127.0.0.1:18789" })}
        <div style="margin-top: 6px">
          ${t("overview.insecure.stayHttp", {
            config: "gateway.controlUi.allowInsecureAuth: true",
          })}
        </div>
        <div style="margin-top: 6px">
          <a
            class="session-link"
            href="https://docs.openclaw.ai/gateway/tailscale"
            target=${EXTERNAL_LINK_TARGET}
            rel=${buildExternalLinkRel()}
            title="Tailscale Serve docs (opens in new tab)"
            >Docs: Tailscale Serve</a
          >
          <span class="muted"> · </span>
          <a
            class="session-link"
            href="https://docs.openclaw.ai/web/control-ui#insecure-http"
            target=${EXTERNAL_LINK_TARGET}
            rel=${buildExternalLinkRel()}
            title="Insecure HTTP docs (opens in new tab)"
            >Docs: Insecure HTTP</a
          >
        </div>
      </div>
    `;
  })();

  const queryTokenHint = (() => {
    if (props.connected || !props.lastError || !props.warnQueryToken) {
      return null;
    }
    const lower = normalizeLowercaseStringOrEmpty(props.lastError);
    const authFailed = lower.includes("unauthorized") || lower.includes("device identity required");
    if (!authFailed) {
      return null;
    }
    return html`
      <div class="muted" style="margin-top: 8px">
        Auth token must be passed as a URL fragment:
        <span class="mono">#token=&lt;token&gt;</span>. Query parameters (<span class="mono"
          >?token=</span
        >) may appear in server logs.
      </div>
    `;
  })();

  const currentLocale = isSupportedLocale(props.settings.locale)
    ? props.settings.locale
    : i18n.getLocale();

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
                props.onSettingsChange({
                  ...props.settings,
                  gatewayUrl: v,
                  token: v.trim() === props.settings.gatewayUrl.trim() ? props.settings.token : "",
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
                        props.onSettingsChange({ ...props.settings, token: v });
                      }}
                      placeholder="OPENCLAW_GATEWAY_TOKEN"
                    />
                    <button
                      type="button"
                      class="btn btn--icon ${props.showGatewayToken ? "active" : ""}"
                      style="flex-shrink: 0; width: 36px; height: 36px; box-sizing: border-box;"
                      title=${props.showGatewayToken ? "Hide token" : "Show token"}
                      aria-label="Toggle token visibility"
                      aria-pressed=${props.showGatewayToken}
                      @click=${props.onToggleGatewayTokenVisibility}
                    >
                      ${props.showGatewayToken ? icons.eye : icons.eyeOff}
                    </button>
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
                      placeholder="system or shared password"
                    />
                    <button
                      type="button"
                      class="btn btn--icon ${props.showGatewayPassword ? "active" : ""}"
                      style="flex-shrink: 0; width: 36px; height: 36px; box-sizing: border-box;"
                      title=${props.showGatewayPassword ? "Hide password" : "Show password"}
                      aria-label="Toggle password visibility"
                      aria-pressed=${props.showGatewayPassword}
                      @click=${props.onToggleGatewayPasswordVisibility}
                    >
                      ${props.showGatewayPassword ? icons.eye : icons.eyeOff}
                    </button>
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
          <label class="field">
            <span>${t("overview.access.language")}</span>
            <select
              .value=${currentLocale}
              @change=${(e: Event) => {
                const v = (e.target as HTMLSelectElement).value as Locale;
                void i18n.setLocale(v);
                props.onSettingsChange({ ...props.settings, locale: v });
              }}
            >
              ${SUPPORTED_LOCALES.map((loc) => {
                const key = loc.replace(/-([a-zA-Z])/g, (_, c) => c.toUpperCase());
                return html`<option value=${loc} ?selected=${currentLocale === loc}>
                  ${t(`languages.${key}`)}
                </option>`;
              })}
            </select>
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
        ${!props.connected
          ? html`
              <div class="login-gate__help" style="margin-top: 16px;">
                <div class="login-gate__help-title">${t("overview.connection.title")}</div>
                <ol class="login-gate__steps">
                  <li>
                    ${t("overview.connection.step1")}
                    ${renderConnectCommand("openclaw gateway run")}
                  </li>
                  <li>
                    ${t("overview.connection.step2")} ${renderConnectCommand("openclaw dashboard")}
                  </li>
                  <li>${t("overview.connection.step3")}</li>
                  <li>
                    ${t("overview.connection.step4")}<code
                      >openclaw doctor --generate-gateway-token</code
                    >
                  </li>
                </ol>
                <div class="login-gate__docs">
                  ${t("overview.connection.docsHint")}
                  <a
                    class="session-link"
                    href="https://docs.openclaw.ai/web/dashboard"
                    target="_blank"
                    rel="noreferrer"
                    >${t("overview.connection.docsLink")}</a
                  >
                </div>
              </div>
            `
          : nothing}
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
              ${pairingHint ?? ""} ${authHint ?? ""} ${insecureContextHint ?? ""}
              ${queryTokenHint ?? ""}
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
      presenceCount: props.presenceCount,
      onNavigate: props.onNavigate,
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
