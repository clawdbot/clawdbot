import { html, nothing } from "lit";
import type {
  WebPushDevicePreferences,
  WebPushNotificationPreferences,
} from "../../../../packages/gateway-protocol/src/schema/push.js";
import type {
  NativeNotificationsPermission,
  NativeNotificationTestOutcome,
} from "../../app/native-notifications.ts";
import type { WebPushSnapshot } from "../../app/web-push.ts";
import { icons } from "../../components/icons.ts";
import {
  renderSettingsRow,
  renderSettingsStatus,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { COMMUNICATION_SETTINGS_TARGET_IDS } from "./settings-targets.ts";

// Leaf props contract: view.ts imports this module, so importing ConfigProps
// back from view.ts would create an import cycle. ConfigProps is structurally
// assignable to this subset.
type NotificationsSectionProps = {
  connected: boolean;
  nativeNotifications?: {
    permission: NativeNotificationsPermission | "unknown";
    test: NativeNotificationTestOutcome | null;
  };
  onNativeNotificationsRequestPermission?: () => void;
  onNativeNotificationsSendTest?: () => void;
  webPush?: WebPushSnapshot;
  onWebPushSubscribe?: () => void;
  onWebPushUnsubscribe?: () => void;
  onWebPushTest?: () => void;
  onWebPushSetUserPreferences?: (preferences: WebPushNotificationPreferences) => void;
  onWebPushSetDevicePreferences?: (preferences: WebPushDevicePreferences) => void;
};

const WEB_PUSH_CATEGORIES = [
  ["approvalRequested", () => t("configView.notifications.approvalRequested")],
  ["agentFinished", () => t("configView.notifications.agentFinished")],
  ["agentQuestion", () => t("configView.notifications.agentQuestion")],
  ["scheduledTaskFailed", () => t("configView.notifications.scheduledTaskFailed")],
  ["backgroundTaskFailed", () => t("configView.notifications.backgroundTaskFailed")],
] as const;

function minutesToTime(value: number): string {
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function timeToMinutes(value: string, fallback: number): number {
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  if (!match) {
    return fallback;
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

function inputTarget(event: Event): HTMLInputElement {
  // SAFETY: callers bind these handlers directly to input elements in this module.
  return event.currentTarget as HTMLInputElement;
}

function selectTarget(event: Event): HTMLSelectElement {
  // SAFETY: callers bind these handlers directly to select elements in this module.
  return event.currentTarget as HTMLSelectElement;
}

function detailLevel(value: string): WebPushNotificationPreferences["detailLevel"] {
  return value === "identified" || value === "detailed" ? value : "private";
}

function renderUserNotificationPreferences(
  preferences: WebPushNotificationPreferences,
  onChange: (preferences: WebPushNotificationPreferences) => void,
) {
  const patch = (next: Partial<WebPushNotificationPreferences>) =>
    onChange({ ...preferences, ...next });
  return html`
    <section class="settings-section">
      <div class="settings-section__header">
        <h2 class="settings-section__heading">${t("configView.notifications.accountDefaults")}</h2>
      </div>
      <div class="settings-group">
        ${WEB_PUSH_CATEGORIES.map(([key, label]) =>
          renderSettingsRow({
            title: label(),
            control: html`<input
              type="checkbox"
              .checked=${preferences.categories[key]}
              @change=${(event: Event) =>
                patch({
                  categories: {
                    ...preferences.categories,
                    [key]: inputTarget(event).checked,
                  },
                })}
            />`,
          }),
        )}
        ${renderSettingsRow({
          title: t("configView.notifications.lockScreenDetail"),
          description: t("configView.notifications.lockScreenDetailHint"),
          control: html`<select
            .value=${preferences.detailLevel}
            @change=${(event: Event) =>
              patch({
                detailLevel: detailLevel(selectTarget(event).value),
              })}
          >
            <option value="private">${t("configView.notifications.private")}</option>
            <option value="identified">${t("configView.notifications.namesOnly")}</option>
            <option value="detailed">${t("configView.notifications.detailed")}</option>
          </select>`,
        })}
        ${renderSettingsRow({
          title: t("configView.notifications.quietHours"),
          control: html`<input
            type="checkbox"
            .checked=${preferences.quietHours.enabled}
            @change=${(event: Event) =>
              patch({
                quietHours: {
                  ...preferences.quietHours,
                  enabled: inputTarget(event).checked,
                },
              })}
          />`,
        })}
        ${preferences.quietHours.enabled
          ? html`
              ${renderSettingsRow({
                title: t("configView.notifications.quietHoursWindow"),
                control: html`<span>
                  <input
                    type="time"
                    .value=${minutesToTime(preferences.quietHours.startMinute)}
                    @change=${(event: Event) =>
                      patch({
                        quietHours: {
                          ...preferences.quietHours,
                          startMinute: timeToMinutes(
                            inputTarget(event).value,
                            preferences.quietHours.startMinute,
                          ),
                        },
                      })}
                  />
                  –
                  <input
                    type="time"
                    .value=${minutesToTime(preferences.quietHours.endMinute)}
                    @change=${(event: Event) =>
                      patch({
                        quietHours: {
                          ...preferences.quietHours,
                          endMinute: timeToMinutes(
                            inputTarget(event).value,
                            preferences.quietHours.endMinute,
                          ),
                        },
                      })}
                  />
                </span>`,
              })}
              ${renderSettingsRow({
                title: t("configView.notifications.timeZone"),
                control: html`<input
                  type="text"
                  .value=${preferences.quietHours.timeZone}
                  @change=${(event: Event) =>
                    patch({
                      quietHours: {
                        ...preferences.quietHours,
                        timeZone: inputTarget(event).value,
                      },
                    })}
                />`,
              })}
            `
          : nothing}
        ${renderSettingsRow({
          title: t("configView.notifications.onlyAgents"),
          control: html`<input
            type="text"
            .value=${preferences.agentIds.join(", ")}
            @change=${(event: Event) =>
              patch({
                agentIds: inputTarget(event)
                  .value.split(",")
                  .map((entry) => entry.trim())
                  .filter(Boolean),
              })}
          />`,
        })}
      </div>
    </section>
  `;
}

function renderDeviceNotificationPreferences(
  preferences: WebPushDevicePreferences,
  onChange: (preferences: WebPushDevicePreferences) => void,
) {
  const patch = (next: Partial<WebPushDevicePreferences>) => onChange({ ...preferences, ...next });
  const deviceQuietHours = preferences.quietHours;
  return html`
    <section class="settings-section">
      <div class="settings-section__header">
        <h2 class="settings-section__heading">${t("configView.notifications.installedApp")}</h2>
      </div>
      <div class="settings-group">
        ${renderSettingsRow({
          title: t("configView.notifications.deliverDevice"),
          control: html`<input
            type="checkbox"
            .checked=${preferences.enabled}
            @change=${(event: Event) => patch({ enabled: inputTarget(event).checked })}
          />`,
        })}
        ${renderSettingsRow({
          title: t("configView.notifications.notificationLabel"),
          control: html`<input
            type="text"
            maxlength="80"
            .value=${preferences.label}
            @change=${(event: Event) => patch({ label: inputTarget(event).value })}
          />`,
        })}
        ${renderSettingsRow({
          title: t("configView.notifications.lockScreenDetail"),
          control: html`<select
            .value=${preferences.detailLevel ?? "inherit"}
            @change=${(event: Event) => {
              const value = selectTarget(event).value;
              patch({
                detailLevel: value === "inherit" ? undefined : detailLevel(value),
              });
            }}
          >
            <option value="inherit">${t("configView.notifications.inheritDetail")}</option>
            <option value="private">${t("configView.notifications.private")}</option>
            <option value="identified">${t("configView.notifications.namesOnly")}</option>
            <option value="detailed">${t("configView.notifications.detailed")}</option>
          </select>`,
        })}
        ${renderSettingsRow({
          title: t("configView.notifications.quietHours"),
          control: html`<select
            .value=${preferences.quietHours === undefined
              ? "inherit"
              : preferences.quietHours.enabled
                ? "on"
                : "off"}
            @change=${(event: Event) => {
              const value = selectTarget(event).value;
              patch({
                quietHours:
                  value === "inherit"
                    ? undefined
                    : {
                        enabled: value === "on",
                        startMinute: preferences.quietHours?.startMinute ?? 22 * 60,
                        endMinute: preferences.quietHours?.endMinute ?? 7 * 60,
                        timeZone: preferences.quietHours?.timeZone ?? "UTC",
                      },
              });
            }}
          >
            <option value="inherit">${t("configView.notifications.inheritQuietHours")}</option>
            <option value="on">${t("configForm.enumOn")}</option>
            <option value="off">${t("configForm.enumOff")}</option>
          </select>`,
        })}
        ${deviceQuietHours?.enabled
          ? html`
              ${renderSettingsRow({
                title: t("configView.notifications.quietHoursWindow"),
                control: html`<span>
                  <input
                    type="time"
                    .value=${minutesToTime(deviceQuietHours.startMinute)}
                    @change=${(event: Event) =>
                      patch({
                        quietHours: {
                          ...deviceQuietHours,
                          startMinute: timeToMinutes(
                            inputTarget(event).value,
                            deviceQuietHours.startMinute,
                          ),
                        },
                      })}
                  />
                  –
                  <input
                    type="time"
                    .value=${minutesToTime(deviceQuietHours.endMinute)}
                    @change=${(event: Event) =>
                      patch({
                        quietHours: {
                          ...deviceQuietHours,
                          endMinute: timeToMinutes(
                            inputTarget(event).value,
                            deviceQuietHours.endMinute,
                          ),
                        },
                      })}
                  />
                </span>`,
              })}
              ${renderSettingsRow({
                title: t("configView.notifications.timeZone"),
                control: html`<input
                  type="text"
                  .value=${deviceQuietHours.timeZone}
                  @change=${(event: Event) =>
                    patch({
                      quietHours: {
                        ...deviceQuietHours,
                        timeZone: inputTarget(event).value,
                      },
                    })}
                />`,
              })}
            `
          : nothing}
        ${renderSettingsRow({
          title: t("configView.notifications.onlyAgents"),
          control: html`<select
            .value=${preferences.agentIds === undefined ? "inherit" : "override"}
            @change=${(event: Event) => {
              const value = selectTarget(event).value;
              patch({ agentIds: value === "inherit" ? undefined : [] });
            }}
          >
            <option value="inherit">${t("configView.notifications.inherit")}</option>
            <option value="override">${t("configView.notifications.overrideAgents")}</option>
          </select>`,
        })}
        ${preferences.agentIds !== undefined
          ? renderSettingsRow({
              title: t("configView.notifications.onlyAgents"),
              control: html`<input
                type="text"
                .value=${preferences.agentIds.join(", ")}
                @change=${(event: Event) =>
                  patch({
                    agentIds: inputTarget(event)
                      .value.split(",")
                      .map((entry) => entry.trim())
                      .filter(Boolean),
                  })}
              />`,
            })
          : nothing}
        ${WEB_PUSH_CATEGORIES.map(([key, label]) =>
          renderSettingsRow({
            title: label(),
            control: html`<select
              .value=${preferences.categories?.[key] === undefined
                ? "inherit"
                : preferences.categories[key]
                  ? "on"
                  : "off"}
              @change=${(event: Event) => {
                const value = selectTarget(event).value;
                const categories = { ...preferences.categories };
                if (value === "inherit") {
                  delete categories[key];
                } else {
                  categories[key] = value === "on";
                }
                patch({ categories });
              }}
            >
              <option value="inherit">${t("configView.notifications.inherit")}</option>
              <option value="on">${t("configForm.enumOn")}</option>
              <option value="off">${t("configForm.enumOff")}</option>
            </select>`,
          }),
        )}
      </div>
    </section>
  `;
}

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
    const testPending = native.test?.state === "pending";
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
                <button
                  class="btn primary"
                  ?disabled=${testPending}
                  @click=${() => props.onNativeNotificationsSendTest?.()}
                >
                  ${testPending ? icons.loader : icons.send}
                  ${testPending
                    ? t("configView.notifications.sendingTest")
                    : t("configView.notifications.sendTest")}
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
            ${native.test
              ? renderSettingsRow({
                  title: t("configView.notifications.testOutcome"),
                  description: native.test.state === "error" ? native.test.message : undefined,
                  control: renderSettingsStatus(
                    native.test.state === "pending"
                      ? {
                          kind: "accent",
                          label: t("configView.notifications.sendingTest"),
                        }
                      : native.test.state === "sent"
                        ? {
                            kind: "ok",
                            label: t("configView.notifications.testQueued"),
                          }
                        : {
                            kind: "danger",
                            label: t("configView.notifications.testFailed"),
                          },
                  ),
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
  const registered = push.subscription === "registered";
  const canReset = registered || push.subscription === "vapid-mismatch";
  const subscriptionLabel = registered
    ? t("configView.notifications.subscribed")
    : push.subscription === "unknown"
      ? t("configView.notifications.checking")
      : t("configView.notifications.notSubscribed");
  const statusLabel = !push.supported
    ? t("configView.notifications.unsupported")
    : push.permission === "denied"
      ? t("configView.notifications.blocked")
      : registered
        ? t("configView.notifications.subscribed")
        : push.subscription === "vapid-mismatch"
          ? t("configView.notifications.unavailable")
          : push.subscription === "unknown"
            ? t("configView.notifications.checking")
            : t("configView.notifications.ready");
  const statusKind = !push.supported
    ? ("muted" as const)
    : push.permission === "denied" || push.subscription === "vapid-mismatch"
      ? ("danger" as const)
      : registered
        ? ("ok" as const)
        : ("accent" as const);

  const actionButtons =
    push.supported && push.permission !== "denied"
      ? canReset
        ? html`
            <button
              class="btn"
              ?disabled=${push.loading || !props.connected}
              @click=${() => props.onWebPushUnsubscribe?.()}
            >
              ${icons.x} ${t("configView.notifications.unsubscribe")}
            </button>
            ${registered
              ? html`<button
                  class="btn primary"
                  ?disabled=${push.loading || !props.connected}
                  @click=${() => props.onWebPushTest?.()}
                >
                  ${icons.send} ${t("configView.notifications.sendTest")}
                </button>`
              : nothing}
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
        ${push.permission === "install-required"
          ? html`<p class="settings-section__desc">
              ${t("configView.notifications.iosInstallRequired")}
            </p>`
          : nothing}
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
              kind: registered ? "ok" : "muted",
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
                    <span class="cfg-field__error">${formatUiExternalText(push.error)}</span>
                  </div>
                </div>
              `
            : nothing}
        </div>
      </section>
      ${registered && push.preferences
        ? html`<div class="settings-page" ?inert=${push.loading}>
            ${push.preferences.durableIdentity
              ? renderUserNotificationPreferences(push.preferences.user, (preferences) =>
                  props.onWebPushSetUserPreferences?.(preferences),
                )
              : nothing}
            ${renderDeviceNotificationPreferences(push.preferences.device, (preferences) =>
              props.onWebPushSetDevicePreferences?.(preferences),
            )}
          </div>`
        : nothing}
    </div>
  `;
}
