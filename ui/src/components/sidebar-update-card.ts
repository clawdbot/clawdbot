import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type { UpdateAvailable } from "../api/types.ts";
import {
  hasNativeUpdateBridge,
  NATIVE_UPDATE_AVAILABILITY_CHANGED_EVENT,
  NATIVE_UPDATE_DECLINED_EVENT,
  postNativeUpdate,
} from "../app/native-link-routing.ts";
import { t } from "../i18n/index.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { getSafeLocalStorage } from "../local-storage.ts";
import { icons } from "./icons.ts";

const UPDATE_BANNER_DISMISS_KEY = "openclaw:control-ui:update-banner-dismissed:v1";

type DismissedUpdate = {
  latestVersion: string;
  channel: string | null;
  dismissedAtMs: number;
};

function updateKey(update: UpdateAvailable): string {
  return `${update.latestVersion}\u0000${update.channel}`;
}

function isDismissed(update: UpdateAvailable): boolean {
  try {
    const raw = getSafeLocalStorage()?.getItem(UPDATE_BANNER_DISMISS_KEY);
    if (!raw) {
      return false;
    }
    const dismissed = JSON.parse(raw) as Partial<DismissedUpdate>;
    return dismissed.latestVersion === update.latestVersion && dismissed.channel === update.channel;
  } catch {
    return false;
  }
}

function dismiss(update: UpdateAvailable): void {
  try {
    getSafeLocalStorage()?.setItem(
      UPDATE_BANNER_DISMISS_KEY,
      JSON.stringify({
        latestVersion: update.latestVersion,
        channel: update.channel,
        dismissedAtMs: Date.now(),
      } satisfies DismissedUpdate),
    );
  } catch {
    // Dismissal persistence is best effort.
  }
}

class SidebarUpdateCard extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) updateAvailable: UpdateAvailable | null = null;
  @property({ attribute: false }) updateRunning = false;
  @property({ attribute: false }) onUpdate: () => void = () => undefined;
  @state() private dismissedUpdateKey: string | null = null;
  @state() private nativeUpdateAvailable = hasNativeUpdateBridge();
  private nativeUpdateDeclined = false;

  private readonly handleNativeUpdateAvailabilityChanged = () => {
    this.nativeUpdateDeclined = false;
    this.nativeUpdateAvailable = hasNativeUpdateBridge();
  };

  private readonly handleNativeUpdateDeclined = () => {
    this.nativeUpdateDeclined = true;
    this.nativeUpdateAvailable = false;
    if (this.updateAvailable && !this.updateRunning) {
      this.onUpdate();
    }
  };

  override connectedCallback() {
    super.connectedCallback();
    this.nativeUpdateAvailable = !this.nativeUpdateDeclined && hasNativeUpdateBridge();
    window.addEventListener(
      NATIVE_UPDATE_AVAILABILITY_CHANGED_EVENT,
      this.handleNativeUpdateAvailabilityChanged,
    );
    window.addEventListener(NATIVE_UPDATE_DECLINED_EVENT, this.handleNativeUpdateDeclined);
  }

  override disconnectedCallback() {
    window.removeEventListener(
      NATIVE_UPDATE_AVAILABILITY_CHANGED_EVENT,
      this.handleNativeUpdateAvailabilityChanged,
    );
    window.removeEventListener(NATIVE_UPDATE_DECLINED_EVENT, this.handleNativeUpdateDeclined);
    super.disconnectedCallback();
  }

  override render() {
    const update = this.updateAvailable;
    if (
      !update ||
      update.latestVersion === update.currentVersion ||
      this.dismissedUpdateKey === updateKey(update) ||
      isDismissed(update)
    ) {
      return nothing;
    }
    const title = this.updateRunning
      ? t("chat.updating")
      : this.nativeUpdateAvailable
        ? t("chat.sidebar.updateMacAndGateway")
        : t("chat.sidebar.updateGateway");
    return html`
      <div class="sidebar-update-card" role="status" aria-live="polite">
        <button
          class="sidebar-update-card__action"
          type="button"
          ?disabled=${this.updateRunning}
          @click=${() => {
            if (this.nativeUpdateDeclined || !postNativeUpdate()) {
              this.onUpdate();
            }
          }}
        >
          <span class="sidebar-update-card__icon" aria-hidden="true">${icons.download}</span>
          <span class="sidebar-update-card__copy">
            <span class="sidebar-update-card__title">${title}</span>
            <span class="sidebar-update-card__subtitle">v${update.latestVersion}</span>
          </span>
          <span class="sidebar-update-card__arrow" aria-hidden="true">${icons.chevronRight}</span>
        </button>
        <button
          class="sidebar-update-card__dismiss"
          type="button"
          aria-label=${t("chat.dismissUpdateBanner")}
          @click=${() => {
            this.dismissedUpdateKey = updateKey(update);
            dismiss(update);
          }}
        >
          ${icons.x}
        </button>
      </div>
    `;
  }
}

if (!customElements.get("openclaw-sidebar-update-card")) {
  customElements.define("openclaw-sidebar-update-card", SidebarUpdateCard);
}
