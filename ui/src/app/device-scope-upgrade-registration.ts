import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { icons } from "../components/icons.ts";
import "../components/modal-dialog.ts";
import "../components/web-awesome-popover.ts";
import { t } from "../i18n/index.ts";
import { formatUiError } from "../lib/format-error.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import {
  readScopeUpgradeAvailability,
  type ScopeUpgradeState,
} from "./device-scope-upgrade-availability.ts";
import {
  SCOPE_UPGRADE_DETAILS_EVENT,
  SCOPE_UPGRADE_TRIGGER_ID,
  renderScopeUpgradeTrigger,
} from "./device-scope-upgrade.ts";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";

type UpgradeOperation = {
  client: GatewayBrowserClient;
};

/** Owns the explicit live scope-upgrade action and its cross-route banner state. */
class ScopeUpgradeController {
  private current: ApplicationGatewaySnapshot;
  private operation: UpgradeOperation | null = null;
  private value: ScopeUpgradeState = { phase: "hidden" };

  constructor(
    initial: ApplicationGatewaySnapshot,
    private readonly onChange: () => void,
  ) {
    this.current = initial;
    this.sync(initial);
  }

  get state(): ScopeUpgradeState {
    return this.value;
  }

  sync(snapshot: ApplicationGatewaySnapshot): void {
    this.current = snapshot;
    const client = snapshot.client;
    const availability = readScopeUpgradeAvailability(snapshot);
    if (!client || availability.phase !== "available") {
      this.retireOperation();
      this.setState(availability);
      return;
    }
    if (this.operation && this.operation.client !== client) {
      this.retireOperation();
      this.setState({ phase: "available" });
    }
    if (this.value.phase === "hidden" || this.value.phase === "guidance") {
      this.setState({ phase: "available" });
    }
  }

  request(): void {
    this.start(false);
  }

  retry(): void {
    this.start(true);
  }

  cancel(): void {
    this.retireOperation();
    this.setState(readScopeUpgradeAvailability(this.current));
  }

  dispose(): void {
    this.retireOperation();
  }

  private start(retry: boolean): void {
    const client = this.current.client;
    if (!client || readScopeUpgradeAvailability(this.current).phase !== "available") {
      return;
    }
    if (this.operation) {
      if (!retry) {
        return;
      }
      this.retireOperation();
    }
    const operation = { client };
    this.operation = operation;
    this.setState({ phase: "requesting" });
    void client
      .requestScopeUpgrade({
        onPending: (requestId) => {
          if (this.isCurrent(operation)) {
            this.setState({ phase: "pending", requestId });
          }
        },
      })
      .then((result) => {
        if (!this.isCurrent(operation) || result.status === "approved") {
          return;
        }
        this.setState({
          phase: "rejected",
          requestId: result.requestId,
          expired: result.status === "expired",
        });
      })
      .catch((error: unknown) => {
        if (!this.isCurrent(operation) || (error instanceof Error && error.name === "AbortError")) {
          return;
        }
        this.setState({ phase: "error", message: formatUiError(error) });
      })
      .finally(() => {
        if (this.isCurrent(operation)) {
          this.operation = null;
        }
      });
  }

  private isCurrent(operation: UpgradeOperation): boolean {
    return this.operation === operation && this.current.client === operation.client;
  }

  private retireOperation(): void {
    const operation = this.operation;
    this.operation = null;
    operation?.client.cancelScopeUpgrade();
  }

  private setState(next: ScopeUpgradeState): void {
    if (JSON.stringify(this.value) === JSON.stringify(next)) {
      return;
    }
    this.value = next;
    this.onChange();
  }
}

type ScopeUpgradeSurfaceProps = {
  snapshot: ApplicationGatewaySnapshot;
  mobile: boolean;
  showTrigger: boolean;
};

