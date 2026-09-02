import type { EnvironmentSummary, WorkerDesktopAppId } from "@openclaw/gateway-protocol";
import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../i18n/index.ts";
import { icons } from "../icons.ts";
import { renderPanelLoadingSkeleton } from "../panel-loading-skeleton.ts";
import { desktopAppIcon, desktopAppLabel } from "./desktop-app-presentation.ts";
import type { DesktopPanelState } from "./desktop-panel-state.ts";
import { desktopSourceForEnvironment } from "./desktop-source.ts";

export function renderDesktopPanelHeader(options: {
  dock: "bottom" | "right";
  fullscreenControl: TemplateResult;
  onClose: () => void;
  onDock: (dock: "bottom" | "right") => void;
  onOpenWindow: () => void;
}) {
  return html`
    <header class="rail-header bp-header">
      <div class="rail-header__title bp-title">${t("desktop.title")}</div>
      <div class="rail-header__actions bp-actions">
        <button
          class="rail-header__action bp-icon ${options.dock === "bottom" ? "is-active" : ""}"
          type="button"
          title=${t("desktop.dockBottom")}
          aria-label=${t("desktop.dockBottom")}
          @click=${() => options.onDock("bottom")}
        >
          ${icons.panelBottomOpen}
        </button>
        <button
          class="rail-header__action bp-icon ${options.dock === "right" ? "is-active" : ""}"
          type="button"
          title=${t("desktop.dockRight")}
          aria-label=${t("desktop.dockRight")}
          @click=${() => options.onDock("right")}
        >
          ${icons.panelRightOpen}
        </button>
        <button
          class="rail-header__action bp-icon bp-open-window"
          type="button"
          title=${t("desktop.openWindow")}
          aria-label=${t("desktop.openWindow")}
          @click=${options.onOpenWindow}
        >
          ${icons.externalLink}
        </button>
        ${options.fullscreenControl}
        <button
          class="rail-header__action bp-icon"
          type="button"
          title=${t("desktop.hide")}
          aria-label=${t("desktop.hide")}
          @click=${options.onClose}
        >
          ${icons.x}
        </button>
      </div>
    </header>
  `;
}

export function renderDesktopPicker(options: {
  environments: EnvironmentSummary[];
  loading: boolean;
  onConnect: (environmentId: string) => void;
  onRefresh: () => void;
}) {
  return html`
    <div class="desktop-toolbar">
      <span>${t("desktop.pickerTitle")}</span>
      <span class="desktop-toolbar__spacer"></span>
      <button
        class="desktop-button"
        type="button"
        ?disabled=${options.loading}
        @click=${options.onRefresh}
      >
        ${options.loading ? t("desktop.refreshing") : t("desktop.refresh")}
      </button>
    </div>
    <div class="desktop-picker">
      ${options.loading && options.environments.length === 0
        ? renderPanelLoadingSkeleton("desktop", t("desktop.loading"))
        : options.environments.length === 0
          ? html`<div class="desktop-status">${t("desktop.empty")}</div>`
          : options.environments.map((environment) =>
              renderDesktopEnvironment(environment, options.onConnect),
            )}
    </div>
  `;
}

function renderDesktopEnvironment(
  environment: EnvironmentSummary,
  onConnect: (environmentId: string) => void,
) {
  const worker = environment.worker;
  const source = desktopSourceForEnvironment(environment);
  return html`
    <div class="desktop-environment">
      <div class="desktop-environment__details">
        <div class="desktop-environment__id">
          ${source.kind === "host" ? t("desktop.thisMachine") : environment.id}
        </div>
        <div class="desktop-environment__meta">
          <span>${worker?.state ?? environment.status}</span>
        </div>
        ${worker && worker.attachedSessionIds.length > 0
          ? html`<div class="desktop-environment__sessions">
              ${worker.attachedSessionIds.map(
                (sessionId) => html`<span class="desktop-session">${sessionId}</span>`,
              )}
            </div>`
          : nothing}
      </div>
      <button
        class="desktop-button desktop-button--primary"
        type="button"
        @click=${() => onConnect(environment.id)}
      >
        ${t("desktop.connect")}
      </button>
    </div>
  `;
}

export function renderDesktopCredentials(options: {
  ardAccount: boolean;
  username: string;
  onSubmit: (event: SubmitEvent) => void;
}) {
  return html`
    <div class="desktop-status">
      <form class="desktop-credentials" @submit=${options.onSubmit}>
        <div>${t(options.ardAccount ? "desktop.accountPrompt" : "desktop.passwordPrompt")}</div>
        ${options.ardAccount
          ? html`<label class="desktop-credentials__label">
              ${t("desktop.usernameLabel")}
              <input
                class="desktop-credentials__input"
                name="username"
                type="text"
                autocomplete="off"
                .value=${options.username}
                required
              />
            </label>`
          : nothing}
        <label class="desktop-credentials__label">
          ${t(options.ardAccount ? "desktop.accountPasswordLabel" : "desktop.passwordLabel")}
          <input
            class="desktop-credentials__input"
            name="password"
            type="password"
            autocomplete="off"
            required
          />
        </label>
        <button class="desktop-button desktop-button--primary" type="submit">
          ${t("desktop.connect")}
        </button>
      </form>
    </div>
  `;
}

export function renderDesktopConnection(options: {
  state: DesktopPanelState;
  controlling: boolean;
  desktopApps: WorkerDesktopAppId[];
  environmentSelected: boolean;
  launchingApp: WorkerDesktopAppId | null;
  showApps: boolean;
  onDisconnect: () => void;
  onLaunch: (app: WorkerDesktopAppId) => void;
  onTakeControl: () => void;
}) {
  return html`
    <div class="desktop-toolbar desktop-toolbar--connection">
      ${options.showApps && options.desktopApps.length > 0
        ? html`<div class="desktop-apps">
            ${options.desktopApps.map((app) => {
              const launching = options.launchingApp === app;
              const label = desktopAppLabel(app);
              return html`<button
                class="desktop-app-button"
                type="button"
                title=${label}
                aria-label=${label}
                aria-busy=${launching ? "true" : "false"}
                ?disabled=${!options.environmentSelected || launching}
                @click=${() => options.onLaunch(app)}
              >
                <span
                  class="desktop-app-button__icon ${launching
                    ? "desktop-app-button__icon--launching"
                    : ""}"
                  aria-hidden="true"
                >
                  ${desktopAppIcon(app)}
                </span>
                <span>${label}</span>
              </button>`;
            })}
          </div>`
        : nothing}
      <span class="desktop-toolbar__spacer"></span>
      <button
        class="desktop-toolbar-action"
        type="button"
        title=${t("desktop.disconnect")}
        aria-label=${t("desktop.disconnect")}
        @click=${options.onDisconnect}
      >
        ${t("desktop.disconnect")}
      </button>
    </div>
    <div class="desktop-stage">
      <div class="desktop-surface"></div>
      ${!options.controlling
        ? html`<button
            class="desktop-stage__take-control"
            type="button"
            title=${t("desktop.takeControl")}
            aria-label=${t("desktop.takeControl")}
            @click=${options.onTakeControl}
          ></button>`
        : nothing}
      ${options.state === "connecting"
        ? renderPanelLoadingSkeleton("desktop", t("desktop.connecting"), false, true)
        : nothing}
    </div>
  `;
}

export function renderDesktopNotice(errorText: string | null, noticeText: string | null) {
  return errorText
    ? html`<div class="desktop-note desktop-note--error" role="alert">${errorText}</div>`
    : noticeText
      ? html`<div class="desktop-note" role="status">${noticeText}</div>`
      : nothing;
}
