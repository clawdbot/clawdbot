// Control UI component renders update status and available-update actions.
import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import type { UpdateAvailable } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { getSafeLocalStorage } from "../local-storage.ts";
import { icons } from "./icons.ts";

const UPDATE_BANNER_DISMISS_KEY = "openclaw:control-ui:update-banner-dismissed:v1";

type DismissedUpdateBanner = {
  latestVersion: string;
  channel: string | null;
  dismissedAtMs: number;
};

function loadDismissedUpdateBanner(): DismissedUpdateBanner | null {
  try {
    const raw = getSafeLocalStorage()?.getItem(UPDATE_BANNER_DISMISS_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<DismissedUpdateBanner>;
    if (!parsed || typeof parsed.latestVersion !== "string") {
      return null;
    }
    return {
      latestVersion: parsed.latestVersion,
      channel: typeof parsed.channel === "string" ? parsed.channel : null,
      dismissedAtMs: typeof parsed.dismissedAtMs === "number" ? parsed.dismissedAtMs : Date.now(),
    };
  } catch {
    return null;
  }
}

function isDismissed(updateAvailable: UpdateAvailable): boolean {
  const dismissed = loadDismissedUpdateBanner();
  return Boolean(
    dismissed &&
    dismissed.latestVersion === updateAvailable.latestVersion &&
    dismissed.channel === updateAvailable.channel,
  );
}

function dismiss(updateAvailable: UpdateAvailable) {
  try {
    getSafeLocalStorage()?.setItem(
      UPDATE_BANNER_DISMISS_KEY,
      JSON.stringify({
        latestVersion: updateAvailable.latestVersion,
        channel: updateAvailable.channel,
        dismissedAtMs: Date.now(),
      } satisfies DismissedUpdateBanner),
    );
  } catch {
    // Best effort only; dismissing the banner is not a product failure.
  }
}

type UpdateBannerProps = {
  statusBanner: { tone: "danger" | "warn" | "info"; text: string } | null;
  updateAvailable: UpdateAvailable | null;
  updateRunning: boolean;
  connected: boolean;
  onUpdate: () => void | Promise<void>;
  onDismiss: () => void;
};

class UpdateBanner extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) props?: UpdateBannerProps;

  override render() {
    const props = this.props;
    if (!props) {
      return nothing;
    }
    const updateAvailable = props.updateAvailable;
    return html`
      ${props.statusBanner
        ? html`<div class="callout ${props.statusBanner.tone}" role="alert">
            ${props.statusBanner.text}
          </div>`
        : nothing}
      ${updateAvailable &&
      updateAvailable.latestVersion !== updateAvailable.currentVersion &&
      !isDismissed(updateAvailable)
        ? html`<div class="update-banner callout danger" role="alert">
            <strong>${t("chat.updateAvailable")}</strong> v${updateAvailable.latestVersion}
            (${t("chat.runningVersion", { version: updateAvailable.currentVersion })}).
            <button
              class="btn btn--sm update-banner__btn"
              ?disabled=${props.updateRunning || !props.connected}
              @click=${() => props.onUpdate()}
            >
              ${props.updateRunning ? t("chat.updating") : t("chat.updateNow")}
            </button>
            <openclaw-tooltip .content=${t("common.dismiss")}>
              <button
                class="update-banner__close"
                type="button"
                aria-label=${t("chat.dismissUpdateBanner")}
                @click=${() => {
                  dismiss(updateAvailable);
                  props.onDismiss();
                }}
              >
                ${icons.x}
              </button>
            </openclaw-tooltip>
          </div>`
        : nothing}
    `;
  }
}

if (!customElements.get("openclaw-update-banner")) {
  customElements.define("openclaw-update-banner", UpdateBanner);
}
