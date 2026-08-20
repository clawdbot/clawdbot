import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { icons } from "../components/icons.ts";
import { t } from "../i18n/index.ts";
import { formatUiError } from "../lib/format-error.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import {
  dismissScopeUpgradeBanner,
  hasDismissedScopeUpgradeBanner,
  readScopeUpgradeAvailability,
  type ScopeUpgradeState,
} from "./device-scope-upgrade.ts";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";

type UpgradeOperation = {
  client: GatewayBrowserClient;
};

/** Owns the explicit live scope-upgrade action and its cross-route banner state. */
export class ScopeUpgradeController {
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

type ScopeUpgradeBannerProps = {
  snapshot: ApplicationGatewaySnapshot;
};

class ScopeUpgradeBanner extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) props?: ScopeUpgradeBannerProps;
  private controller?: ScopeUpgradeController;
  private expanded = !hasDismissedScopeUpgradeBanner();

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
    this.controller?.dispose();
    this.controller = undefined;
    super.disconnectedCallback();
  }

  override render() {
    const props = this.props;
    const state =
      this.controller?.state ??
      (props ? readScopeUpgradeAvailability(props.snapshot) : { phase: "hidden" as const });
    if (
      !props ||
      state.phase === "hidden" ||
      (state.phase === "guidance" && hasDismissedScopeUpgradeBanner())
    ) {
      return nothing;
    }
    if (!this.expanded && state.phase === "guidance") {
      return nothing;
    }
    if (!this.expanded && state.phase === "available") {
      return html`<div class="scope-upgrade-chip-row">
        <button
          class="scope-upgrade-chip"
          type="button"
          aria-expanded="false"
          aria-label=${t("connection.scopeUpgrade.showDetails")}
          @click=${() => {
            this.expanded = true;
            this.requestUpdate();
          }}
        >
          <span class="scope-upgrade-chip__dot" aria-hidden="true"></span>
          ${t("connection.scopeUpgrade.status")}
        </button>
      </div>`;
    }
    const retryable =
      state.phase === "pending" || state.phase === "rejected" || state.phase === "error";
    const dismissible = state.phase === "available" || state.phase === "guidance";
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
    return html`<div
      class="callout ${state.phase === "error" || state.phase === "rejected"
        ? "danger"
        : "warn"} callout--action ${dismissible ? "callout--dismissible" : ""}"
      role="status"
    >
      <span class="callout__content">${text}</span>
      ${state.phase === "available"
        ? html`<button class="btn btn--sm" type="button" @click=${() => this.controller?.request()}>
            ${t("connection.scopeUpgrade.request")}
          </button>`
        : state.phase === "requesting"
          ? html`<button class="btn btn--sm" type="button" disabled>
              ${t("connection.scopeUpgrade.requestingAction")}
            </button>`
          : retryable
            ? html`
                <button class="btn btn--sm" type="button" @click=${() => this.controller?.retry()}>
                  ${t("connection.scopeUpgrade.retry")}
                </button>
                <button class="btn btn--sm" type="button" @click=${() => this.controller?.cancel()}>
                  ${t("connection.scopeUpgrade.cancel")}
                </button>
              `
            : nothing}
      ${dismissible
        ? html`<openclaw-tooltip .content=${t("connection.scopeUpgrade.dismiss")}>
            <button
              class="callout__dismiss"
              type="button"
              aria-label=${t("connection.scopeUpgrade.dismiss")}
              @click=${() => {
                dismissScopeUpgradeBanner();
                this.expanded = false;
                this.requestUpdate();
              }}
            >
              ${icons.x}
            </button>
          </openclaw-tooltip>`
        : nothing}
    </div>`;
  }
}

if (!customElements.get("openclaw-device-scope-upgrade-banner")) {
  customElements.define("openclaw-device-scope-upgrade-banner", ScopeUpgradeBanner);
}
