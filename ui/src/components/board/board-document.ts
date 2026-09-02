import { GATEWAY_SERVER_CAPS, type BoardSnapshot } from "@openclaw/gateway-protocol";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { hasOperatorApprovalsAccess, hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import {
  acquireBoardProviderForSession,
  hasLoadedBoardSnapshot,
  type BoardProvider,
  type BoardProviderLease,
} from "../../lib/board/provider.ts";
import type { BoardViewCallbacks } from "../../lib/board/view-types.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  isGatewayCapabilityAdvertised,
  isGatewayMethodAdvertised,
} from "../../lib/gateway-methods.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import "../../styles/board-document.css";
import "./board-view.ts";

type DashboardDocumentState =
  | "loading"
  | "ready"
  | "missing-session"
  | "not-found"
  | "unavailable"
  | "error";

type ProviderBinding = {
  client: NonNullable<ApplicationGatewaySnapshot["client"]>;
  sessionKey: string;
  capabilityKey: string;
};

export class OpenClawBoardDocument extends OpenClawLightDomElement {
  @property({ attribute: false }) gatewaySnapshot?: ApplicationGatewaySnapshot;
  @property({ attribute: false }) sessionKey: string | null = null;
  @property({ attribute: false }) onDocumentClose: (() => void) | null = null;

  @state() private documentState: DashboardDocumentState = "loading";
  @state() private snapshot?: BoardSnapshot;
  @state() private activeTabId = "";
  @state() private errorText = "";

  private provider: BoardProvider | null = null;
  private providerLease: BoardProviderLease | null = null;
  private binding: ProviderBinding | null = null;
  private unsubscribeSnapshot: (() => void) | null = null;
  private unsubscribeLoadError: (() => void) | null = null;
  private unsubscribeEvents: (() => void) | null = null;
  private bindingGeneration = 0;

  override connectedCallback(): void {
    super.connectedCallback();
    // Reattaching unchanged properties must reacquire the released binding.
    this.requestUpdate("gatewaySnapshot");
  }

  override disconnectedCallback(): void {
    this.releaseProvider();
    super.disconnectedCallback();
  }

  override updated(changed: PropertyValues<this>): void {
    if (changed.has("sessionKey") || changed.has("gatewaySnapshot")) {
      this.synchronizeProvider();
    }
  }

  private providerCapabilities(snapshot: ApplicationGatewaySnapshot): {
    canPinWidgets: boolean;
    canPinMcpApps: boolean;
    canMutate: boolean;
    canGrant: boolean;
  } {
    const canMutate = hasOperatorWriteAccess(snapshot.hello?.auth ?? null);
    return {
      canMutate,
      canGrant: hasOperatorApprovalsAccess(snapshot.hello?.auth ?? null),
      canPinWidgets:
        canMutate &&
        isGatewayCapabilityAdvertised(snapshot, GATEWAY_SERVER_CAPS.BOARD_WIDGET_PUT_CANVAS_DOC) ===
          true,
      canPinMcpApps:
        canMutate &&
        isGatewayMethodAdvertised(snapshot, "board.widget.appView") === true &&
        isGatewayMethodAdvertised(snapshot, "board.widget.put") === true,
    };
  }

  private synchronizeProvider(): void {
    if (!this.isConnected) {
      return;
    }
    const sessionKey = this.sessionKey?.trim() ?? "";
    if (!sessionKey) {
      this.releaseProvider();
      this.documentState = "missing-session";
      return;
    }
    const snapshot = this.gatewaySnapshot;
    const client = snapshot?.client;
    if (!snapshot || !client) {
      this.releaseProvider();
      this.documentState = "loading";
      return;
    }
    if (isGatewayMethodAdvertised(snapshot, "board.get") === false) {
      this.releaseProvider();
      this.documentState = "unavailable";
      return;
    }
    const capabilities = this.providerCapabilities(snapshot);
    const capabilityKey = JSON.stringify(capabilities);
    if (
      this.binding?.client === client &&
      this.binding.sessionKey === sessionKey &&
      this.binding.capabilityKey === capabilityKey
    ) {
      this.providerLease?.update(client, snapshot.phase === "connected", capabilities);
      return;
    }
    this.releaseProvider();
    this.documentState = "loading";
    const generation = this.bindingGeneration;
    void this.bindProvider({ client, sessionKey, capabilityKey }, capabilities, generation);
  }

