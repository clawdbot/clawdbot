import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { UpdateAvailable, UpdateScheduleState } from "../api/types.ts";
import {
  hasNativeUpdateBridge,
  NATIVE_UPDATE_AVAILABILITY_CHANGED_EVENT,
  NATIVE_UPDATE_DECLINED_EVENT,
  postNativeUpdate,
} from "../app/native-link-routing.ts";
import {
  formatUpdateCampaignLabel,
  formatUpdateTargetLabel,
} from "../app/update-overlay-helpers.ts";
import { t } from "../i18n/index.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { PollController } from "../lit/poll-controller.ts";
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
  @property({ attribute: false }) updateSchedule: UpdateScheduleState | null = null;
  @property({ attribute: false }) heldUpdateCampaignId: string | null = null;
  @property({ attribute: false }) updateRunning = false;
  @property({ attribute: false }) canUpdate = false;
  @property({ attribute: false }) canHoldUpdate = false;
  @property({ attribute: false }) onUpdate: () => void = () => undefined;
  @property({ attribute: false }) refreshRequired = false;
  @property({ attribute: false }) onRefresh: () => void = () => undefined;
  @property({ attribute: false }) onHoldUpdate: () => Promise<boolean> = async () => false;
  @state() private dismissedUpdateKey: string | null = null;
  @state() private holdingCampaignId: string | null = null;
  @state() private nativeUpdateAvailable = hasNativeUpdateBridge();
  private nativeUpdateDeclined = false;
  private readonly countdownPolling = new PollController(
    this,
    1_000,
    () => this.requestUpdate(),
    false,
  );

  private readonly handleNativeUpdateAvailabilityChanged = () => {
    this.nativeUpdateDeclined = false;
    this.nativeUpdateAvailable = hasNativeUpdateBridge();
  };

  private readonly handleNativeUpdateDeclined = () => {
    this.nativeUpdateDeclined = true;
    this.nativeUpdateAvailable = false;
    if (
      (this.updateAvailable || this.updateSchedule?.campaign) &&
      !this.updateRunning &&
      this.canUpdate &&
      !this.refreshRequired
    ) {
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

  override updated(changed: PropertyValues<this>) {
    super.updated(changed);
    if (changed.has("updateSchedule")) {
      const campaignState = this.updateSchedule?.campaign?.state;
      if (campaignState === "countdown" || campaignState === "waiting-for-idle") {
        this.countdownPolling.start();
      } else {
        this.countdownPolling.stop();
      }
    }
  }

  override render() {
    // A stale client cannot trust its own update metadata, so refresh takes precedence
    // over any available update it may still report.
    if (this.refreshRequired) {
      return html`
        <div class="sidebar-update-card" role="status" aria-live="polite">
          <button class="sidebar-update-card__action" type="button" @click=${this.onRefresh}>
            <span class="sidebar-update-card__icon" aria-hidden="true">${icons.refresh}</span>
            <span class="sidebar-update-card__text sidebar-update-card__text--stacked">
              <span class="sidebar-update-card__title"
                >${t("chat.sidebar.serverUpdatedTitle")}</span
              >
              <span class="sidebar-update-card__subtitle"
                >${t("chat.sidebar.serverUpdatedRefresh")}</span
              >
            </span>
          </button>
        </div>
      `;
    }
    const update = this.updateAvailable;
    const campaign = this.updateSchedule?.campaign;
    const hasGitUpdate =
      this.updateSchedule?.target?.kind === "git" && this.updateSchedule.target.commitsBehind > 0;
    const hasVersionUpdate = Boolean(update && update.latestVersion !== update.currentVersion);
    if (
      !campaign &&
      (!update ||
        (!hasVersionUpdate && !hasGitUpdate) ||
        this.dismissedUpdateKey === updateKey(update) ||
        isDismissed(update))
    ) {
      return nothing;
    }
    const title = this.updateRunning
      ? t("chat.updating")
      : this.nativeUpdateAvailable
        ? t("chat.sidebar.updateMacAndGateway")
        : t("chat.sidebar.updateGateway");
    const betaChannelSuffix = update?.channel === "beta" ? " (beta)" : "";
    const campaignLabel = formatUpdateCampaignLabel(this.updateSchedule);
    const targetLabel = formatUpdateTargetLabel(this.updateSchedule, update);
    const text = campaignLabel
      ? targetLabel
        ? t("updates.sidebar.campaignTarget", { status: campaignLabel, target: targetLabel })
        : campaignLabel
      : targetLabel
        ? `${title} · ${targetLabel}${betaChannelSuffix}`
        : title;
    const busy = this.updateRunning || campaign?.state === "applying";
    const countdownActive =
      campaign?.state === "countdown" || campaign?.state === "waiting-for-idle";
    const holdActive = campaign?.holdUntilMs !== undefined && campaign.holdUntilMs > Date.now();
    const showHold = Boolean(
      campaign &&
      campaign.state !== "applying" &&
      this.canUpdate &&
      this.canHoldUpdate &&
      !busy &&
      !holdActive &&
      this.heldUpdateCampaignId !== campaign.id,
    );
    return html`
      <div
        class="sidebar-update-card"
        role=${campaign ? nothing : "status"}
        aria-live=${campaign ? nothing : "polite"}
      >
        <div class="sidebar-update-card__actions">
          <button
            class="sidebar-update-card__action ${campaign
              ? "sidebar-update-card__action--undismissable"
              : ""} ${busy ? "sidebar-update-card__action--busy" : ""}"
            type="button"
            title=${this.canUpdate ? nothing : t("updates.adminRequired")}
            ?disabled=${busy || !this.canUpdate}
            @click=${() => {
              if (busy || !this.canUpdate) {
                return;
              }
              if (this.nativeUpdateDeclined || !postNativeUpdate()) {
                this.onUpdate();
              }
            }}
          >
            <span class="sidebar-update-card__icon" aria-hidden="true">${icons.download}</span>
            <span
              class="sidebar-update-card__text"
              role=${countdownActive ? "timer" : nothing}
              aria-live=${countdownActive ? "off" : nothing}
              >${text}</span
            >
          </button>
          ${showHold && campaign
            ? html`
                <button
                  class="sidebar-update-card__hold"
                  type="button"
                  ?disabled=${this.holdingCampaignId === campaign.id}
                  @click=${async () => {
                    this.holdingCampaignId = campaign.id;
                    await this.onHoldUpdate();
                    this.holdingCampaignId = null;
                  }}
                >
                  ${t("updates.holdOneHour")}
                </button>
              `
            : nothing}
        </div>
        ${campaign || !update
          ? nothing
          : html`
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
            `}
      </div>
    `;
  }
}

if (!customElements.get("openclaw-sidebar-update-card")) {
  customElements.define("openclaw-sidebar-update-card", SidebarUpdateCard);
}
