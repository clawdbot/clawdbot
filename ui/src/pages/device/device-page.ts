import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import { live } from "lit/directives/live.js";
import { deviceSettingsGroupLabelKey } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import type {
  NativeChromeExtensionSetupResult,
  NativeDeviceSettingsCapability,
  NativeDeviceSettingsSnapshot,
  SettingKey,
} from "../../app/native-device-settings.ts";
import {
  renderLearnMoreLink,
  renderSettingsEmpty,
  renderSettingsPage,
  renderSettingsPageHeader,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsStatus,
  renderSettingsToggleRow,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import "./device.css";

registerSettingsEnglish();

type CookieSyncEdits = {
  domains: string[] | null;
  targetProfile: { value: string; sent: boolean } | null;
};

const pendingCookieSyncEdits = new WeakMap<NativeDeviceSettingsCapability, CookieSyncEdits>();

function retainCookieSyncEdits(capability: NativeDeviceSettingsCapability): CookieSyncEdits {
  const existing = pendingCookieSyncEdits.get(capability);
  if (existing) {
    return existing;
  }
  const edits: CookieSyncEdits = { domains: null, targetProfile: null };
  pendingCookieSyncEdits.set(capability, edits);
  return edits;
}

function settleCookieSyncEdit(
  capability: NativeDeviceSettingsCapability,
  key: keyof CookieSyncEdits,
  edit: CookieSyncEdits[keyof CookieSyncEdits],
) {
  const edits = pendingCookieSyncEdits.get(capability);
  if (!edits || edits[key] !== edit) {
    return;
  }
  // Completion belongs to this exact edit, including Cancel and native normalization.
  // A newer edit can have the same value and must survive the older reply.
  edits[key] = null;
  if (edits.domains === null && edits.targetProfile === null) {
    pendingCookieSyncEdits.delete(capability);
  }
}

class DevicePage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private newDomain = "";
  @state() private extensionSetupRunning = false;
  @state() private extensionSetupResult: NativeChromeExtensionSetupResult | null = null;
  @state() private extensionSetupFailed = false;
  private targetProfileTimer: {
    capability: NativeDeviceSettingsCapability;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private readonly subscriptions = new SubscriptionsController(this).watch(
    () => this.context?.nativeDeviceSettings,
    (capability, notify) => capability.subscribe(notify),
    (capability) => {
      if (this.targetProfileTimer && this.targetProfileTimer.capability !== capability) {
        this.flushTargetProfile();
      }
    },
  );

  override disconnectedCallback() {
    // A route change must not discard a text edit still inside the debounce window.
    this.flushTargetProfile();
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  private toggle(
    key: SettingKey,
    checked: boolean | undefined,
    label: string,
    description?: string,
    disabled = false,
  ) {
    if (checked === undefined) {
      return nothing;
    }
    return renderSettingsToggleRow({
      title: t(`configPage.deviceSettings.${label}`),
      description,
      checked,
      disabled,
      onChange: (value) => this.context.nativeDeviceSettings?.set(key, value),
    });
  }

  private editTargetProfile(value: string) {
    const capability = this.context.nativeDeviceSettings;
    if (!capability) {
      return;
    }
    if (this.targetProfileTimer !== null) {
      clearTimeout(this.targetProfileTimer.timer);
    }
    retainCookieSyncEdits(capability).targetProfile = { value, sent: false };
    this.targetProfileTimer = {
      capability,
      timer: setTimeout(() => this.flushTargetProfile(), 400),
    };
    this.requestUpdate();
  }

  private flushTargetProfile() {
    const pending = this.targetProfileTimer;
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.targetProfileTimer = null;
    const profile = pendingCookieSyncEdits.get(pending.capability)?.targetProfile;
    if (profile && !profile.sent) {
      profile.sent = true;
      pending.capability.set("browser.cookieSync.targetProfile", profile.value, () => {
        settleCookieSyncEdit(pending.capability, "targetProfile", profile);
      });
    }
  }

  private updateDomains(update: (domains: string[]) => string[]) {
    const capability = this.context.nativeDeviceSettings;
    if (!capability) {
      return;
    }
    const domains =
      pendingCookieSyncEdits.get(capability)?.domains ??
      capability.snapshot?.browser?.cookieSync.domains;
    if (!domains) {
      return;
    }
    const values = [
      ...new Set(
        update(domains)
          .map((domain) => domain.trim().toLowerCase())
          .filter(Boolean),
      ),
    ];
    retainCookieSyncEdits(capability).domains = values;
    this.requestUpdate();
    capability.set("browser.cookieSync.domains", values, () => {
      settleCookieSyncEdit(capability, "domains", values);
    });
  }

  private renderBrowser(browser: NonNullable<NativeDeviceSettingsSnapshot["browser"]>) {
    const capability = this.context.nativeDeviceSettings;
    const sync = browser.cookieSync;
    const pending = capability ? pendingCookieSyncEdits.get(capability) : undefined;
    const domains = pending?.domains ?? sync.domains;
    const addDomain = () => {
      this.updateDomains((current) => [...current, this.newDomain]);
      this.newDomain = "";
    };
    return html`
      ${renderSettingsSection(
        { title: t("configPage.deviceSettings.chromeExtension") },
        renderSettingsRow({
          title: t("configPage.deviceSettings.chromeExtensionSetup"),
          description: t("configPage.deviceSettings.chromeExtensionHint"),
          stacked: true,
          control: html`
            <div class="device-extension-setup">
              <div class="device-extension-setup__actions">
                <button
                  type="button"
                  class="btn"
                  ?disabled=${this.extensionSetupRunning}
                  @click=${() => this.installChromeExtension()}
                >
                  ${t(this.extensionSetupRunning ? "configPage.deviceSettings.chromeExtensionPreparing" : "configPage.deviceSettings.chromeExtensionSetup")}
                </button>
                <a
                  href="https://chromewebstore.google.com/detail/openclaw/kcdjddhmeafeomebliikmbpblkmkfoig"
                  target="_blank"
                  rel="noopener noreferrer"
                  >${t("appsPage.ctaChromeWebStore")}</a
                >
                ${renderLearnMoreLink("https://docs.openclaw.ai/tools/chrome-extension")}
              </div>
              <p role="status">
                ${
                  this.extensionSetupFailed
                    ? t("configPage.deviceSettings.chromeExtensionFailed")
                    : this.extensionSetupResult
                      ? t(
                          this.extensionSetupResult.nativeHostRegistered
                            ? this.extensionSetupResult.discoveredProfiles > 0
                              ? "configPage.deviceSettings.chromeExtensionInstalled"
                              : this.extensionSetupResult.installRequested
                                ? "configPage.deviceSettings.chromeExtensionPending"
                                : "configPage.deviceSettings.chromeExtensionStoreRequired"
                            : "configPage.deviceSettings.chromeExtensionFailed",
                        )
                      : nothing
                }
              </p>
            </div>
          `,
        }),
      )}
      ${
        browser.importAvailable || !sync.available
          ? renderSettingsSection(
              { title: t("configPage.deviceSettings.browser") },
              html`
                ${
                  browser.importAvailable
                    ? renderSettingsRow({
                        title: t("configPage.deviceSettings.browserImport"),
                        description: t("configPage.deviceSettings.browserImportHint"),
                        control: html`<button
                          type="button"
                          class="btn"
                          @click=${() => capability?.openPanel("browser-import")}
                        >
                          ${t("configPage.deviceSettings.importBrowserLogins")}
                        </button>`,
                      })
                    : nothing
                }
                ${
                  !sync.available
                    ? renderSettingsRow({
                        title: t("configPage.deviceSettings.cookieSync"),
                        description: t("configPage.deviceSettings.cookieSyncUnavailable"),
                      })
                    : nothing
                }
              `,
            )
          : nothing
      }
      ${
        sync.available
          ? renderSettingsSection(
              {
                title: t(
                  browser.importAvailable
                    ? "configPage.deviceSettings.cookieSync"
                    : "configPage.deviceSettings.browser",
                ),
                description: browser.importAvailable
                  ? undefined
                  : t("configPage.deviceSettings.cookieSync"),
              },
              html`
                ${this.toggle("browser.cookieSync.enabled", sync.enabled, "cookieSyncEnabled", t("configPage.deviceSettings.cookieSyncHint"))}
                ${renderSettingsRow({
                  title: t("configPage.deviceSettings.domains"),
                  description: t("configPage.deviceSettings.domainsHint"),
                  stacked: true,
                  control: html`<div class="device-domains">
                    ${domains.map(
                      (domain) => html`<div class="device-domain-entry">
                        ${renderSettingsValue(domain)}
                        <button
                          type="button"
                          class="btn small"
                          aria-label=${t("configPage.deviceSettings.removeDomain", { domain })}
                          @click=${() => this.updateDomains((current) => current.filter((entry) => entry !== domain))}
                        >
                          ${t("common.remove")}
                        </button>
                      </div>`,
                    )}
                    <form
                      class="device-domain-entry"
                      @submit=${(event: Event) => {
                        event.preventDefault();
                        addDomain();
                      }}
                    >
                      <input
                        type="text"
                        class="settings-input"
                        aria-label=${t("configPage.deviceSettings.addDomain")}
                        .value=${live(this.newDomain)}
                        @input=${(event: Event) => {
                          // SAFETY: This handler is bound directly to the hostname input.
                          this.newDomain = (event.currentTarget as HTMLInputElement).value;
                        }}
                      />
                      <button type="submit" class="btn" ?disabled=${!this.newDomain.trim()}>
                        ${t("configPage.deviceSettings.addDomain")}
                      </button>
                    </form>
                  </div>`,
                })}
                ${renderSettingsRow({
                  title: t("configPage.deviceSettings.targetProfile"),
                  description: t("configPage.deviceSettings.targetProfileHint"),
                  control: html`<input
                    type="text"
                    class="settings-input"
                    aria-label=${t("configPage.deviceSettings.targetProfile")}
                    .value=${live(pending?.targetProfile?.value ?? sync.targetProfile)}
                    @input=${(event: Event) => {
                      // SAFETY: This handler is bound directly to the profile input.
                      this.editTargetProfile((event.currentTarget as HTMLInputElement).value);
                    }}
                    @change=${() => this.flushTargetProfile()}
                  />`,
                })}
                ${renderSettingsRow({
                  title: t("configPage.deviceSettings.syncStatus"),
                  description: sync.detail ?? undefined,
                  control: renderSettingsStatus({
                    kind:
                      sync.state === "error"
                        ? "danger"
                        : sync.state === "running"
                          ? "accent"
                          : "muted",
                    label: t(`configPage.deviceSettings.syncStates.${sync.state}`),
                  }),
                })}
              `,
            )
          : nothing
      }
    `;
  }

  private async installChromeExtension() {
    const capability = this.context.nativeDeviceSettings;
    if (!capability || this.extensionSetupRunning) {
      return;
    }
    this.extensionSetupRunning = true;
    this.extensionSetupFailed = false;
    this.extensionSetupResult = null;
    try {
      const result = await capability.installChromeExtension();
      if (this.isConnected && this.context.nativeDeviceSettings === capability) {
        this.extensionSetupResult = result;
      }
    } catch {
      if (this.isConnected && this.context.nativeDeviceSettings === capability) {
        this.extensionSetupFailed = true;
      }
    } finally {
      this.extensionSetupRunning = false;
    }
  }

  private renderSettings(snapshot: NativeDeviceSettingsSnapshot) {
    const { app, capabilities } = snapshot;
    const capability = this.context.nativeDeviceSettings;
    return html`
      ${
        app
          ? renderSettingsSection(
              { title: t("configPage.deviceSettings.app") },
              html`
                ${
                  app.appearance !== undefined
                    ? renderSettingsRow({
                        title: t("configPage.deviceSettings.appearance"),
                        control: html`<select
                          class="settings-select"
                          aria-label=${t("configPage.deviceSettings.appearance")}
                          .value=${live(app.appearance)}
                          @change=${(event: Event) => {
                            // SAFETY: This handler is bound directly to the appearance select.
                            const value = (event.currentTarget as HTMLSelectElement).value;
                            capability?.set("app.appearance", value);
                          }}
                        >
                          ${["system", "light", "dark"].map((value) => html`<option value=${value} ?selected=${value === app.appearance}>${t(`configPage.deviceSettings.appearanceModes.${value}`)}</option>`)}
                        </select>`,
                      })
                    : nothing
                }
                ${this.toggle("app.notificationsEnabled", app.notificationsEnabled, "notificationsEnabled", t("configPage.deviceSettings.notificationsEnabledHint"))}
                ${this.toggle("app.showDockIcon", app.showDockIcon, "showDockIcon", t("configPage.deviceSettings.showDockIconHint"))}
                ${
                  app.iconStyle
                    ? renderSettingsRow({
                        title: t("configPage.deviceSettings.iconStyle"),
                        description: t("configPage.deviceSettings.iconStyleHint"),
                        control: html`<select
                          class="settings-select"
                          aria-label=${t("configPage.deviceSettings.iconStyle")}
                          .value=${live(app.iconStyle.selectedId)}
                          ?disabled=${app.iconStyle.available.length === 0}
                          @change=${(event: Event) => {
                            // SAFETY: This handler is bound directly to the Dock icon select.
                            const value = (event.currentTarget as HTMLSelectElement).value;
                            capability?.set("app.iconStyle", value);
                          }}
                        >
                          ${app.iconStyle.available.map(
                            (style) => html`<option
                              value=${style.id}
                              ?selected=${style.id === app.iconStyle?.selectedId}
                            >
                              ${style.name}
                            </option>`,
                          )}
                        </select>`,
                      })
                    : nothing
                }
                ${this.toggle("app.iconAnimationsEnabled", app.iconAnimationsEnabled, "iconAnimations", t("configPage.deviceSettings.iconAnimationsHint"))}
                ${this.toggle("app.launchAtLogin", app.launchAtLogin, "launchAtLogin", app.launchAtLoginAvailable === false ? t("configPage.deviceSettings.launchAtLoginUnavailable") : undefined, app.launchAtLoginAvailable === false)}
                ${this.toggle("app.quickChatEnabled", app.quickChatEnabled, "quickChat", t("configPage.deviceSettings.quickChatHint"))}
                ${
                  app.quickChatShortcut !== undefined
                    ? renderSettingsRow({
                        title: t("configPage.deviceSettings.quickChatShortcut"),
                        control: html`
                          ${renderSettingsValue(app.quickChatShortcut ?? t("configPage.deviceSettings.notSet"))}
                          <button
                            type="button"
                            class="btn"
                            @click=${() => capability?.openPanel("quick-chat-shortcut")}
                          >
                            ${t("configPage.deviceSettings.changeShortcut")}
                          </button>
                        `,
                      })
                    : nothing
                }
              `,
            )
          : nothing
      }
      ${
        capabilities
          ? renderSettingsSection(
              { title: t("configPage.deviceSettings.capabilities") },
              html`
                ${this.toggle("capabilities.canvasEnabled", capabilities.canvasEnabled, "canvas", t("configPage.deviceSettings.canvasHint"))}
                ${this.toggle("capabilities.cameraEnabled", capabilities.cameraEnabled, "camera", t("configPage.deviceSettings.cameraHint"))}
                ${this.toggle("capabilities.keepAwakeEnabled", capabilities.keepAwakeEnabled, "keepAwake", t("configPage.deviceSettings.keepAwakeHint"))}
                ${capabilities.healthSummaryAvailable ? this.toggle("capabilities.healthSummaryEnabled", capabilities.healthSummaryEnabled, "healthSummary", t("configPage.deviceSettings.healthSummaryHint")) : nothing}
                ${this.toggle("capabilities.computerControlEnabled", capabilities.computerControlEnabled, "computerControl", t("configPage.deviceSettings.computerControlHint"))}
                ${
                  capabilities.computerControlEnabled &&
                  capabilities.computerControlProvider !== undefined
                    ? renderSettingsRow({
                        title: t("configPage.deviceSettings.computerControlProvider"),
                        control: html`<select
                          class="settings-select"
                          aria-label=${t("configPage.deviceSettings.computerControlProvider")}
                          .value=${capabilities.computerControlProvider}
                          @change=${(event: Event) => {
                            // SAFETY: This handler is bound directly to the provider select.
                            const value = (event.currentTarget as HTMLSelectElement).value;
                            capability?.set("capabilities.computerControlProvider", value);
                          }}
                        >
                          <option
                            value="peekaboo"
                            ?selected=${capabilities.computerControlProvider === "peekaboo"}
                          >
                            ${t("configPage.deviceSettings.peekaboo")}
                          </option>
                          <option
                            value="cua"
                            ?selected=${capabilities.computerControlProvider === "cua"}
                            ?disabled=${!capabilities.cuaDriverBundled}
                          >
                            ${t(capabilities.cuaDriverBundled ? "configPage.deviceSettings.cua" : "configPage.deviceSettings.cuaUnavailable")}
                          </option>
                        </select>`,
                      })
                    : nothing
                }
                ${this.toggle("capabilities.peekabooBridgeEnabled", capabilities.peekabooBridgeEnabled, "peekabooBridge", t("configPage.deviceSettings.peekabooBridgeHint"), !capabilities.computerControlEnabled)}
              `,
            )
          : nothing
      }
      ${snapshot.browser ? this.renderBrowser(snapshot.browser) : nothing}
      ${
        app?.debugPaneEnabled !== undefined
          ? renderSettingsSection(
              { title: t("configPage.deviceSettings.developer") },
              html`
                ${this.toggle("app.debugPaneEnabled", app.debugPaneEnabled, "debugTools")}
                ${app.debugPaneEnabled ? renderSettingsRow({ title: t("configPage.deviceSettings.debugWindow"), control: html`<button type="button" class="btn" @click=${() => capability?.openPanel("debug")}>${t("configPage.deviceSettings.openDebug")}</button>` }) : nothing}
              `,
            )
          : nothing
      }
      ${
        snapshot.device.platform === "ios"
          ? renderSettingsSection(
              { title: t("configPage.deviceSettings.device") },
              html`${(["diagnostics", "licenses", "about", "watch"] as const).map((panel) =>
                renderSettingsRow({
                  title: t(`configPage.deviceSettings.panels.${panel}`),
                  control: html`<button
                    type="button"
                    class="btn"
                    @click=${() => capability?.openPanel(panel)}
                  >
                    ${t("configPage.deviceSettings.openPanel")}
                  </button>`,
                }),
              )}`,
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
        ? this.renderSettings(snapshot)
        : renderSettingsEmpty(t("configPage.deviceSettings.loading"));
    return html`
      ${renderSettingsPageHeader({
        title: t(deviceSettingsGroupLabelKey(snapshot)),
        subtitle: html`${t(snapshot?.device.platform === "ios" ? "configPage.deviceSettings.introIos" : "configPage.deviceSettings.intro")}
        ${renderLearnMoreLink(snapshot?.device.platform === "ios" ? "https://docs.openclaw.ai/platforms/ios" : "https://docs.openclaw.ai/platforms/macos")}`,
      })}
      ${renderSettingsWorkspace(renderSettingsPage(body))}
    `;
  }
}

if (!customElements.get("openclaw-device-page")) {
  customElements.define("openclaw-device-page", DevicePage);
}