class ScopeUpgradeSurface extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) props?: ScopeUpgradeSurfaceProps;
  private controller?: ScopeUpgradeController;
  private detailsOpen = false;
  private popoverClosing = false;
  private reopenAfterClose = false;

  private readonly showDetails = () => {
    this.removeAttribute("data-open-requested");
    if (!this.props?.mobile && this.popoverClosing) {
      this.reopenAfterClose = true;
      return;
    }
    void this.openDetails();
  };

  private async openDetails(): Promise<void> {
    if (!this.props?.mobile) {
      await this.ensureDetailsPopoverAnchored();
    }
    this.detailsOpen = true;
    this.requestUpdate();
  }

  private async ensureDetailsPopoverAnchored(): Promise<void> {
    const popover = this.querySelector<
      HTMLElement & { anchor?: Element | null; for?: string; updateComplete?: Promise<unknown> }
    >("wa-popover.scope-upgrade-details-popover");
    if (!popover || popover.anchor?.isConnected) {
      return;
    }
    // wa-popover resolves `for` only when the property changes and never
    // re-resolves a missing or replaced anchor. The trigger with this id can
    // render after the popover's first update (the header trigger ships with
    // the lazy chat chunk), which would leave the opened popover permanently
    // invisible. Re-arm the watcher so it re-runs the id lookup now.
    popover.for = "";
    await popover.updateComplete;
    popover.for = SCOPE_UPGRADE_TRIGGER_ID;
    await popover.updateComplete;
  }

  private readonly showDetailsFromTrigger = (event: Event) => {
    if (!this.props?.mobile) {
      event.stopImmediatePropagation();
    }
    this.showDetails();
  };

  private readonly hideDetails = () => {
    if (!this.props?.mobile) {
      this.popoverClosing = true;
    }
    this.detailsOpen = false;
    this.requestUpdate();
  };

  private readonly finishPopoverClose = () => {
    this.popoverClosing = false;
    if (this.reopenAfterClose) {
      this.reopenAfterClose = false;
      this.showDetails();
    }
  };

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener(SCOPE_UPGRADE_DETAILS_EVENT, this.showDetails);
    if (this.hasAttribute("data-open-requested")) {
      this.showDetails();
    }
  }

  protected override updated(): void {
    const snapshot = this.props?.snapshot;
    if (!snapshot) {
      return;
    }
    if (this.controller) {
      this.controller.sync(snapshot);
    } else {
      this.controller = new ScopeUpgradeController(snapshot, () => this.requestUpdate());
      this.requestUpdate();
    }
  }

  override disconnectedCallback(): void {
    window.removeEventListener(SCOPE_UPGRADE_DETAILS_EVENT, this.showDetails);
    this.controller?.dispose();
    this.controller = undefined;
    super.disconnectedCallback();
  }

  override render() {
    const props = this.props;
    const state =
      this.controller?.state ??
      (props ? readScopeUpgradeAvailability(props.snapshot) : { phase: "hidden" as const });
    if (!props || state.phase === "hidden") {
      return nothing;
    }
    const retryable =
      state.phase === "pending" || state.phase === "rejected" || state.phase === "error";
    const text =
      state.phase === "guidance"
        ? t("connection.scopeUpgrade.guidance")
        : state.phase === "available"
          ? t("connection.scopeUpgrade.limited")
          : state.phase === "requesting"
            ? t("connection.scopeUpgrade.requesting")
            : state.phase === "pending"
              ? t("connection.scopeUpgrade.pending")
              : state.phase === "rejected"
                ? t(
                    state.expired
                      ? "connection.scopeUpgrade.expired"
                      : "connection.scopeUpgrade.rejected",
                  )
                : t("connection.scopeUpgrade.error", { error: state.message });
    const details = html`<div
      class="callout ${state.phase === "error" || state.phase === "rejected"
        ? "danger"
        : "warn"} callout--action callout--dismissible scope-upgrade-details"
      role="status"
      aria-live="polite"
    >
      <span class="callout__content">${text}</span>
      ${state.phase === "available"
        ? html`<button
            class="btn btn--sm btn--primary"
            type="button"
            @click=${() => this.controller?.request()}
          >
            ${t("connection.scopeUpgrade.request")}
          </button>`
        : state.phase === "requesting"
          ? html`<button class="btn btn--sm btn--primary" type="button" disabled>
              ${t("connection.scopeUpgrade.requestingAction")}
            </button>`
          : retryable
            ? html`
                <button
                  class="btn btn--sm btn--primary"
                  type="button"
                  @click=${() => this.controller?.retry()}
                >
                  ${t("connection.scopeUpgrade.retry")}
                </button>
                <button class="btn btn--sm" type="button" @click=${() => this.controller?.cancel()}>
                  ${t("connection.scopeUpgrade.cancel")}
                </button>
              `
            : nothing}
      <button
        class="callout__dismiss"
        type="button"
        aria-label=${t("connection.scopeUpgrade.closeDetails")}
        @click=${this.hideDetails}
      >
        ${icons.x}
      </button>
    </div>`;
    const trigger = props.showTrigger
      ? renderScopeUpgradeTrigger(
          "shell-chrome-controls__button scope-upgrade-shell-status scope-upgrade-status-trigger",
          this.showDetailsFromTrigger,
        )
      : nothing;
    if (props.mobile) {
      return html`${trigger}${this.detailsOpen
        ? html`<openclaw-modal-dialog
            class="scope-upgrade-details-dialog"
            label=${t("connection.scopeUpgrade.status")}
            description=${text}
            @modal-cancel=${this.hideDetails}
          >
            ${details}
          </openclaw-modal-dialog>`
        : nothing}`;
    }
    return html`${trigger}<wa-popover
        class="scope-upgrade-details-popover"
        for=${SCOPE_UPGRADE_TRIGGER_ID}
        placement="bottom-start"
        without-arrow
        .open=${this.detailsOpen}
        @wa-show=${this.showDetails}
        @wa-hide=${this.hideDetails}
        @wa-after-hide=${this.finishPopoverClose}
      >
        ${details}
      </wa-popover>`;
  }
}

if (!customElements.get("openclaw-device-scope-upgrade-banner")) {
  customElements.define("openclaw-device-scope-upgrade-banner", ScopeUpgradeSurface);
}
