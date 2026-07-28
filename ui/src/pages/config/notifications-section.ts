import { html, nothing } from "lit";
import type { NativeNotificationsPermission } from "../../app/native-notifications.ts";
import { icons } from "../../components/icons.ts";
import {
  renderSettingsRow,
  renderSettingsStatus,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { COMMUNICATION_SETTINGS_TARGET_IDS } from "./settings-targets.ts";

export type WebPushUiState = {
  supported: boolean;
  permission: NotificationPermission | "unsupported";
  subscribed: boolean;
  loading: boolean;
  error?: string | null;
};

// Leaf props contract: view.ts imports this module, so importing ConfigProps
// back from view.ts would create an import cycle. ConfigProps is structurally
// assignable to this subset.
type NotificationsSectionProps = {
  connected: boolean;
  nativeNotifications?: { permission: NativeNotificationsPermission | "unknown" };
  onNativeNotificationsRequestPermission?: () => void;
  onNativeNotificationsSendTest?: () => void;
  webPush?: WebPushUiState;
  onWebPushSubscribe?: () => void;
  onWebPushUnsubscribe?: () => void;
  onWebPushTest?: () => void;
};

function nativeNotificationsStatus(permission: NativeNotificationsPermission | "unknown"): {
  kind: "ok" | "danger" | "accent" | "muted";
  label: string;
} {
  switch (permission) {
    case "granted":
      return { kind: "ok", label: t("configView.notifications.granted") };
    case "denied":
      return { kind: "danger", label: t("configView.notifications.denied") };
    case "notDetermined":
      return { kind: "accent", label: t("configView.notifications.notRequested") };
    default:
      return { kind: "muted", label: t("configView.notifications.checking") };
  }
}

export function renderNotificationsSection(props: NotificationsSectionProps) {
  const native = props.nativeNotifications;
  if (native) {
    const status = nativeNotificationsStatus(native.permission);
    const actionButton =
      native.permission === "notDetermined"
        ? html`
            <button
              class="btn primary"
              @click=${() => props.onNativeNotificationsRequestPermission?.()}
            >
              ${t("configView.notifications.enable")}
            </button>
          `
        : native.permission === "denied"
          ? html`
              <button class="btn" @click=${() => props.onNativeNotificationsRequestPermission?.()}>
                ${t("configView.notifications.openSystemSettings")}
              </button>
            `
          : native.permission === "granted"
            ? html`
                <button class="btn primary" @click=${() => props.onNativeNotificationsSendTest?.()}>
                  ${icons.send} ${t("configView.notifications.sendTest")}
                </button>
              `
            : nothing;

    return html`
      <div class="settings-page">
        <section class="settings-section" id=${COMMUNICATION_SETTINGS_TARGET_IDS.notifications}>
          <div class="settings-section__header">
            <h2 class="settings-section__heading">${t("configView.notifications.nativeTitle")}</h2>
            <div class="settings-section__actions">${renderSettingsStatus(status)}</div>
          </div>
          <p class="settings-section__desc">${t("configView.notifications.nativeHint")}</p>
          <div class="settings-group">
            ${renderSettingsRow({
              title: t("configView.notifications.permission"),
              control: renderSettingsValue(status.label),
            })}
            ${actionButton !== nothing
              ? html`
                  <div class="settings-row">
                    <div class="settings-row__control">${actionButton}</div>
                  </div>
                `
              : nothing}
            ${native.permission === "denied"
              ? renderSettingsRow({
                  title: t("configView.notifications.blocked"),
                  description: t("configView.notifications.nativeBlockedHint"),
                  control: renderSettingsStatus({
                    kind: "danger",
                    label: t("configView.notifications.denied"),
                  }),
                })
              : nothing}
          </div>
        </section>
      </div>
    `;
  }

  const push = props.webPush;
  if (!push) {
    return html`
      <div class="settings-page">
        <section class="settings-section" id=${COMMUNICATION_SETTINGS_TARGET_IDS.notifications}>
          <div class="settings-section__header">
            <h2 class="settings-section__heading">${t("configView.notifications.title")}</h2>
            <div class="settings-section__actions">
              ${renderSettingsStatus({
                kind: "muted",
                label: t("configView.notifications.unavailable"),
              })}
            </div>
          </div>
          <div class="settings-group">
            <div class="settings-row">
              <div class="settings-row__text">
                <span class="settings-row__desc">
                  ${t("configView.notifications.unavailableHint")}
                </span>
              </div>
            </div>
          </div>
        </section>
      </div>
    `;
  }

  const permissionLabel =
    push.permission === "granted"
      ? t("configView.notifications.granted")
      : push.permission === "denied"
        ? t("configView.notifications.denied")
        : push.permission === "default"
          ? t("configView.notifications.notRequested")
          : t("configView.notifications.unsupported");
  const subscriptionLabel = push.subscribed
    ? t("configView.notifications.subscribed")
    : t("configView.notifications.notSubscribed");
  const statusLabel = !push.supported
    ? t("configView.notifications.unsupported")
    : push.permission === "denied"
      ? t("configView.notifications.blocked")
      : push.subscribed
        ? t("configView.notifications.subscribed")
        : t("configView.notifications.ready");
  const statusKind = !push.supported
    ? ("muted" as const)
    : push.permission === "denied"
      ? ("danger" as const)
      : push.subscribed
        ? ("ok" as const)
        : ("accent" as const);

  const actionButtons =
    push.supported && push.permission !== "denied"
      ? push.subscribed
        ? html`
            <button
              class="btn"
              ?disabled=${push.loading || !props.connected}
              @click=${() => props.onWebPushUnsubscribe?.()}
            >
              ${icons.x} ${t("configView.notifications.unsubscribe")}
            </button>
            <button
              class="btn primary"
              ?disabled=${push.loading || !props.connected}
              @click=${() => props.onWebPushTest?.()}
            >
              ${icons.send} ${t("configView.notifications.sendTest")}
            </button>
          `
        : html`
            <button
              class="btn primary"
              ?disabled=${push.loading || !props.connected}
              @click=${() => props.onWebPushSubscribe?.()}
            >
              ${push.loading ? icons.loader : nothing}
              ${push.loading
                ? t("configView.notifications.subscribing")
                : t("configView.notifications.enable")}
            </button>
          `
      : nothing;

  return html`
    <div class="settings-page">
      <section class="settings-section" id=${COMMUNICATION_SETTINGS_TARGET_IDS.notifications}>
        <div class="settings-section__header">
          <h2 class="settings-section__heading">${t("configView.notifications.title")}</h2>
          <div class="settings-section__actions">
            ${renderSettingsStatus({ kind: statusKind, label: statusLabel })}
          </div>
        </div>
        <p class="settings-section__desc">${t("configView.notifications.hint")}</p>
        <div class="settings-group">
          ${renderSettingsRow({
            title: t("configView.notifications.browserSupport"),
            control: renderSettingsValue(
              push.supported
                ? t("configView.notifications.available")
                : t("configView.notifications.notSupported"),
            ),
          })}
          ${renderSettingsRow({
            title: t("configView.notifications.permission"),
            control: renderSettingsValue(permissionLabel),
          })}
          ${renderSettingsRow({
            title: t("configView.notifications.status"),
            control: renderSettingsStatus({
              kind: push.subscribed ? "ok" : "muted",
              label: subscriptionLabel,
            }),
          })}
          ${actionButtons !== nothing
            ? html`
                <div class="settings-row">
                  <div class="settings-row__control">${actionButtons}</div>
                </div>
              `
            : nothing}
          ${push.permission === "denied"
            ? renderSettingsRow({
                title: t("configView.notifications.blocked"),
                description: t("configView.notifications.blockedHint"),
                control: renderSettingsStatus({
                  kind: "danger",
                  label: t("configView.notifications.denied"),
                }),
              })
            : nothing}
          ${push.error
            ? html`
                <div class="settings-row">
                  <div class="settings-row__text">
                    <span class="cfg-field__error">${push.error}</span>
                  </div>
                </div>
              `
            : nothing}
        </div>
      </section>
    </div>
  `;
}
