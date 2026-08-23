import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { UpdateAvailable, UpdateScheduleState } from "../api/types.ts";
import {
  hasNativeUpdateBridge,
  NATIVE_UPDATE_AVAILABILITY_CHANGED_EVENT,
  NATIVE_UPDATE_DECLINED_EVENT,
} from "../app/native-link-routing.ts";
import { confirmAndStartUpdate, type UpdateProgress } from "../app/update-confirmation.ts";
import {
  formatUpdateCampaignLabel,
  formatUpdateTargetLabel,
  type ApplicationStatusBanner,
} from "../app/update-overlay-helpers.ts";
import { t } from "../i18n/index.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { PollController } from "../lit/poll-controller.ts";
import "../styles/sidebar-update-card.css";
import { icons } from "./icons.ts";

class SidebarUpdateCard extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) compact = false;
  @property({ attribute: false }) updateAvailable: UpdateAvailable | null = null;
  @property({ attribute: false }) updateSchedule: UpdateScheduleState | null = null;
  @property({ attribute: false }) heldUpdateCampaignId: string | null = null;
  @property({ attribute: false }) updateBusy = false;
  @property({ attribute: false }) statusBanner: ApplicationStatusBanner | null = null;
  @property({ attribute: false }) watchUpdateProgress:
    | ((listener: (progress: UpdateProgress) => void) => () => void)
    | undefined = undefined;
  @property({ attribute: false }) canUpdate = false;
  @property({ attribute: false }) canHoldUpdate = false;
  @property({ attribute: false }) onUpdate: () => void = () => undefined;
  @property({ attribute: false }) refreshRequired = false;
  @property({ attribute: false }) onRefresh: () => void = () => undefined;
  @property({ attribute: false }) onHoldUpdate: () => Promise<boolean> = async () => false;
  @property({ attribute: false }) onReviewUpdate: () => void = () => undefined;
  @property({ attribute: false }) onDismiss: (() => void) | undefined = undefined;
  @property({ attribute: false }) recoverNativeDecline = true;
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

  // The Mac app only declines an update it was already handed, so this is the
  // tail of a confirmed click. Re-confirming here would ask twice for one action.
  private readonly handleNativeUpdateDeclined = () => {
    this.nativeUpdateDeclined = true;
    this.nativeUpdateAvailable = false;
    if (
      (this.updateAvailable || this.updateSchedule?.campaign) &&
      !this.updateBusy &&
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
    if (this.recoverNativeDecline) {
      window.addEventListener(NATIVE_UPDATE_DECLINED_EVENT, this.handleNativeUpdateDeclined);
    }
  }

  override disconnectedCallback() {
    window.removeEventListener(
      NATIVE_UPDATE_AVAILABILITY_CHANGED_EVENT,
      this.handleNativeUpdateAvailabilityChanged,
    );
    if (this.recoverNativeDecline) {
      window.removeEventListener(NATIVE_UPDATE_DECLINED_EVENT, this.handleNativeUpdateDeclined);
    }
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

  private renderStatus() {
    const statusBanner = this.statusBanner;
    // The Gateway recorded this outcome; unlike the client's own update
    // metadata it stays true even when this client is stale.
    return statusBanner
      ? html`<div
          class="sidebar-update-card__status sidebar-update-card__status--${statusBanner.tone}"
          role="alert"
        >
          ${statusBanner.text}
        </div>`
      : nothing;
  }

  private readonly startUpdate = () => {
    const campaign = this.updateSchedule?.campaign;
    const busy = this.updateBusy || campaign?.state === "applying";
    if (busy || !this.canUpdate) {
      return;
    }
    void confirmAndStartUpdate({
      startGatewayUpdate: () => this.onUpdate(),
      ...(this.watchUpdateProgress ? { watchUpdateProgress: this.watchUpdateProgress } : {}),
      updateAvailable: this.updateAvailable,
      updateSchedule: this.updateSchedule,
      // Read the bridge at click time: a Mac app that installed it
      // after the last availability event still owns this update.
      viaNativeApp: !this.nativeUpdateDeclined && hasNativeUpdateBridge(),
    });
  };

  private readonly holdUpdate = async (campaignId: string) => {
    this.holdingCampaignId = campaignId;
    await this.onHoldUpdate();
    this.holdingCampaignId = null;
  };

  private compactSummary() {
    if (this.refreshRequired) {
      return {
        detail: t("chat.sidebar.serverUpdatedRefresh"),
        icon: icons.refresh,
        severity: "warning" as const,
        title: t("chat.sidebar.serverUpdatedTitle"),
      };
    }
    const campaign = this.updateSchedule?.campaign;
    const busy = this.updateBusy || campaign?.state === "applying";
    const statusBanner = this.statusBanner;
    if (!campaign && !busy && !statusBanner) {
      return null;
    }
    const targetLabel = formatUpdateTargetLabel(this.updateSchedule, this.updateAvailable);
    const campaignLabel = formatUpdateCampaignLabel(this.updateSchedule);
    const blocked = statusBanner && statusBanner.tone !== "info";
    const blockedReason = statusBanner?.text.trim() || t("updates.sidebar.blockedSummary");
    return {
      detail: blocked
        ? campaign?.state === "waiting-for-idle" && targetLabel
          ? t("updates.sidebar.blockedWaiting", { target: targetLabel })
          : targetLabel
            ? `${targetLabel} · ${blockedReason}`
            : blockedReason
        : campaignLabel && targetLabel
          ? t("updates.sidebar.campaignTarget", { status: campaignLabel, target: targetLabel })
          : (campaignLabel ??
            targetLabel ??
            statusBanner?.text ??
            t("updates.sidebar.availableSummary")),
      icon: statusBanner ? icons.alertTriangle : busy ? icons.refresh : icons.download,
      critical: Boolean(blocked),
      severity: statusBanner?.tone === "danger" ? ("error" as const) : ("warning" as const),
      title: blocked
        ? t("updates.sidebar.blockedTitle")
        : busy
          ? t("updates.sidebar.updating")
          : t("updates.sidebar.availableTitle"),
    };
  }

  private renderCompact() {
    const summary = this.compactSummary();
    if (!summary) {
      return nothing;
    }
    return html`<details
      class="sidebar-issues-panel__details sidebar-issues-panel__details--${summary.severity}"
    >
      <summary class="sidebar-issues-panel__summary" data-issue-row-focus>
        <span
          class="sidebar-issues-panel__icon ${summary.critical
            ? "sidebar-issues-panel__icon--critical"
            : ""}"
          aria-hidden="true"
          >${summary.icon}</span
        >
        <span class="sidebar-issues-panel__content">
          <span class="sidebar-issues-panel__entity" title=${summary.title}>${summary.title}</span>
          <span class="sidebar-issues-panel__state" title=${summary.detail}>${summary.detail}</span>
        </span>
        ${this.onDismiss
          ? html`<button
              type="button"
              class="sidebar-issues-panel__dismiss"
              aria-label=${t("attention.dismissItem", { item: summary.title })}
              title=${t("attention.dismissItem", { item: summary.title })}
              @click=${(event: Event) => {
                event.preventDefault();
                event.stopPropagation();
                this.onDismiss?.();
              }}
            >
              ${icons.x}
            </button>`
          : nothing}
        <span class="sidebar-issues-panel__chevron" aria-hidden="true">${icons.chevronRight}</span>
      </summary>
      <div class="sidebar-issues-panel__body sidebar-update-issue__body">
        ${this.renderCompactDetails()}
      </div>
    </details>`;
  }

  private renderCompactDetails() {
    const statusBanner = this.statusBanner;
    if (!statusBanner) {
      return this.renderCard();
    }
    const campaign = this.updateSchedule?.campaign;
    const holdActive = campaign?.holdUntilMs !== undefined && campaign.holdUntilMs > Date.now();
    const showHold = Boolean(
      campaign &&
      campaign.state !== "applying" &&
      this.canUpdate &&
      this.canHoldUpdate &&
      !this.updateBusy &&
      !holdActive &&
      this.heldUpdateCampaignId !== campaign.id,
    );
    return html`<div class="sidebar-update-card sidebar-update-card--compact-details">
      <p class="sidebar-update-card__compact-reason" title=${statusBanner.text}>
        ${statusBanner.text}
      </p>
      <div class="sidebar-update-card__compact-actions">
        <button
          class="sidebar-update-card__review sidebar-update-card__review--primary"
          type="button"
          @click=${this.onReviewUpdate}
        >
          ${t("updates.reviewUpdate")}
        </button>
        ${showHold && campaign
          ? html`<button
              class="sidebar-update-card__hold"
              type="button"
              ?disabled=${this.holdingCampaignId === campaign.id}
              @click=${() => this.holdUpdate(campaign.id)}
            >
              ${t("updates.holdOneHour")}
            </button>`
          : nothing}
      </div>
    </div>`;
  }

  private renderCard() {
    // A stale client cannot trust its own update metadata, so refresh takes precedence
    // over any available update it may still report.
    if (this.refreshRequired) {
      return html`
        <div class="sidebar-update-card" role="status" aria-live="polite">
          ${this.renderStatus()}
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
    const busy = this.updateBusy || campaign?.state === "applying";
    const hasGitUpdate =
      this.updateSchedule?.target?.kind === "git" && this.updateSchedule.target.commitsBehind > 0;
    const hasVersionUpdate = Boolean(update && update.latestVersion !== update.currentVersion);
    // A running update outranks availability: the gateway drops its update
    // metadata while it restarts, and the card must not vanish or fall back to
    // the stale "update available" call to action mid-install.
    const statusBanner = this.statusBanner;
    if (!campaign && !busy && !statusBanner) {
      return nothing;
    }
    const title = this.nativeUpdateAvailable
      ? t("chat.sidebar.updateMacAndGateway")
      : t("chat.sidebar.updateGateway");
    const betaChannelSuffix = update?.channel === "beta" ? " (beta)" : "";
    const campaignLabel = formatUpdateCampaignLabel(this.updateSchedule);
    const targetLabel = formatUpdateTargetLabel(this.updateSchedule, update);
    const text = campaignLabel
      ? targetLabel
        ? t("updates.sidebar.campaignTarget", { status: campaignLabel, target: targetLabel })
        : campaignLabel
      : busy
        ? t("updates.sidebar.updating")
        : targetLabel
          ? `${title} · ${targetLabel}${betaChannelSuffix}`
          : title;
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
    // An outcome with nothing left to act on is the whole card: re-offering an
    // update the operator just ran would bury the reason it failed.
    const actionable = Boolean(campaign || busy || (update && (hasVersionUpdate || hasGitUpdate)));
    return html`
      <div
        class="sidebar-update-card"
        role=${campaign ? nothing : "status"}
        aria-live=${campaign ? nothing : "polite"}
      >
        ${this.renderStatus()}
        ${actionable
          ? html`<div class="sidebar-update-card__actions">
              <button
                class="sidebar-update-card__action ${busy
                  ? "sidebar-update-card__action--busy"
                  : ""}"
                type="button"
                title=${this.canUpdate ? nothing : t("updates.adminRequired")}
                ?disabled=${busy || !this.canUpdate}
                @click=${this.startUpdate}
              >
                <span class="sidebar-update-card__icon" aria-hidden="true"
                  >${busy ? icons.refresh : icons.download}</span
                >
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
                      @click=${() => this.holdUpdate(campaign.id)}
                    >
                      ${t("updates.holdOneHour")}
                    </button>
                  `
                : nothing}
            </div>`
          : nothing}
        ${statusBanner
          ? html`<button
              class="sidebar-update-card__review"
              type="button"
              @click=${this.onReviewUpdate}
            >
              ${t("updates.reviewUpdate")}
            </button>`
          : nothing}
      </div>
    `;
  }

  override render() {
    return this.compact ? this.renderCompact() : this.renderCard();
  }
}

if (!customElements.get("openclaw-sidebar-update-card")) {
  customElements.define("openclaw-sidebar-update-card", SidebarUpdateCard);
}