  private async bindProvider(
    binding: ProviderBinding,
    capabilities: ReturnType<OpenClawBoardDocument["providerCapabilities"]>,
    generation: number,
  ): Promise<void> {
    try {
      const described = await binding.client.request<{ session?: GatewaySessionRow | null }>(
        "sessions.describe",
        { key: binding.sessionKey },
      );
      if (generation !== this.bindingGeneration) {
        return;
      }
      if (!described.session) {
        this.documentState = "not-found";
        return;
      }
      const current = this.gatewaySnapshot;
      if (!current || current.client !== binding.client) {
        return;
      }
      const lease = acquireBoardProviderForSession(
        { sessionKey: described.session.key, agentId: described.session.agentId },
        binding.client,
        current.phase === "connected",
        capabilities.canPinWidgets,
        capabilities.canPinMcpApps,
        capabilities.canMutate,
        capabilities.canGrant,
      );
      const provider = lease.provider;
      this.provider = provider;
      this.providerLease = lease;
      this.binding = binding;
      this.unsubscribeSnapshot = provider.snapshot$.subscribe(() =>
        this.reconcileProvider(provider),
      );
      this.unsubscribeLoadError = provider.loadError$.subscribe(() =>
        this.reconcileProvider(provider),
      );
      this.unsubscribeEvents = provider.events.subscribe((event) => {
        const command = event.command;
        if (command.kind !== "focus_tab") {
          return;
        }
        if (provider.snapshot$.value.tabs.some((tab) => tab.tabId === command.tabId)) {
          this.activeTabId = command.tabId;
        }
      });
      this.reconcileProvider(provider);
    } catch (error) {
      if (generation === this.bindingGeneration) {
        this.errorText = formatUiError(error);
        this.documentState = "error";
      }
    }
  }

  private selectAvailableTab(): void {
    const snapshot = this.snapshot;
    if (!snapshot) {
      return;
    }
    if (snapshot.tabs.some((tab) => tab.tabId === this.activeTabId)) {
      return;
    }
    this.activeTabId = snapshot.tabs[0]?.tabId ?? snapshot.widgets[0]?.tabId ?? "";
  }

  private reconcileProvider(provider: BoardProvider): void {
    if (this.provider !== provider) {
      return;
    }
    if (hasLoadedBoardSnapshot(provider)) {
      this.snapshot = provider.snapshot$.value;
      this.selectAvailableTab();
      this.documentState = "ready";
      return;
    }
    const loadError = provider.loadError$.value;
    if (loadError) {
      this.errorText = loadError;
      this.documentState = "error";
    } else {
      this.errorText = "";
      this.documentState = "loading";
    }
  }

  private releaseProvider(): void {
    this.bindingGeneration += 1;
    this.unsubscribeSnapshot?.();
    this.unsubscribeLoadError?.();
    this.unsubscribeEvents?.();
    this.unsubscribeSnapshot = null;
    this.unsubscribeLoadError = null;
    this.unsubscribeEvents = null;
    this.providerLease?.release();
    this.provider = null;
    this.providerLease = null;
    this.binding = null;
    this.snapshot = undefined;
    this.activeTabId = "";
    this.errorText = "";
  }

  private renderState() {
    if (this.documentState === "loading") {
      return html`<div class="board-document__state" role="status" aria-live="polite">
        ${t("common.loading")}
      </div>`;
    }
    if (this.documentState === "missing-session") {
      return html`<div class="board-document__state" role="status">
        ${t("dashboardDocument.missingSession")}
      </div>`;
    }
    if (this.documentState === "not-found") {
      return html`<div class="board-document__state" role="status">
        ${t("dashboardDocument.notFound")}
      </div>`;
    }
    if (this.documentState === "unavailable") {
      return html`<div class="board-document__state" role="status">
        ${t("dashboardDocument.unavailable")}
      </div>`;
    }
    if (this.documentState === "error") {
      return html`<div class="board-document__state board-document__state--error" role="alert">
        ${t("dashboardDocument.loadFailed", { error: this.errorText })}
      </div>`;
    }
    const provider = this.provider;
    const snapshot = this.snapshot;
    if (!provider || !snapshot) {
      return nothing;
    }
    const callbacks = {
      appViewGeneration: provider.appViewGeneration,
      applyOps: (ops) => provider.applyOps(ops),
      grant: (name, decision) => provider.grant(name, decision),
      selectTab: (tabId) => {
        this.activeTabId = tabId;
      },
      frameLoadFailed: (name) => provider.refreshWidgetFrame(name),
      widgetAppView: (name, revision) => provider.widgetAppView(name, revision),
      refreshWidgetAppView: (name, revision) => provider.refreshWidgetAppView(name, revision),
    } satisfies BoardViewCallbacks;
    return html`<openclaw-board-view
      .active=${true}
      .snapshot=${snapshot}
      .activeTabId=${this.activeTabId}
      .widgetFrameUrl=${(name: string, revision: number) => provider.widgetFrameUrl(name, revision)}
      .callbacks=${callbacks}
      .canMutate=${provider.canMutate}
      .canGrant=${provider.canGrant}
    ></openclaw-board-view>`;
  }

  override render() {
    return html`
      <main class="board-document" aria-label=${t("board.label")}>
        <button
          class="btn btn--ghost btn--icon board-document__close"
          type="button"
          aria-label=${t("dashboardDocument.close")}
          title=${t("dashboardDocument.close")}
          @click=${() => this.onDocumentClose?.()}
        >
          ${icons.x}
        </button>
        <div class="board-document__content">${this.renderState()}</div>
      </main>
    `;
  }
}

if (!customElements.get("openclaw-board-document")) {
  customElements.define("openclaw-board-document", OpenClawBoardDocument);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-board-document": OpenClawBoardDocument;
  }
}
