import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import type { NativeDeviceSettingsSnapshot } from "../../app/native-device-settings.ts";
import {
  renderLearnMoreLink,
  renderSettingsEmpty,
  renderSettingsPage,
  renderSettingsPageHeader,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsSegmented,
  renderSettingsStatus,
  renderSettingsToggleRow,
} from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";

registerSettingsEnglish();

class DevicePermissionsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  private readonly subscriptions = new SubscriptionsController(this).watch(
    () => this.context?.nativeDeviceSettings,
    (capability, notify) => capability.subscribe(notify),
  );

  override disconnectedCallback() {
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  private renderPermissions(snapshot: NativeDeviceSettingsSnapshot) {
    const capability = this.context.nativeDeviceSettings;
    const { permissions } = snapshot;
    const preciseEditable =
      permissions.location.preciseEditable ?? snapshot.device.platform === "macos";
    return html`
      ${renderSettingsSection(
        { title: t("configPage.deviceSettings.systemAccess") },
        permissions.entries.map(({ id, status }) =>
          renderSettingsRow({
            title: t(`configPage.deviceSettings.permissions.${id}.title`),
            description: t(`configPage.deviceSettings.permissions.${id}.hint`),
            stackedOnNarrow: true,
            control: html`
              ${renderSettingsStatus({ kind: status === "granted" ? "ok" : status === "denied" ? "danger" : "muted", label: t(`configPage.deviceSettings.permissionStatuses.${status}`) })}
              ${status === "notDetermined" ? html`<button type="button" class="btn" @click=${() => capability?.requestPermission(id)}>${t("configPage.deviceSettings.grant")}</button>` : status === "denied" ? html`<button type="button" class="btn" @click=${() => capability?.openSystemSettings(id)}>${t("configPage.deviceSettings.openSystemSettings")}</button>` : nothing}
            `,
          }),
        ),
      )}
      ${renderSettingsSection(
        { title: t("configPage.deviceSettings.location") },
        html`
          ${renderSettingsRow({
            title: t("configPage.deviceSettings.locationAccess"),
            description: t("configPage.deviceSettings.locationHint"),
            stackedOnNarrow: true,
            control: renderSettingsSegmented({
              value: permissions.location.mode,
              ariaLabel: t("configPage.deviceSettings.locationAccess"),
              options: ["off", "whileUsing", "always"].map((value) => ({
                value,
                label: t(`configPage.deviceSettings.locationModes.${value}`),
              })),
              onChange: (value) => capability?.set("permissions.location.mode", value),
            }),
          })}
          ${
            !preciseEditable
              ? renderSettingsRow({
                  title: t("configPage.deviceSettings.preciseLocation"),
                  description: t("configPage.deviceSettings.preciseLocationReadOnlyHint"),
                  stackedOnNarrow: true,
                  control: html`
                    ${renderSettingsStatus({ kind: permissions.location.precise ? "ok" : "muted", label: t(permissions.location.precise ? "configPage.deviceSettings.preciseLocationStatuses.enabled" : "configPage.deviceSettings.preciseLocationStatuses.disabled") })}
                    <button
                      type="button"
                      class="btn"
                      @click=${() => capability?.openSystemSettings("location")}
                    >
                      ${t("configPage.deviceSettings.openSettings")}
                    </button>
                  `,
                })
              : renderSettingsToggleRow({
                  title: t("configPage.deviceSettings.preciseLocation"),
                  description: t("configPage.deviceSettings.preciseLocationHint"),
                  checked: permissions.location.precise,
                  disabled: permissions.location.mode === "off",
                  onChange: (value) => capability?.set("permissions.location.precise", value),
                })
          }
        `,
      )}
      ${
        snapshot.capabilities?.activeComputerPresenceEnabled !== undefined
          ? renderSettingsSection(
              { title: t("configPage.deviceSettings.privacy") },
              renderSettingsToggleRow({
                title: t("configPage.deviceSettings.activePresence"),
                description: t("configPage.deviceSettings.activePresenceHint"),
                checked: snapshot.capabilities.activeComputerPresenceEnabled,
                onChange: (value) =>
                  capability?.set("capabilities.activeComputerPresenceEnabled", value),
              }),
            )
          : nothing
      }
    `;
  }

  override render() {
    const capability = this.context?.nativeDeviceSettings;
    const snapshot = capability?.snapshot;
    const body = !capability
      ? renderSettingsEmpty(t("configPage.deviceSettings.appOnly"))
      : snapshot
        ? this.renderPermissions(snapshot)
        : renderSettingsEmpty(t("configPage.deviceSettings.loading"));
    return html`
      ${renderSettingsPageHeader({
        title: titleForRoute("device-permissions"),
        subtitle: html`${t(snapshot?.device.platform === "ios" ? "configPage.deviceSettings.permissionsIntroIos" : "configPage.deviceSettings.permissionsIntro")}
        ${renderLearnMoreLink(snapshot?.device.platform === "ios" ? "https://docs.openclaw.ai/platforms/ios" : "https://docs.openclaw.ai/platforms/macos")}`,
      })}
      ${renderSettingsWorkspace(renderSettingsPage(body))}
    `;
  }
}

if (!customElements.get("openclaw-device-permissions-page")) {
  customElements.define("openclaw-device-permissions-page", DevicePermissionsPage);
}
